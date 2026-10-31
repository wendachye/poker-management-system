import type { Snapshot } from "../domain/model";
import type { ReadQuery } from "../domain/read-model";
import {
  checkedExportAccess,
  decodeExportAccess,
  encodeExportAccess,
  EXPORT_ACCESS_HEADER,
  sameExportAccess,
} from "./export-access";
import { matchesOperationalAccess } from "./operational-access";
import {
  ManagementResponseError,
  readManagementResponse,
} from "./management-response";
import { readQueryParams } from "./read-page";

const MAX_CSV_BYTES = 4_000_000;
const EXPORT_TIMEOUT_MS = 45_000;

/** Obtain a verified report before the caller creates a browser download. */
export async function readReportCsv(
  query: ReadQuery,
  context: Pick<Snapshot, "user" | "branch">,
  request: (path: string, init: RequestInit) => Promise<Response>,
  callerSignal?: AbortSignal,
): Promise<Blob> {
  if (!matchesOperationalAccess(context.user, context))
    throw new Error("Reload the report before exporting.");
  const access = checkedExportAccess({
    actorId: context.user.id,
    branchId: context.branch.id,
    role: context.user.role,
  });
  if (!access || !["report", "range"].includes(query.resource))
    throw new Error("Reload the report before exporting.");
  const params = readQueryParams(query);
  params.set("format", "csv");
  const expiresAt = performance.now() + EXPORT_TIMEOUT_MS;
  const deadline = new AbortController();
  const signal = callerSignal
    ? AbortSignal.any([callerSignal, deadline.signal])
    : deadline.signal;
  const expired = () =>
    deadline.signal.aborted || performance.now() >= expiresAt;
  const checkStopped = () => {
    signal.throwIfAborted();
    if (expired()) {
      deadline.abort();
      signal.throwIfAborted();
    }
  };
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let fullyRead = false;
  const cancelled = new WeakSet<object>();
  const releaseBody = () => {
    try {
      const source = reader ?? response?.body;
      if (source && !fullyRead && !cancelled.has(source)) {
        cancelled.add(source);
        // A transport can ignore cancellation or never finish it. Do not wait
        // for it or expose its private failure while releasing this export.
        void source.cancel().catch(() => {});
      }
    } catch {}
    try {
      reader?.releaseLock();
    } catch {}
  };
  const readBody = async (value: Response) => {
    checkStopped();
    const type = value.headers.get("content-type") ?? "";
    if (value.body === null) {
      fullyRead = true;
      return new Blob([], { type });
    }
    reader = value.body.getReader();
    const parts: BlobPart[] = [];
    let bytes = 0;
    let slab: Uint8Array<ArrayBuffer> | undefined;
    let filled = 0;
    while (true) {
      checkStopped();
      const chunk = await reader.read();
      checkStopped();
      if (chunk.done) break;
      if (
        !(chunk.value instanceof Uint8Array) ||
        chunk.value.byteLength > MAX_CSV_BYTES - bytes
      )
        throw new Error("Cannot download report. Please try again.");
      // Fixed-size slabs also bound object overhead for tiny source chunks.
      // Only accepted bytes are copied, and reused adapter buffers stay isolated.
      let offset = 0;
      while (offset < chunk.value.byteLength) {
        if (!slab || filled === slab.byteLength) {
          if (slab) parts.push(slab);
          slab = new Uint8Array(Math.min(65_536, MAX_CSV_BYTES - bytes));
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
    fullyRead = true;
    if (slab && filled) parts.push(slab.subarray(0, filled));
    return new Blob(parts, { type });
  };
  let rejectStop: (reason: unknown) => void = () => {};
  const stopped = new Promise<never>((_, reject) => {
    rejectStop = reject;
  });
  void stopped.catch(() => {});
  const onStop = () => rejectStop(signal.reason);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    signal.addEventListener("abort", onStop, { once: true });
    checkStopped();
    timer = setTimeout(
      () => deadline.abort(),
      Math.max(0, expiresAt - performance.now()),
    );
    const work = (async () => {
      try {
        checkStopped();
        const received = await request("/api/read?" + params, {
          cache: "no-store",
          signal,
          headers: { [EXPORT_ACCESS_HEADER]: encodeExportAccess(access) },
        });
        response = received;
        checkStopped();
        if (!received.ok) {
          const value = await readBody(received);
          checkStopped();
          await readManagementResponse(
            new Response(value.size ? value : null, {
              status: received.status,
              headers: received.headers,
            }),
          );
          checkStopped();
        }
        const receipt = decodeExportAccess(
          received.headers.get(EXPORT_ACCESS_HEADER),
        );
        if (!receipt || !sameExportAccess(access, receipt))
          throw new ManagementResponseError(
            "Staff access or venue changed. Refresh the report before exporting.",
            409,
            null,
          );
        if (
          !/^text\/csv(?:\s*;|$)/i.test(
            received.headers.get("content-type") ?? "",
          )
        )
          throw new Error("Cannot download report. Please try again.");
        const value = await readBody(received);
        checkStopped();
        return value;
      } finally {
        // This also releases a response that arrives after the outer wait ended.
        releaseBody();
      }
    })();
    const value = await Promise.race([work, stopped]);
    checkStopped();
    return value;
  } catch (error) {
    if (callerSignal?.aborted)
      throw new DOMException("Report download cancelled.", "AbortError");
    if (expired())
      throw new ManagementResponseError(
        "Report download timed out. Try exporting again.",
        408,
        null,
      );
    if (error instanceof ManagementResponseError) throw error;
    throw new Error("Cannot download report. Please try again.");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal.removeEventListener("abort", onStop);
    releaseBody();
  }
}
