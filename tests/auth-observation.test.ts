import assert from "node:assert/strict";
import { test } from "node:test";
import { DomainError } from "../src/domain/operations";
import { observeAuth } from "../src/server/auth-observation";
import { json } from "../src/server/http";
import { AuthAdmissionError } from "../src/server/password-work";

const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const levels = ["log", "info", "warn", "error"] as const;
type Event = Record<string, unknown>;
async function capture<T>(work: () => Promise<T>) {
  const original = Object.fromEntries(
    levels.map((level) => [level, console[level]]),
  );
  const events: Event[] = [];
  for (const level of levels)
    console[level] = (...values: unknown[]) => {
      assert.equal(values.length, 1);
      assert.equal(typeof values[0], "string");
      events.push(JSON.parse(values[0] as string) as Event);
    };
  try {
    return { result: await work(), events };
  } finally {
    Object.assign(console, original);
  }
}
function authEvent(events: Event[], response: Response, method = "POST") {
  const entries = events.filter((event) => event.event === "auth_request");
  assert.equal(entries.length, 1);
  const event = entries[0];
  assert.equal(event.requestId, response.headers.get("x-request-id"));
  assert.match(event.requestId as string, uuid);
  assert.equal(event.route, "/api/auth");
  assert.equal(event.method, method);
  assert.equal(event.status, response.status);
  assert.equal(typeof event.durationMs, "number");
  assert.ok(Number.isFinite(event.durationMs));
  assert.ok((event.durationMs as number) >= 0);
  assert.equal(
    new Date(event.timestamp as string).toISOString(),
    event.timestamp,
  );
  return event;
}

test("auth observation retains response cookies and body without reading or logging sensitive values", async () => {
  const forgedId = "6cb33bbc-ac10-4abe-9969-1db315dcd58f";
  const { result, events } = await capture(() =>
    observeAuth("POST", async () => {
      const response = json({ value: "private-response-body" }, 200, forgedId);
      response.headers.set(
        "Set-Cookie",
        "poker_session=private-cookie; HttpOnly",
      );
      return response;
    }),
  );
  authEvent(events, result);
  assert.notEqual(result.headers.get("x-request-id"), forgedId);
  assert.equal(result.bodyUsed, false);
  assert.equal(
    result.headers.get("set-cookie"),
    "poker_session=private-cookie; HttpOnly",
  );
  assert.deepEqual(await result.json(), { value: "private-response-body" });
  assert.doesNotMatch(JSON.stringify(events), /private-|6cb33bbc/);
});

test("known and unknown sign-in rejections have identical operational outcome categories", async () => {
  const outcomes = [];
  for (const message of ["private-known-user", "private-unknown-user"]) {
    const { result, events } = await capture(() =>
      observeAuth("POST", async () => {
        throw new DomainError(message, 401);
      }),
    );
    const event = authEvent(events, result);
    outcomes.push(event.outcome);
    assert.equal(result.status, 401);
    assert.doesNotMatch(JSON.stringify(events), /private-|known|unknown/);
  }
  assert.ok(typeof outcomes[0] === "string" && outcomes[0].length > 0);
  assert.equal(outcomes[0], outcomes[1]);
});

test("auth observation preserves validation, origin, throttle and busy admission responses", async () => {
  for (const error of [
    new DomainError("Invalid credentials.", 400),
    new DomainError("Request origin is not allowed.", 403),
    new AuthAdmissionError("Too many sign-in attempts.", 429, 60),
    new AuthAdmissionError("The service is busy.", 503, 5),
  ]) {
    const { result, events } = await capture(() =>
      observeAuth("POST", async () => {
        throw error;
      }),
    );
    authEvent(events, result);
    assert.equal(result.status, error.status);
    assert.deepEqual(await result.json(), { error: error.message });
    assert.equal(
      result.headers.get("retry-after"),
      error instanceof AuthAdmissionError
        ? String(error.retryAfterSeconds)
        : null,
    );
  }
});

