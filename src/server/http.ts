import "server-only";
import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { DomainError } from "../domain/operations";
import { SESSION_COOKIE } from "./auth";
import { databasePoolErrorCode } from "./database-options";
import { validateProductionConfig } from "./production-config";
import { logOperationalEvent } from "./operational-events";

const MAX_BODY_BYTES = 16000;
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
  verifyOrigin(request);
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^\d+$/.test(declaredLength))
      throw new DomainError("Invalid Content-Length.");
    if (Number(declaredLength) > MAX_BODY_BYTES) {
      // Do not wait for a remote sender to finish cancellation before rejecting.
      void request.body?.cancel().catch(() => {});
      throw new DomainError("Request is too large.", 413);
    }
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body?.getReader();
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BODY_BYTES) {
          void reader.cancel().catch(() => {});
          throw new DomainError("Request is too large.", 413);
        }
        chunks.push(value);
      }
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError("Could not read request body.");
    } finally {
      reader.releaseLock();
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
