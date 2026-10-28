import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { createReadinessService } from "../src/server/readiness";
import type { HealthEnvironment } from "../src/server/health";
import type { SqlConnection } from "../src/server/database";
import { testDatabase } from "./helpers/database";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
before(async () => {
  fixture = await testDatabase();
});
after(async () => {
  await fixture.engine.close();
});
const production = {
  NODE_ENV: "production",
  APP_ORIGIN: "https://operations.example.com",
  DATABASE_URL:
    "postgresql://fixture:private-fixture-password@database.example.com/poker?sslmode=verify-full",
};
function counted() {
  let connections = 0;
  const queries: string[] = [];
  const connect = (): SqlConnection => {
    connections++;
    return {
      async query<T>(sql: string, values?: unknown[]) {
        queries.push(sql);
        return fixture.db.query<T>(sql, values);
      },
    };
  };
  return { connect, queries, connections: () => connections };
}
async function quiet<T>(
  work: (events: Record<string, unknown>[]) => Promise<T>,
) {
  const original = console.error;
  const events: Record<string, unknown>[] = [];
  console.error = (line: unknown) => {
    events.push(JSON.parse(line as string));
  };
  try {
    return await work(events);
  } finally {
    console.error = original;
  }
}
async function generic(
  response: Response,
  status: number,
  mode = "operations",
) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("x-request-id") ?? "", /^[a-f0-9-]{36}$/);
  assert.deepEqual(await response.json(), {
    status: status === 200 ? "ok" : "unavailable",
    mode,
  });
}

test("health bursts and cached hits share four metadata queries while every receipt stays independent", async () => {
  const db = counted();
  const readiness = createReadinessService({
    connect: db.connect,
    environment: () => production,
    ttlMs: 60000,
    deadlineMs: 60000,
  });
  const responses = await Promise.all(
    Array.from({ length: 100 }, () => readiness()),
  );
  responses.push(
    ...(await Promise.all(Array.from({ length: 20 }, () => readiness()))),
  );
  assert.equal(db.connections(), 1);
  assert.equal(db.queries.length, 4);
  for (const sql of db.queries)
    assert.match(
      sql,
      /^(SELECT 1|SELECT to_regclass|SELECT version,name,checksum|SELECT table_name, column_name)/,
    );
  assert.equal(
    new Set(responses.map((response) => response.headers.get("x-request-id")))
      .size,
    120,
  );
  for (const response of responses) await generic(response, 200);
});

test("cached failures keep fresh correlated references and never retain error details", async () => {
  await quiet(async (events) => {
    let connections = 0;
    const readiness = createReadinessService({
      connect: () => {
        connections++;
        throw new Error("private-fixture-password SELECT private-venue");
      },
      environment: () => production,
      ttlMs: 60000,
    });
    const responses = await Promise.all(
      Array.from({ length: 50 }, () => readiness()),
    );
    assert.equal(connections, 1);
    assert.equal(events.length, 50);
    const ids = new Set(
      responses.map((response) => response.headers.get("x-request-id")),
    );
    assert.equal(ids.size, 50);
    for (const event of events) {
      assert.ok(ids.has(event.requestId as string));
      assert.equal(event.event, "readiness_failed");
      assert.equal(event.reason, "DATABASE");
    }
    assert.doesNotMatch(
      JSON.stringify(events),
      /private|SELECT|database\.example/,
    );
    for (const response of responses) await generic(response, 503);
  });
});

test("prototype and invalid configuration gates run before a cached operations success", async () => {
  await quiet(async (events) => {
    const db = counted();
    let env: HealthEnvironment = production;
    const readiness = createReadinessService({
      connect: db.connect,
      environment: () => env,
      ttlMs: 60000,
      deadlineMs: 60000,
    });
    await generic(await readiness(), 200);
    env = { ...production, APP_ORIGIN: "http://localhost" };
    await generic(await readiness(), 503);
    assert.equal(events.at(-1)?.reason, "CONFIGURATION");
    env = {
      ...production,
      NEXT_PUBLIC_POKER_PROTOTYPE: "1",
      POKER_PROTOTYPE_MODE: "1",
    };
    await generic(await readiness(), 200, "prototype");
    env = { ...production, NEXT_PUBLIC_POKER_PROTOTYPE: "1" };
    await generic(await readiness(), 503, "prototype");
    assert.equal(events.at(-1)?.reason, "PROTOTYPE_FLAGS");
    assert.equal(db.connections(), 1);
    env = production;
    await generic(await readiness(), 200);
    assert.equal(db.connections(), 2);
  });
});

test("a changed runtime database target or pool budget fails closed instead of checking the old pool", async () => {
  await quiet(async () => {
    const db = counted();
    let env: HealthEnvironment = production;
    const readiness = createReadinessService({
      connect: db.connect,
      environment: () => env,
      ttlMs: 60000,
      deadlineMs: 60000,
    });
    await generic(await readiness(), 200);
    env = {
      ...production,
      DATABASE_URL: production.DATABASE_URL.replace(
        "database.example.com",
        "other.example.com",
      ),
    };
    await generic(await readiness(), 503);
    env = { ...production, DATABASE_POOL_MAX: "6" };
    await generic(await readiness(), 503);
    env = { ...production, PGPORT: "55492" };
    await generic(await readiness(), 503);
    assert.equal(db.connections(), 1);
    env = production;
    await generic(await readiness(), 200);
    assert.equal(db.connections(), 2);
  });
});

test("configuration changes invalidate a pending old success without overlapping its database work", async () => {
  await quiet(async (events) => {
    let env: HealthEnvironment = production,
      connections = 0;
    let begin!: () => void, release!: () => void, drain!: () => void;
    const began = new Promise<void>((resolve) => {
      begin = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const drained = new Promise<void>((resolve) => {
      drain = resolve;
    });
    const readiness = createReadinessService({
      environment: () => env,
      ttlMs: 60000,
      deadlineMs: 60000,
      connect: () => {
        const first = ++connections === 1;
        return {
          async query<T>(sql: string, values?: unknown[]) {
            if (first && sql === "SELECT 1") {
              begin();
              await hold;
            }
            const result = await fixture.db.query<T>(sql, values);
            if (first && sql.includes("information_schema.columns")) drain();
            return result;
          },
        };
      },
    });
    const old = readiness();
    await began;
    env = { ...production, APP_ORIGIN: "http://localhost" };
    await generic(await readiness(), 503);
    await generic(await old, 503);
    env = production;
    await generic(await readiness(), 503);
    assert.equal(events.at(-1)?.reason, "PROBE_BUSY");
    assert.equal(connections, 1);
    release();
    await drained;
    await setImmediate();
    await generic(await readiness(), 200);
    assert.equal(connections, 2);
  });
});

test("environment accessor failures never return a cached success or expose configuration details", async () => {
  await quiet(async (events) => {
    const db = counted();
    let fail = false;
    const readiness = createReadinessService({
      connect: db.connect,
      environment: () => {
        if (fail)
          return new Proxy(
            {},
            {
              get() {
                throw new Error("private-configuration");
              },
            },
          );
        return production;
      },
      ttlMs: 60000,
      deadlineMs: 60000,
    });
    await generic(await readiness(), 200);
    fail = true;
    await generic(await readiness(), 503);
    assert.equal(events.at(-1)?.reason, "CONFIGURATION");
    assert.equal(db.connections(), 1);
    assert.doesNotMatch(JSON.stringify(events), /private/);
  });
});
