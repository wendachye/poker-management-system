import "server-only";
import { randomUUID } from "node:crypto";
import { authAdmissionDetails } from "./password-work";
import { failure, json } from "./http";
import { logOperationalEvent } from "./operational-events";

/** Observe a completed auth response without reading the request or response body. */
export async function observeAuth(
  method: "POST" | "DELETE",
  action: (requestId: string) => Promise<Response>,
) {
  const requestId = randomUUID();
  const started = performance.now();
  let response: Response;
  try {
    response = await action(requestId);
  } catch (error) {
    const admission = authAdmissionDetails(error);
    if (admission) {
      response = json(
        { error: admission.message },
        admission.status,
        requestId,
      );
      response.headers.set("Retry-After", String(admission.retryAfterSeconds));
    } else response = failure(error, requestId);
  }
  response.headers.set("X-Request-ID", requestId);
  try {
    logOperationalEvent({
      event: "auth_request",
      requestId,
      method,
      status: response.status,
      durationMs: performance.now() - started,
    });
  } catch {}
  return response;
}
