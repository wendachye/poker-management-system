import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { healthResponse } from "../src/server/health";
import { migrate } from "../src/server/schema";
import type { Database, SqlConnection } from "../src/server/database";
import { spawnSync } from "node:child_process";

const operations = {
  NODE_ENV: "production",
  APP_ORIGIN: "https://operations.example.com",
  DATABASE_URL:
    "postgresql://app:production-secret-example@database.example.com/poker?sslmode=verify-full",
};

function unavailable(): never {
  throw new Error("Must not connect to any database");
}

test("prototype health reports its mode without opening a database", async () => {
  const savedError = console.error;
  const events: unknown[][] = [];
  let response: Response;
  try {
    console.error = (...args: unknown[]) => events.push(args);
    response = await healthResponse(unavailable, {
      NEXT_PUBLIC_POKER_PROTOTYPE: "1",
      POKER_PROTOTYPE_MODE: "1",
    });
  } finally {
    console.error = savedError;
  }
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok", mode: "prototype" });
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("x-request-id") ?? "", /^[a-f0-9-]{36}$/);
  assert.deepEqual(events, [], "Healthy prototype probes remain quiet");
});

test("mismatched prototype flags report unavailable without opening a database", async () => {
  for (const flag of ["NEXT_PUBLIC_POKER_PROTOTYPE", "POKER_PROTOTYPE_MODE"]) {
    const response = await healthResponse(unavailable, { [flag]: "1" });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      status: "unavailable",
      mode: "prototype",
    });
  }
});

test("the actual health route responds safely in the hosted sample prototype", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--conditions=react-server",
      "--import",
      "tsx",
      "--eval",
      `(async () => {
        const { GET } = require('./src/app/api/health/route.ts');
        const response = await GET();
        console.log(JSON.stringify({ status: response.status,
          cache: response.headers.get('cache-control'), body: await response.json() }));
      })().catch(() => { process.exitCode = 1; });`,
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 20_000,
      env: {
        ...process.env,
        NODE_ENV: "production",
        NEXT_PUBLIC_POKER_PROTOTYPE: "1",
        POKER_PROTOTYPE_MODE: "1",
        DATABASE_URL: "postgresql://must-not-connect.invalid/prototype",
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), {
    status: 200,
    cache: "no-store",
    body: { status: "ok", mode: "prototype" },
  });
});

test("invalid production configuration is unavailable without connecting", async () => {
  const response = await healthResponse(unavailable, {
    ...operations,
    APP_ORIGIN: "http://localhost",
  });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    status: "unavailable",
    mode: "operations",
  });
});

test("database failures return generic no-store status without leaking details", async () => {
  const response = await healthResponse(
    () => ({
      query: async () => {
        throw new Error(
          "password secret; venue private; SELECT protected_records",
        );
      },
    }),
    operations,
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    status: "unavailable",
    mode: "operations",
  });
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
});

test("readiness failures emit fixed coarse categories correlated with generic public responses", async () => {
  const savedError = console.error;
  const logs: unknown[][] = [];
  const missingSchema: SqlConnection = {
    async query<T>(sql: string) {
      return {
        rows: (sql.includes("to_regclass") ? [{ relation: null }] : []) as T[],
      };
    },
  };
  const brokenDatabase = () => ({
    async query() {
      throw Object.assign(
        new Error("private-password; private-host; SELECT protected_records"),
        { code: "ECONNRESET" },
      );
    },
  });
  const cases = [
    {
      reason: "PROTOTYPE_FLAGS",
      mode: "prototype",
      env: { NEXT_PUBLIC_POKER_PROTOTYPE: "1" },
      connect: unavailable,
    },
    {
      reason: "CONFIGURATION",
      mode: "operations",
      env: { ...operations, APP_ORIGIN: "http://private-host" },
      connect: unavailable,
    },
    {
      reason: "DATABASE",
      mode: "operations",
      env: operations,
      connect: brokenDatabase,
    },
    {
      reason: "SCHEMA",
      mode: "operations",
      env: operations,
      connect: () => missingSchema,
    },
  ];
  try {
    console.error = (...args: unknown[]) => logs.push(args);
    const references = new Set<string>();
    for (const item of cases) {
      const response = await healthResponse(item.connect, item.env);
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), {
        status: "unavailable",
        mode: item.mode,
      });
      const requestId = response.headers.get("x-request-id")!;
      assert.match(requestId, /^[a-f0-9-]{36}$/);
      assert.equal(references.has(requestId), false);
      references.add(requestId);
      const event = JSON.parse(logs.at(-1)![0] as string);
      assert.equal(event.event, "readiness_failed");
      assert.equal(event.requestId, requestId);
      assert.equal(event.route, "/api/health");
      assert.equal(event.reason, item.reason);
      assert.equal(new Date(event.timestamp).toISOString(), event.timestamp);
      if (item.reason === "DATABASE") assert.equal(event.code, "ECONNRESET");
      assert.ok(
        Object.keys(event).every((key) =>
          [
            "timestamp",
            "event",
            "requestId",
            "route",
            "reason",
            "code",
          ].includes(key),
        ),
      );
    }
    assert.equal(logs.length, cases.length);
    assert.doesNotMatch(
      JSON.stringify(logs),
      /private-|production-secret-example|SELECT|protected_records|password/,
    );
  } finally {
    console.error = savedError;
  }
});

