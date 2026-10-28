import "server-only";
import { databasePoolErrorCode } from "./database-options";

export type OperationalEvent =
  | { event: "request_failed"; requestId: string; code: string }
  | {
      event: "auth_request";
      requestId: string;
      method: "POST" | "DELETE";
      status: number;
      durationMs: number;
    }
  | { event: "database_pool_error"; code: string }
  | {
      event: "readiness_failed";
      requestId: string;
      reason: "CONFIGURATION" | "DATABASE" | "SCHEMA" | "PROTOTYPE_FLAGS";
      code?: string;
    };

const requestReference =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const fields = {
  request_failed: ["event", "requestId", "code"],
  auth_request: ["event", "requestId", "method", "status", "durationMs"],
  database_pool_error: ["event", "code"],
  readiness_failed: ["event", "requestId", "reason", "code"],
};

/** Deliberately accepts no free-form context, errors, URLs or identities.
 * A true return means a write was attempted, not durable log delivery.
 */
export function logOperationalEvent(input: OperationalEvent): boolean {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input))
      return false;
    const event = input.event;
    if (typeof event !== "string" || !Object.hasOwn(fields, event))
      return false;
    if (Object.keys(input).some((key) => !fields[event].includes(key)))
      return false;
    const timestamp = new Date().toISOString();
    let record: Record<string, string | number>;
    let level: "info" | "warn" | "error";
    const requestId =
      event === "database_pool_error" ? undefined : input.requestId;
    if (
      event !== "database_pool_error" &&
      (typeof requestId !== "string" || !requestReference.test(requestId))
    )
      return false;
    const code = (value: string, fallback: string) => {
      if (
        [
          "POOL_ACQUIRE_TIMEOUT",
          "CONNECTION_TIMEOUT",
          "QUERY_READ_TIMEOUT",
        ].includes(value)
      )
        return value;
      const known = databasePoolErrorCode({ code: value });
      return known === "UNKNOWN" ? fallback : known;
    };
    switch (event) {
      case "request_failed":
        record = {
          timestamp,
          event,
          requestId: requestId!,
          code: code(input.code, "SERVER_ERROR"),
        };
        level = "error";
        break;
      case "database_pool_error":
        record = { timestamp, event, code: code(input.code, "UNKNOWN") };
        level = "error";
        break;
      case "readiness_failed": {
        const reason = input.reason;
        if (
          !["CONFIGURATION", "DATABASE", "SCHEMA", "PROTOTYPE_FLAGS"].includes(
            reason,
          )
        )
          return false;
        record = {
          timestamp,
          event,
          requestId: requestId!,
          route: "/api/health",
          reason,
        };
        if (input.code !== undefined) record.code = code(input.code, "UNKNOWN");
        level = "error";
        break;
      }
      case "auth_request": {
        const { method, status, durationMs } = input;
        if (
          !["POST", "DELETE"].includes(method) ||
          !Number.isInteger(status) ||
          status < 200 ||
          status > 599 ||
          !Number.isFinite(durationMs) ||
          durationMs < 0
        )
          return false;
        const outcome =
          status >= 500
            ? "unavailable"
            : status === 429
              ? "throttled"
              : status >= 400
                ? "rejected"
                : status >= 300
                  ? "redirected"
                  : "succeeded";
        record = {
          timestamp,
          event,
          requestId: requestId!,
          route: "/api/auth",
          method,
          status,
          outcome,
          durationMs: Math.min(86_400_000, Math.round(durationMs)),
        };
        level = status >= 500 ? "error" : status >= 400 ? "warn" : "info";
      }
    }
    const result = (console[level] as (...values: unknown[]) => unknown)(
      JSON.stringify(record),
    );
    if (result !== undefined) void Promise.resolve(result).catch(() => {});
    return true;
  } catch {
    // Diagnostics must never make a completed operation appear to have failed.
    return false;
  }
}
