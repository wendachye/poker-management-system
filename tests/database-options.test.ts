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
import { Client, type Pool } from "pg";
import { createReadinessService } from "../src/server/readiness";
import { testDatabase } from "./helpers/database";

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

test("throwing diagnostic accessors and revoked proxies cannot replace the original failure", () => {
  const messageGetter = new Error();
  Object.defineProperty(messageGetter, "message", {
    get() {
      throw new Error("private message getter");
    },
  });
  const codeGetter = {
    get code() {
      throw new Error("private code getter");
    },
  };
  const hasTrap = new Proxy(
    {},
    {
      has() {
        throw new Error("private has trap");
      },
    },
  );
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  for (const error of [messageGetter, codeGetter, hasTrap, revoked.proxy]) {
    assert.doesNotThrow(() => databasePoolErrorCode(error));
    assert.equal(databasePoolErrorCode(error), "UNKNOWN");
  }
});

function failurePool(
  failures: Record<string, Error> = {},
  verify?: () => void,
) {
  const queries: string[] = [];
  const releases: (boolean | undefined)[] = [];
  let connections = 0;
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
      connections++;
      return client;
    },
  };
  return {
    db: databaseFromPool(pool, verify),
    queries,
    releases,
    pool,
    connections: () => connections,
  };
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

test("guarded reads and transactions retain successful values and deterministic releases", async () => {
  const { db, queries, releases, connections } = failurePool({}, () => {});
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
  assert.equal(
    connections(),
    2,
    "Guarded direct queries must check their own acquired client",
  );
  assert.deepEqual(queries, ["SELECT $1", "BEGIN", "SELECT $1", "COMMIT"]);
  assert.deepEqual(releases, [undefined, undefined]);
});

test("a held guarded adapter rejects a changed identity before acquiring a client", async () => {
  const changed = new Error("Restart the application before continuing.");
  const { db, queries, releases, connections } = failurePool({}, () => {
    throw changed;
  });
  await assert.rejects(db.query("WRITE"), (error) => error === changed);
  await assert.rejects(
    db.transaction(async () => "not run"),
    (error) => error === changed,
  );
  assert.equal(connections(), 0);
  assert.deepEqual(queries, []);
  assert.deepEqual(releases, []);
});

test("an identity change while queued destroys checkout without beginning or executing SQL", async () => {
  for (const transactional of [false, true]) {
    let valid = true,
      queued!: () => void,
      releaseQueue!: () => void,
      workRan = false;
    const changed = new Error("Restart the application before continuing.");
    const acquired = new Promise<void>((resolve) => {
      queued = resolve;
    });
    const queue = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    const fixture = failurePool({}, () => {
      if (!valid) throw changed;
    });
    const connect = fixture.pool.connect;
    fixture.pool.connect = async () => {
      queued();
      await queue;
      return connect();
    };
    const request = transactional
      ? fixture.db.transaction(async (connection) => {
          workRan = true;
          await connection.query("WRITE");
        })
      : fixture.db.query("WRITE");
    await acquired;
    valid = false;
    releaseQueue();
    await assert.rejects(request, (error) => error === changed);
    assert.equal(workRan, false);
    assert.equal(fixture.connections(), 1);
    assert.deepEqual(fixture.queries, []);
    assert.deepEqual(fixture.releases, [true]);
  }
});

test("a changed transaction identity rolls back its original client and never commits", async () => {
  for (const beforeNextQuery of [false, true]) {
    let valid = true;
    const changed = new Error("Restart the application before continuing.");
    const { db, queries, releases } = failurePool({}, () => {
      if (!valid) throw changed;
    });
    await assert.rejects(
      db.transaction(async (connection) => {
        await connection.query("FIRST WRITE");
        valid = false;
        if (beforeNextQuery) await connection.query("SECOND WRITE");
        return "must not commit";
      }),
      (error) => error === changed,
    );
    assert.deepEqual(queries, ["BEGIN", "FIRST WRITE", "ROLLBACK"]);
    assert.deepEqual(releases, [true]);
  }
});

