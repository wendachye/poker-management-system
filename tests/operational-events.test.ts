import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import {
  logOperationalEvent,
  type OperationalEvent,
} from "../src/server/operational-events";

const requestId = "96eaf58e-312d-48cb-a374-82ff8a58e60b";
const levels = ["info", "warn", "error"] as const;
async function capture(
  work: (records: Record<string, unknown>[]) => void | Promise<void>,
) {
  const previous = Object.fromEntries(
    levels.map((level) => [level, console[level]]),
  );
  const records: Record<string, unknown>[] = [];
  for (const level of levels)
    console[level] = (...values: unknown[]) => {
      assert.equal(values.length, 1);
      records.push(JSON.parse(values[0] as string) as Record<string, unknown>);
    };
  try {
    await work(records);
  } finally {
    Object.assign(console, previous);
  }
}

test("operational events have fixed fields, safe codes and bounded auth measurements", async () => {
  await capture((records) => {
    assert.equal(
      logOperationalEvent({
        event: "request_failed",
        requestId,
        code: "private-code",
      }),
      true,
    );
    assert.equal(
      logOperationalEvent({ event: "database_pool_error", code: "ECONNRESET" }),
      true,
    );
    assert.equal(
      logOperationalEvent({
        event: "readiness_failed",
        requestId,
        reason: "SCHEMA",
      }),
      true,
    );
    assert.equal(
      logOperationalEvent({
        event: "auth_request",
        requestId,
        method: "POST",
        status: 429,
        durationMs: 1e20,
      }),
      true,
    );
    const [failed, pool, ready, auth] = records;
    assert.equal(failed.code, "SERVER_ERROR");
    assert.equal(pool.code, "ECONNRESET");
    assert.deepEqual(Object.keys(pool).sort(), ["code", "event", "timestamp"]);
    assert.equal(ready.route, "/api/health");
    assert.equal(ready.reason, "SCHEMA");
    assert.equal(auth.route, "/api/auth");
    assert.equal(auth.outcome, "throttled");
    assert.equal(auth.durationMs, 86400000);
    for (const record of records)
      assert.equal(
        new Date(record.timestamp as string).toISOString(),
        record.timestamp,
      );
    assert.doesNotMatch(JSON.stringify(records), /private/);
  });
});

test("unknown fields and invalid primitives cannot become operational context", async () => {
  await capture((records) => {
    const base = {
      event: "auth_request",
      requestId,
      method: "POST",
      status: 200,
      durationMs: 1,
    };
    for (const input of [
      null,
      [],
      {},
      { ...base, password: "private-password" },
      { ...base, requestId: "private-cookie" },
      {
        ...base,
        requestId: {
          toString: () => requestId,
          privatePassword: "private-password",
        },
      },
      {
        ...base,
        event: {
          toString: () => "auth_request",
          privatePlayer: "private-player",
        },
      },
      { ...base, method: "GET" },
      { ...base, durationMs: NaN },
      { ...base, durationMs: -1 },
      { ...base, status: 200.5 },
      { ...base, status: 999 },
      { event: "readiness_failed", requestId, reason: "private-database-host" },
    ])
      assert.equal(logOperationalEvent(input as OperationalEvent), false);
    assert.equal(records.length, 0);
  });
});

test("classified client timeout categories survive request, pool and readiness logging", async () => {
  await capture((records) => {
    for (const code of [
      "POOL_ACQUIRE_TIMEOUT",
      "CONNECTION_TIMEOUT",
      "QUERY_READ_TIMEOUT",
    ]) {
      assert.equal(
        logOperationalEvent({ event: "request_failed", requestId, code }),
        true,
      );
      assert.equal(
        logOperationalEvent({ event: "database_pool_error", code }),
        true,
      );
      assert.equal(
        logOperationalEvent({
          event: "readiness_failed",
          requestId,
          reason: "DATABASE",
          code,
        }),
        true,
      );
      assert.deepEqual(
        records.slice(-3).map((record) => record.code),
        [code, code, code],
      );
    }
  });
});

test("accessor-backed event values are sampled once and throwing accessors never escape", async () => {
  await capture((records) => {
    let references = 0,
      methods = 0;
    const input = {
      event: "auth_request" as const,
      get requestId() {
        references++;
        return references === 1
          ? requestId
          : ({ privatePassword: "private-password" } as unknown as string);
      },
      get method() {
        methods++;
        return methods === 1
          ? ("POST" as const)
          : ({ privatePlayer: "private-player" } as unknown as "POST");
      },
      status: 200,
      durationMs: 1,
    };
    assert.equal(logOperationalEvent(input), true);
    assert.equal(references, 1);
    assert.equal(methods, 1);
    assert.doesNotMatch(JSON.stringify(records), /private/);
    assert.equal(
      logOperationalEvent(
        new Proxy(
          {},
          {
            get() {
              throw new Error("private-error");
            },
          },
        ) as OperationalEvent,
      ),
      false,
    );
    assert.equal(
      logOperationalEvent(
        new Proxy(
          {},
          {
            get() {
              return "auth_request";
            },
            ownKeys() {
              throw new Error("private-error");
            },
          },
        ) as OperationalEvent,
      ),
      false,
    );
  });
});

test("synchronous and asynchronous sink failures cannot escape the diagnostic writer", async () => {
  const original = console.error;
  try {
    console.error = () => {
      throw new Error("private-sink-failure");
    };
    assert.equal(
      logOperationalEvent({
        event: "request_failed",
        requestId,
        code: "ECONNRESET",
      }),
      false,
    );
    console.error = () =>
      Promise.reject(new Error("private-asynchronous-sink-failure"));
    assert.equal(
      logOperationalEvent({
        event: "request_failed",
        requestId,
        code: "ECONNRESET",
      }),
      true,
    );
    await setImmediate();
  } finally {
    console.error = original;
  }
});