test("readiness status survives hostile errors and unavailable logging sinks", async () => {
  const savedError = console.error;
  try {
    console.error = () => {
      throw new Error("private log sink failure");
    };
    const response = await healthResponse(
      () => ({
        async query() {
          throw {
            get code() {
              throw new Error("private diagnostic accessor");
            },
          };
        },
      }),
      operations,
    );
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      status: "unavailable",
      mode: "operations",
    });
    assert.match(response.headers.get("x-request-id") ?? "", /^[a-f0-9-]{36}$/);
  } finally {
    console.error = savedError;
  }
});

test("readiness requires the actual schema, not only an answering database", async () => {
  const engine = await PGlite.create();
  const adapt = (client: Pick<PGlite, "query">): SqlConnection => ({
    async query<T>(sql: string, values?: unknown[]) {
      return { rows: (await client.query<T>(sql, values)).rows };
    },
  });
  const db: Database = {
    ...adapt(engine),
    transaction: (work) =>
      engine.transaction((tx) => work(adapt(tx as unknown as PGlite))),
  };
  try {
    assert.equal((await healthResponse(() => db, operations)).status, 503);
    await migrate(db);
    const response = await healthResponse(() => db, operations);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: "ok",
      mode: "operations",
    });
    const recorded = (
      await db.query<{ checksum: string }>(
        "SELECT checksum FROM poker_schema_migrations WHERE version=1",
      )
    ).rows[0];
    await db.query(
      "UPDATE poker_schema_migrations SET checksum=$1 WHERE version=1",
      ["0".repeat(64)],
    );
    assert.equal((await healthResponse(() => db, operations)).status, 503);
    await db.query(
      "UPDATE poker_schema_migrations SET checksum=$1 WHERE version=1",
      [recorded.checksum],
    );
    await db.query(
      "ALTER TABLE poker_schema_migrations RENAME TO held_schema_migrations",
    );
    assert.equal((await healthResponse(() => db, operations)).status, 503);
    await db.query(
      "ALTER TABLE held_schema_migrations RENAME TO poker_schema_migrations",
    );
    assert.equal((await healthResponse(() => db, operations)).status, 200);
    await db.query("ALTER TABLE poker_operations DROP COLUMN fingerprint");
    assert.equal((await healthResponse(() => db, operations)).status, 503);
    const local = {
      NODE_ENV: "development",
      DATABASE_URL: "postgresql://localhost/local",
    };
    await db.query("ALTER TABLE poker_operations ADD COLUMN fingerprint text");
    assert.equal((await healthResponse(() => db, local)).status, 200);
    await db.query(
      "ALTER TABLE poker_login_budget RENAME COLUMN attempts TO missing_attempts",
    );
    assert.equal((await healthResponse(() => db, local)).status, 503);
    await db.query(
      "ALTER TABLE poker_login_budget RENAME COLUMN missing_attempts TO attempts",
    );
    assert.equal((await healthResponse(() => db, local)).status, 200);
    await db.query("DROP TABLE poker_change_versions");
    assert.equal((await healthResponse(() => db, local)).status, 503);
  } finally {
    await engine.close();
  }
});