test("guarded failure cleanup preserves the original error and discards unusable clients", async () => {
  const original = new Error("Original identity failure");
  let valid = true;
  const transaction = failurePool(
    { ROLLBACK: new Error("Cleanup failed") },
    () => {
      if (!valid) throw original;
    },
  );
  await assert.rejects(
    transaction.db.transaction(async () => {
      valid = false;
    }),
    (error) => error === original,
  );
  assert.deepEqual(transaction.queries, ["BEGIN", "ROLLBACK"]);
  assert.deepEqual(transaction.releases, [true]);
  const queryFailure = new Error("Statement failed");
  const direct = failurePool({ WRITE: queryFailure }, () => {});
  await assert.rejects(
    direct.db.query("WRITE"),
    (error) => error === queryFailure,
  );
  assert.deepEqual(direct.releases, [true]);
  for (const stage of ["BEGIN", "COMMIT"]) {
    const error = new Error(stage + " failed");
    const fixture = failurePool({ [stage]: error }, () => {});
    await assert.rejects(
      fixture.db.transaction(async () => "not returned"),
      (value) => value === error,
    );
    assert.deepEqual(
      fixture.queries,
      stage === "BEGIN"
        ? ["BEGIN", "ROLLBACK"]
        : ["BEGIN", "COMMIT", "ROLLBACK"],
    );
    assert.deepEqual(fixture.releases, [undefined]);
  }
});

test("a saved application adapter cannot use changed PostgreSQL fallbacks or an untracked pool", async () => {
  const savedEnv = { ...process.env };
  const shared = globalThis as typeof globalThis & {
    pokerPool?: Pool;
    pokerPoolIdentity?: { pool: Pool; signature: string };
  };
  const constructedPorts: number[] = [];
  let ownedPool: Pool | undefined;
  class NoNetworkClient extends Client {
    constructor(...args: ConstructorParameters<typeof Client>) {
      super(...args);
      constructedPorts.push(this.port);
    }
  }
  Object.defineProperty(NoNetworkClient.prototype, "connect", {
    value(callback: (error: Error) => void) {
      queueMicrotask(() =>
        callback(new Error("Deliberate no-network test rejection")),
      );
    },
  });
  try {
    await closeDatabase();
    Object.assign(process.env, {
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://fixture:fictional@127.0.0.1/poker_test",
      PGPORT: "55491",
      POKER_PROTOTYPE_MODE: "0",
      NEXT_PUBLIC_POKER_PROTOTYPE: "0",
      PGOPTIONS: "",
    });
    const held = database();
    const pool = shared.pokerPool!;
    ownedPool = pool;
    (pool as Pool & { Client: typeof Client }).Client = NoNetworkClient;
    process.env.PGPORT = "55492";
    await assert.rejects(held.query("WRITE"), /Restart the application/);
    await assert.rejects(
      held.transaction(async () => "not run"),
      /Restart the application/,
    );
    assert.deepEqual(constructedPorts, []);
    process.env.PGPORT = "55491";
    for (const flag of [
      "POKER_PROTOTYPE_MODE",
      "NEXT_PUBLIC_POKER_PROTOTYPE",
    ]) {
      process.env[flag] = "1";
      await assert.rejects(held.query("WRITE"), /disabled.*prototype/);
      process.env[flag] = "0";
    }
    const tracked = shared.pokerPoolIdentity!;
    delete shared.pokerPoolIdentity;
    await assert.rejects(held.query("WRITE"), /Restart the application/);
    shared.pokerPoolIdentity = { ...tracked, pool: {} as Pool };
    await assert.rejects(held.query("WRITE"), /Restart the application/);
    shared.pokerPoolIdentity = tracked;
    shared.pokerPool = {} as Pool;
    await assert.rejects(held.query("WRITE"), /Restart the application/);
    shared.pokerPool = pool;
    assert.deepEqual(constructedPorts, []);
    await assert.rejects(held.query("READ"), /Deliberate no-network/);
    assert.deepEqual(
      constructedPorts,
      [55491],
      "Restored settings may construct only the original target; connect is stubbed",
    );
  } finally {
    if (ownedPool) shared.pokerPool = ownedPool;
    await closeDatabase();
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
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
    assert.equal(messages.length, 1);
    assert.equal(messages[0].length, 1);
    const event = JSON.parse(messages[0][0] as string);
    assert.equal(event.event, "database_pool_error");
    assert.equal(event.code, "ECONNRESET");
    assert.equal(new Date(event.timestamp).toISOString(), event.timestamp);
    assert.deepEqual(Object.keys(event).sort(), ["code", "event", "timestamp"]);
    assert.doesNotMatch(
      JSON.stringify(messages),
      /private-password|private-host/,
    );
    const hostile = {
      get code() {
        throw new Error("private diagnostic failure");
      },
    };
    assert.doesNotThrow(() => pool.emit("error", hostile));
    assert.equal(JSON.parse(messages[1][0] as string).code, "UNKNOWN");
    console.error = () => {
      throw new Error("private log sink failure");
    };
    assert.doesNotThrow(() => pool.emit("error", hostile));
  } finally {
    console.error = savedError;
    await closeDatabase();
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  }
});

