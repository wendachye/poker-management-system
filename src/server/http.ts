import "server-only";
import { cookies } from "next/headers";
import { DomainError } from "../domain/operations";
import { SESSION_COOKIE } from "./auth";

export async function sessionToken() {
  return (await cookies()).get(SESSION_COOKIE)?.value;
}
export function json(value: unknown, status = 200) {
  return Response.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
export function verifyOrigin(request: Request) {
  const expected = process.env.APP_ORIGIN || new URL(request.url).origin;
  if (request.headers.get("origin") !== expected)
    throw new DomainError("Request origin is not allowed.", 403);
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    throw new DomainError("JSON is required.", 415);
}
export async function body(request: Request) {
  verifyOrigin(request);
  const text = await request.text();
  if (text.length > 16000) throw new DomainError("Request is too large.", 413);
  try {
    return JSON.parse(text);
  } catch {
    throw new DomainError("Invalid JSON.");
  }
}
export function failure(error: unknown) {
  if (error instanceof DomainError)
    return json({ error: error.message }, error.status);
  console.error("Poker server error:", error);
  return json(
    {
      error:
        "The service is unavailable. Check the database configuration or contact your administrator.",
    },
    503,
  );
}
