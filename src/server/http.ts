import "server-only";
import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { DomainError } from "../domain/operations";
import { SESSION_COOKIE } from "./auth";
import { databasePoolErrorCode } from "./database-options";
import { validateProductionConfig } from "./production-config";
import { logOperationalEvent } from "./operational-events";

const MAX_BODY_BYTES = 16000;
const BODY_UPLOAD_TIMEOUT_MS = 10000;
// Match the media type exactly, while allowing well-formed token/quoted parameters.
const JSON_CONTENT_TYPE =
  /^application\/json(?:[ \t]*;[ \t]*[!#$%&'*+.^_`|~0-9a-z-]+[ \t]*=[ \t]*(?:[!#$%&'*+.^_`|~0-9a-z-]+|"(?:[^"\\\r\n]|\\[^\r\n])*"))*[ \t]*$/i;

export async function sessionToken() {
  return (await cookies()).get(SESSION_COOKIE)?.value;
}
export function json(
  value: unknown,
  status = 200,
  requestId: string = randomUUID(),
) {
  return Response.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Request-ID": requestId,
    },
  });
}
export function prototypeApiResponse(): Response | null {
  if (
    process.env.POKER_PROTOTYPE_MODE !== "1" &&
    process.env.NEXT_PUBLIC_POKER_PROTOTYPE !== "1"
  )
    return null;
  return json(
    { error: "Staff APIs are disabled in the sample-data prototype." },
    404,
  );
}
export function verifyOrigin(request: Request) {
  const expected =
    process.env.NODE_ENV === "production"
      ? validateProductionConfig().origin
      : process.env.APP_ORIGIN || new URL(request.url).origin;
  if (request.headers.get("origin") !== expected)
    throw new DomainError("Request origin is not allowed.", 403);
  if (!JSON_CONTENT_TYPE.test(request.headers.get("content-type") ?? ""))
    throw new DomainError("JSON is required.", 415);
}
export async function body(request: Request) {
  const deadline = performance.now() + BODY_UPLOAD_TIMEOUT_MS;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let listening = false;
  let cancelled = false;
  let stopError: DomainError | undefined;
  let rejectStop: ((error: DomainError) => void) | undefined;
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    try {
      // A remote source may reject or never finish cancellation.
      const cancellation = reader ? reader.cancel() : request.body?.cancel();
      void cancellation?.catch(() => {});
    } catch {}
  };
  const stop = (message: string) => {
    if (stopError) return;
    stopError = new DomainError(message, 408);
    rejectStop?.(stopError);
    cancel();
  };
  const onAbort = () => stop("Request upload was cancelled. Please try again.");
  const checkDeadline = () => {
    if (request.signal.aborted) onAbort();
    if (!stopError && performance.now() >= deadline)
      stop("Request upload timed out. Please try again.");
    if (stopError) throw stopError;
  };
  try {
    verifyOrigin(request);
    checkDeadline();
    const declaredLength = request.headers.get("content-length");
    if (declaredLength !== null) {
      if (!/^\d+$/.test(declaredLength))
        throw new DomainError("Invalid Content-Length.");
      if (Number(declaredLength) > MAX_BODY_BYTES)
        throw new DomainError("Request is too large.", 413);
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    reader = request.body?.getReader();
    if (reader) {
      const stopped = new Promise<never>((_, reject) => {
        rejectStop = reject;
      });
      // Stop may occur between reads; keep its rejection observed in every case.
      void stopped.catch(() => {});
      request.signal.addEventListener("abort", onAbort, { once: true });
      listening = true;
      checkDeadline();
      timer = setTimeout(
        () => stop("Request upload timed out. Please try again."),
        Math.max(0, deadline - performance.now()),
      );
      try {
        const sourceReader = reader;
        const readChunks = async () => {
          while (true) {
            checkDeadline();
            const { done, value } = await sourceReader.read();
            // Cancellation can resolve a pending read as EOF before the race settles.
            // The recorded stop must win, including when a busy loop delays timers.
            checkDeadline();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_BODY_BYTES)
              throw new DomainError("Request is too large.", 413);
            if (value.byteLength) chunks.push(value);
          }
        };
        // One race avoids retaining another stop-promise handler per chunk.
        await Promise.race([readChunks(), stopped]);
        checkDeadline();
      } catch (error) {
        if (stopError) throw stopError;
        if (error instanceof DomainError) throw error;
        throw new DomainError("Could not read request body.");
      }
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return JSON.parse(text);
    } catch {
      throw new DomainError("Invalid JSON.");
    }
  } catch (error) {
    cancel();
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (listening) request.signal.removeEventListener("abort", onAbort);
    try {
      reader?.releaseLock();
    } catch {}
  }
}
export function failure(error: unknown, requestId: string = randomUUID()) {
  try {
    if (error instanceof DomainError)
      return json({ error: error.message }, error.status, requestId);
  } catch {}
  const category = databasePoolErrorCode(error);
  const code = category === "UNKNOWN" ? "SERVER_ERROR" : category;
  // SQL errors can contain credentials, record values and query parameters.
  logOperationalEvent({ event: "request_failed", requestId, code });
  return json(
    {
      error:
        "The service is unavailable. Check the database configuration or contact your administrator.",
    },
    503,
    requestId,
  );
}