test("pool reuse rejects changed inputs and untracked or replaced pools without silently retargeting", async () => {
  const savedEnv = { ...process.env };
  const shared = globalThis as typeof globalThis & {
    pokerPool?: Pool;
    pokerPoolIdentity?: { pool: Pool; signature: string };
  };
  try {
    await closeDatabase();
    Object.assign(process.env, {
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://fixture:fictional@127.0.0.1:1/poker_test",
      POKER_PROTOTYPE_MODE: "0",
      NEXT_PUBLIC_POKER_PROTOTYPE: "0",
      PGOPTIONS: "",
    });
    database();
    const pool = shared.pokerPool!;
    assert.equal(shared.pokerPoolIdentity?.pool, pool);
    assert.match(shared.pokerPoolIdentity!.signature, /^[a-f0-9]{64}$/);
    for (const [key, value] of [
      [
        "DATABASE_URL",
        "postgresql://other:private-password@127.0.0.1:2/poker_test_other",
      ],
      ["DATABASE_POOL_MAX", "7"],
      ["PGPORT", "55492"],
      ["PGPASSWORD", "private-new-password"],
      ["PGSSLNEGOTIATION", "direct"],
    ]) {
      const previous = process.env[key];
      process.env[key] = value;
      assert.throws(
        () => database(),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /Restart the application/);
          assert.doesNotMatch(error.message, /private|postgresql|55492/);
          return true;
        },
      );
      assert.equal(shared.pokerPool, pool);
      assert.equal(pool.totalCount, 0);
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
      assert.doesNotThrow(() => database());
    }
    const tracked = shared.pokerPoolIdentity!;
    delete shared.pokerPoolIdentity;
    assert.throws(
      () => database(),
      /existing pool cannot be verified.*Restart/,
    );
    shared.pokerPoolIdentity = { ...tracked, pool: {} as Pool };
    assert.throws(
      () => database(),
      /existing pool cannot be verified.*Restart/,
    );
    shared.pokerPoolIdentity = tracked;
    await closeDatabase();
    assert.equal(shared.pokerPool, undefined);
    assert.equal(shared.pokerPoolIdentity, undefined);
    process.env.DATABASE_URL =
      "postgresql://other:fictional@127.0.0.1:2/poker_test_other";
    assert.doesNotThrow(() => database());
    assert.notEqual(shared.pokerPool, pool);
    assert.equal(shared.pokerPool!.totalCount, 0);
  } finally {
    await closeDatabase();
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  }
});

test("first readiness cannot report a different runtime target healthy through an already initialized pool", async () => {
  const fixture = await testDatabase();
  const savedEnv = { ...process.env };
  const shared = globalThis as typeof globalThis & { pokerPool?: Pool };
  const originalError = console.error;
  let queries = 0;
  try {
    await closeDatabase();
    Object.assign(process.env, {
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://fixtureA:fictional@127.0.0.1:1/poker_test_A",
      POKER_PROTOTYPE_MODE: "0",
      NEXT_PUBLIC_POKER_PROTOTYPE: "0",
      PGOPTIONS: "",
    });
    database();
    const pool = shared.pokerPool!;
    // Represent an existing fully migrated target using a private memory fixture;
    // the guard must refuse reuse before this pool can answer any SQL.
    (pool as unknown as { query: typeof fixture.db.query }).query = async <T>(
      sql: string,
      values?: unknown[],
    ) => {
      queries++;
      return fixture.db.query<T>(sql, values);
    };
    process.env.DATABASE_URL =
      "postgresql://fixtureB:private-new-password@127.0.0.1:2/poker_test_B";
    console.error = () => {};
    const response = await createReadinessService()();
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      status: "unavailable",
      mode: "operations",
    });
    assert.equal(queries, 0);
    assert.equal(shared.pokerPool, pool);
    assert.equal(pool.totalCount, 0);
  } finally {
    console.error = originalError;
    await closeDatabase();
    await fixture.engine.close();
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  }
});
