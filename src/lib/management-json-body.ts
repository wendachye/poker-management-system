/** Deliberately larger than the CSV cap: operations return compact snapshots,
 * while the separate prototype includes its fictional history in receipts.
 */
export const MAX_MANAGEMENT_JSON_BYTES = 16 * 1024 * 1024;
const SLAB_BYTES = 64 * 1024;

/** Read actual decoded response bytes before parsing. Raw reader/parse failures
 * remain internal; readManagementResponse supplies the safe receipt semantics.
 */
export async function readManagementJsonBody(
  response: Response,
  signal?: AbortSignal,
  checkStopped?: () => void,
): Promise<unknown> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let fullyRead = false;
  const cancelled = new WeakSet<object>();
  const release = () => {
    try {
      const source = reader ?? response.body;
      if (source && !fullyRead && !cancelled.has(source)) {
        cancelled.add(source);
        void source.cancel().catch(() => {});
      }
    } catch {}
    try {
      reader?.releaseLock();
    } catch {}
  };
  const check = () => {
    signal?.throwIfAborted();
    checkStopped?.();
  };
  const onAbort = () => release();
  try {
    signal?.addEventListener("abort", onAbort, { once: true });
    check();
    const parts: BlobPart[] = [];
    let bytes = 0;
    let slab: Uint8Array<ArrayBuffer> | undefined;
    let filled = 0;
    if (response.body !== null) {
      reader = response.body.getReader();
      while (true) {
        check();
        const chunk = await reader.read();
        check();
        if (chunk.done) break;
        if (
          !(chunk.value instanceof Uint8Array) ||
          chunk.value.byteLength > MAX_MANAGEMENT_JSON_BYTES - bytes
        )
          throw new Error("Management response exceeds its byte budget.");
        let offset = 0;
        while (offset < chunk.value.byteLength) {
          if (!slab || filled === slab.byteLength) {
            if (slab) parts.push(slab);
            slab = new Uint8Array(
              Math.min(SLAB_BYTES, MAX_MANAGEMENT_JSON_BYTES - bytes),
            );
            filled = 0;
          }
          const length = Math.min(
            slab.byteLength - filled,
            chunk.value.byteLength - offset,
          );
          slab.set(chunk.value.subarray(offset, offset + length), filled);
          filled += length;
          offset += length;
          bytes += length;
        }
      }
    }
    fullyRead = true;
    if (slab && filled) parts.push(slab.subarray(0, filled));
    check();
    // Native parsing retains UTF-8/BOM behavior, after the source is bounded.
    const result: unknown = await new Response(new Blob(parts)).json();
    check();
    return result;
  } catch (error) {
    // Releasing a pending reader can reject its read before the next explicit
    // checkpoint. Recorded cancellation/deadline still owns that outcome.
    check();
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    release();
  }
}