test("unexpected auth errors share one correlation ID with their generic failure event", async () => {
  const { result, events } = await capture(() =>
    observeAuth("POST", async () => {
      throw Object.assign(new Error("private-password SELECT private-player"), {
        code: "ECONNRESET",
        detail: "private-sql",
      });
    }),
  );
  authEvent(events, result);
  const failed = events.find((event) => event.event === "request_failed");
  assert.equal(failed?.requestId, result.headers.get("x-request-id"));
  assert.equal(failed?.code, "ECONNRESET");
  assert.equal(result.status, 503);
  assert.doesNotMatch(JSON.stringify(events), /private|SELECT/);
});

test("simultaneous auth outcomes keep distinct response-to-event references", async () => {
  const { result: responses, events } = await capture(() =>
    Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        observeAuth(index % 2 ? "POST" : "DELETE", async (requestId) =>
          json({ ok: true }, 200, requestId),
        ),
      ),
    ),
  );
  assert.equal(
    new Set(responses.map((response) => response.headers.get("x-request-id")))
      .size,
    20,
  );
  assert.equal(events.length, 20);
  for (const [index, response] of responses.entries())
    authEvent(
      events.filter(
        (event) => event.requestId === response.headers.get("x-request-id"),
      ),
      response,
      index % 2 ? "POST" : "DELETE",
    );
});

test("logging sink failures cannot change a completed login or logout response", async () => {
  const original = Object.fromEntries(
    levels.map((level) => [level, console[level]]),
  );
  for (const level of levels)
    console[level] = () => {
      throw new Error("private-sink-failure");
    };
  let completed = 0;
  try {
    for (const method of ["POST", "DELETE"] as const) {
      const response = await observeAuth(method, async () => {
        completed++;
        const saved = json({ ok: true });
        saved.headers.set("Set-Cookie", "poker_session=retained; HttpOnly");
        return saved;
      });
      assert.equal(response.status, 200);
      assert.equal(
        response.headers.get("set-cookie"),
        "poker_session=retained; HttpOnly",
      );
      assert.deepEqual(await response.json(), { ok: true });
    }
    assert.equal(completed, 2);
    assert.equal(
      (
        await observeAuth("POST", async () => {
          throw new DomainError("Rejected.", 401);
        })
      ).status,
      401,
    );
  } finally {
    Object.assign(console, original);
  }
});

test("hostile exception objects cannot replace an auth failure or expose their getters", async () => {
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  for (const error of [
    revoked.proxy,
    new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("private-prototype");
        },
      },
    ),
    Object.defineProperty(new Error("private-error"), "message", {
      get() {
        throw new Error("private-getter");
      },
    }),
  ]) {
    const { result, events } = await capture(() =>
      observeAuth("POST", async () => {
        throw error;
      }),
    );
    authEvent(events, result);
    assert.equal(result.status, 503);
    assert.equal(
      events.find((event) => event.event === "request_failed")?.code,
      "SERVER_ERROR",
    );
    assert.doesNotMatch(JSON.stringify(events), /private/);
    assert.doesNotMatch(JSON.stringify(await result.json()), /private/);
  }
});

test("marked admission values are validated once before setting status and Retry-After", async () => {
  let statuses = 0,
    retries = 0;
  const error = new AuthAdmissionError("Try again shortly.", 429, 5);
  Object.defineProperty(error, "status", {
    get() {
      statuses++;
      if (statuses > 1) throw new Error("private-status-getter");
      return 429;
    },
  });
  Object.defineProperty(error, "retryAfterSeconds", {
    get() {
      retries++;
      return retries === 1 ? 5 : "private-retry-sentinel";
    },
  });
  const { result: response, events } = await capture(() =>
    observeAuth("POST", async () => {
      throw error;
    }),
  );
  authEvent(events, response);
  assert.equal(statuses, 1);
  assert.equal(retries, 1);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "5");
  assert.deepEqual(await response.json(), { error: "Try again shortly." });
  assert.doesNotMatch(JSON.stringify(events), /private/);
});
