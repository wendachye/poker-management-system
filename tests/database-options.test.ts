import test from "node:test";
import assert from "node:assert/strict";
import {
  databasePoolErrorCode,
  databasePoolOptions,
} from "../src/server/database-options";
import {
  closeDatabase,
  database,
  databaseFromPool,
} from "../src/server/database";
import type { Pool } from "pg";

test("native PostgreSQL client timeouts receive safe actionable categories", () => {
  for (const [message, category] of [
    ["timeout exceeded when trying to connect", "POOL_ACQUIRE_TIMEOUT"],
    ["Connection terminated due to connection timeout", "CONNECTION_TIMEOUT"],
    ["Query read timeout", "QUERY_READ_TIMEOUT"],
  ])
    assert.equal(databasePoolErrorCode(new Error(message)), category);
  assert.equal(
    databasePoolErrorCode(new Error("Query read timeout with private details")),
    "UNKNOWN",
  );
});

test("database connections have bounded pool and server/client timeout defaults", () => {
  assert.deepEqual(databasePoolOptions({}), {
    max: 5,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 10_000,
    statement_timeout: 15_000,
    lock_timeout: 5_000,
    idle_in_transaction_session_timeout: 15_000,
    query_timeout: 20_000,
  });
  assert.deepEqual(
    databasePoolOptions({ DATABASE_POOL_MAX: "" }),
    databasePoolOptions({}),
  );
});

test("database connection budgets accept explicit bounded settings", () => {
  assert.deepEqual(
    databasePoolOptions({
      DATABASE_POOL_MAX: "12",
      DATABASE_CONNECTION_TIMEOUT_MS: "3000",
      DATABASE_IDLE_TIMEOUT_MS: "20000",
      DATABASE_STATEMENT_TIMEOUT_MS: "40000",
      DATABASE_LOCK_TIMEOUT_MS: "2000",
      DATABASE_IDLE_TRANSACTION_TIMEOUT_MS: "25000",
    }),
    {
      max: 12,
      connectionTimeoutMillis: 3_000,
      idleTimeoutMillis: 20_000,
      statement_timeout: 40_000,
      lock_timeout: 2_000,
      idle_in_transaction_session_timeout: 25_000,
      query_timeout: 45_000,
    },
  );
});

test("invalid or disabling database budgets fail without echoing configured values", () => {
  for (const key of [
    "DATABASE_POOL_MAX",
    "DATABASE_CONNECTION_TIMEOUT_MS",
    "DATABASE_IDLE_TIMEOUT_MS",
    "DATABASE_STATEMENT_TIMEOUT_MS",
    "DATABASE_LOCK_TIMEOUT_MS",
    "DATABASE_IDLE_TRANSACTION_TIMEOUT_MS",
  ]) {
    for (const value of [
      "0",
      "-1",
      "1.5",
      "1e3",
      " 5000",
      "5000 ",
      "Infinity",
      "9007199254740992",
      "private-config-value",
    ]) {
      assert.throws(
        () => databasePoolOptions({ [key]: value }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, new RegExp(key));
          if (value === "private-config-value")
            assert.equal(error.message.includes(value), false);
          return true;
        },
      );
    }
  }
  assert.throws(
    () => databasePoolOptions({ DATABASE_POOL_MAX: "51" }),
    /DATABASE_POOL_MAX/,
  );
  assert.throws(
    () => databasePoolOptions({ DATABASE_LOCK_TIMEOUT_MS: "60001" }),
    /DATABASE_LOCK_TIMEOUT_MS/,
  );
  assert.throws(
    () => databasePoolOptions({ DATABASE_STATEMENT_TIMEOUT_MS: "300001" }),
    /DATABASE_STATEMENT_TIMEOUT_MS/,
  );
  assert.throws(
    () => databasePoolOptions({ DATABASE_STATEMENT_TIMEOUT_MS: "1000" }),
    /must not exceed/,
  );
});

test("connection URLs and PGOPTIONS cannot bypass configured database budgets", () => {
  for (const key of [
    "options",
    "OPTIONS",
    "%6fptions",
    "statement_timeout",
    "lock_timeout",
    "idle_in_transaction_session_timeout",
    "query_timeout",
  ]) {
    assert.throws(
      () =>
        databasePoolOptions({
          DATABASE_URL: `postgresql://user:private-password@db.example.test/db?${key}=0`,
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /cannot override/);
        assert.equal(error.message.includes("private-password"), false);
        return true;
      },
    );
  }
  assert.throws(
    () => databasePoolOptions({ PGOPTIONS: "-c statement_timeout=0" }),
    /PGOPTIONS/,
  );
  assert.throws(
    () => databasePoolOptions({ DATABASE_URL: "private-invalid-url" }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes("private-invalid-url"), false);
      return true;
    },
  );
  assert.equal(
    databasePoolOptions({
      DATABASE_URL:
        "postgresql://user:password@db.example.test/db?sslmode=verify-full&application_name=poker",
      PGOPTIONS: "",
    }).statement_timeout,
    15_000,
  );
});

test("pool diagnostics expose only recognized error categories", () => {
  assert.equal(
    databasePoolErrorCode(
      Object.assign(new Error("private db host and password"), {
        code: "ECONNRESET",
      }),
    ),
    "ECONNRESET",
  );
  assert.equal(
    databasePoolErrorCode({ code: "57P01", detail: "private data" }),
    "57P01",
  );
  for (const error of [
    null,
    undefined,
    "private text",
    new Error("private text"),
    { code: "postgresql://private-password@private-host" },
  ])
    assert.equal(databasePoolErrorCode(error), "UNKNOWN");
});

function failurePool(failures: Record<string, Error> = {}) {
  const queries: string[] = [];
  const releases: (boolean | undefined)[] = [];
  const client = {
    async query(sql: string, values?: unknown[]) {
      queries.push(sql);
      if (failures[sql]) throw failures[sql];
      return { rows: values ? [{ value: values[0] }] : [] };
    },
    release(destroy?: boolean) {
      releases.push(destroy);
    },
  };
  const pool = {
    query: client.query,
    async connect() {
      return client;
    },
  };
  return { db: databaseFromPool(pool), queries, releases };
}

test("successful database work commits and returns query results before releasing", async () => {
  const { db, queries, releases } = failurePool();
  assert.deepEqual(await db.query("SELECT $1", ["outside"]), {
    rows: [{ value: "outside" }],
  });
  assert.equal(
    await db.transaction(
      async (connection) =>
        (await connection.query<{ value: string }>("SELECT $1", ["inside"]))
          .rows[0].value,
    ),
    "inside",
  );
  assert.deepEqual(queries, ["SELECT $1", "BEGIN", "SELECT $1", "COMMIT"]);
  assert.deepEqual(releases, [undefined]);
});

test("a failed transaction rolls back, preserves the original error and can recover", async () => {
  const original = new Error("business rule failed");
  const { db, queries, releases } = failurePool();
  await assert.rejects(
    db.transaction(async () => {
      throw original;
    }),
    (error) => error === original,
  );
  assert.deepEqual(queries, ["BEGIN", "ROLLBACK"]);
  assert.deepEqual(releases, [undefined]);
  assert.equal(await db.transaction(async () => "recovered"), "recovered");
  assert.deepEqual(queries.slice(2), ["BEGIN", "COMMIT"]);
});

test("rollback failure discards the unsafe connection without masking the original failure", async () => {
  const original = new Error("write failed");
  const { db, queries, releases } = failurePool({
    ROLLBACK: new Error("connection lost"),
  });
  await assert.rejects(
    db.transaction(async () => {
      throw original;
    }),
    (error) => error === original,
  );
  assert.deepEqual(queries, ["BEGIN", "ROLLBACK"]);
  assert.deepEqual(releases, [true]);
});

test("BEGIN and COMMIT failures both receive rollback and deterministic cleanup", async () => {
  for (const stage of ["BEGIN", "COMMIT"]) {
    const original = new Error(stage + " failed");
    const { db, queries, releases } = failurePool({ [stage]: original });
    await assert.rejects(
      db.transaction(async () => "not returned"),
      (error) => error === original,
    );
    assert.deepEqual(
      queries,
      stage === "BEGIN"
        ? ["BEGIN", "ROLLBACK"]
        : ["BEGIN", "COMMIT", "ROLLBACK"],
    );
    assert.deepEqual(releases, [undefined]);
  }
});

test("real pool idle-error events are handled without logging raw connection details", async () => {
  const savedEnv = { ...process.env };
  const savedError = console.error;
  const messages: unknown[][] = [];
  const shared = globalThis as typeof globalThis & { pokerPool?: Pool };
  try {
    await closeDatabase();
    for (const key of Object.keys(process.env))
      if (key.startsWith("DATABASE_") || key === "PGOPTIONS")
        delete process.env[key];
    process.env.POKER_PROTOTYPE_MODE = "";
    process.env.NEXT_PUBLIC_POKER_PROTOTYPE = "";
    Object.assign(process.env, { NODE_ENV: "test" });
    process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test";
    console.error = (...args: unknown[]) => {
      messages.push(args);
    };
    database();
    const pool = shared.pokerPool!;
    assert.equal(pool.listenerCount("error"), 1);
    assert.equal(
      pool.totalCount,
      0,
      "No network connection should be opened by constructing a pool",
    );
    assert.equal(
      pool.emit(
        "error",
        Object.assign(new Error("private-password@private-host"), {
          code: "ECONNRESET",
        }),
      ),
      true,
    );
    database();
    assert.equal(
      pool.listenerCount("error"),
      1,
      "Pool reuse must not duplicate error handlers",
    );
    assert.deepEqual(messages, [
      ["Poker database pool connection failed:", { code: "ECONNRESET" }],
    ]);
  } finally {
    console.error = savedError;
    await closeDatabase();
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  }
});
