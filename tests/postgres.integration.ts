import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { Pool } from "pg";
import { applyCommand, DomainError } from "../src/domain/operations";
import type { Staff } from "../src/domain/model";
import type { Command } from "../src/domain/commands";
import {
  changeBranch,
  hashPassword,
  login,
  logout,
  sessionUser,
} from "../src/server/auth";
import { createBackup, restoreBackup, type Backup } from "../src/server/backup";
import { databaseFromPool, type Database } from "../src/server/database";
import { databasePoolOptions } from "../src/server/database-options";
import { mutate, readSnapshot } from "../src/server/repository";
import { migrate, schemaMigrationStatus } from "../src/server/schema";
import { manageStaff } from "../src/server/staff";
import { createLocation } from "../src/server/locations";
import {
  CANCELLED_OPERATION_FINGERPRINT,
  recoverOperation,
} from "../src/server/operation-recovery";
import { configuredStore } from "./helpers/store";
import { replaceStore } from "../src/server/storage";
import { readCsv, readPage } from "../src/server/queries";
import { csvExportBusyDetails } from "../src/server/csv-export-work";
import {
  claimLoginAttempt,
  clearSuccessfulLoginAttempt,
} from "../src/server/login-admission";
import {
  manageOperatorAccount,
  type OperatorAccountCommand,
} from "../src/server/operator-accounts";
import { maintenancePoolOptions } from "../scripts/local-postgres-maintenance";
import {
  initializeNativeSamples,
  verifyNativeSamples,
  type NativeLocalSecrets,
} from "../scripts/local-postgres-setup";

function testDatabaseUrl(value: string | undefined) {
  const message =
    "POSTGRES_TEST_DATABASE_URL must explicitly name a loopback PostgreSQL database poker_test or poker_test_* without connection query overrides.";
  if (!value) throw new Error(message);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(message);
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    !/^\/poker_test(?:_[a-z0-9_]+)?$/.test(url.pathname) ||
    url.search ||
    url.hash
  )
    throw new Error(message);
  return { connectionString: value, database: url.pathname.slice(1) };
}

// Validate before constructing any pool. Never fall back to DATABASE_URL or .env.
const target = testDatabaseUrl(process.env.POSTGRES_TEST_DATABASE_URL);
const sourceSchema = `poker_test_${randomBytes(8).toString("hex")}`;
const restoredSchema = `poker_test_${randomBytes(8).toString("hex")}`;
const ownedSchemas = new Set([sourceSchema, restoredSchema]);
const createdSchemas = new Set<string>();
const pools: Pool[] = [];
const password = "postgres-integration-test-password";
let passwordHash = "";

function quotedSchema(schema: string) {
  assert.ok(
    ownedSchemas.has(schema) && /^poker_test_[a-f0-9]{16}$/.test(schema),
  );
  return `"${schema}"`;
}

function trackPool(pool: Pool) {
  // Unexpected idle-connection errors fail the test rather than terminating Node.
  pool.on("error", (error) => {
    const code =
      "code" in error && typeof error.code === "string"
        ? error.code
        : "UNKNOWN";
    assert.fail(`PostgreSQL test pool error: ${code}`);
  });
  pools.push(pool);
  return pool;
}

function poolFor(schema: string, budgets: Record<string, string> = {}) {
  assert.ok(schema === "pg_catalog" || ownedSchemas.has(schema));
  return trackPool(
    new Pool({
      connectionString: target.connectionString,
      ...databasePoolOptions({
        DATABASE_URL: target.connectionString,
        DATABASE_POOL_MAX: "1",
        DATABASE_STATEMENT_TIMEOUT_MS: "15000",
        DATABASE_LOCK_TIMEOUT_MS: "10000",
        DATABASE_IDLE_TRANSACTION_TIMEOUT_MS: "30000",
        ...budgets,
      }),
      options: `-c search_path=${schema}`,
      application_name: `poker-integration-${schema}`,
    }),
  );
}

function maintenancePoolForSource() {
  const options = maintenancePoolOptions(target.connectionString);
  return trackPool(
    new Pool({
      connectionString: target.connectionString,
      ...options,
      options: `${options.options} -c search_path=${sourceSchema}`,
      application_name: `poker-maintenance-integration-${sourceSchema}`,
    }),
  );
}

const administrator = poolFor("pg_catalog");
const firstPool = poolFor(sourceSchema);
const secondPool = poolFor(sourceSchema);
const lockPool = poolFor(sourceSchema);
const restoredPool = poolFor(restoredSchema);
const firstDb = databaseFromPool(firstPool);
const secondDb = databaseFromPool(secondPool);
const restoredDb = databaseFromPool(restoredPool);

before(async () => {
  assert.equal(
    (
      await administrator.query<{ name: string }>(
        "SELECT current_database() AS name",
      )
    ).rows[0].name,
    target.database,
  );
  for (const schema of ownedSchemas) {
    await administrator.query(`CREATE SCHEMA ${quotedSchema(schema)}`);
    createdSchemas.add(schema);
  }
  assert.equal(
    (await firstPool.query<{ name: string }>("SELECT current_schema() AS name"))
      .rows[0].name,
    sourceSchema,
  );
  await Promise.all([migrate(firstDb), migrate(secondDb), migrate(restoredDb)]);
  passwordHash = await hashPassword(password);
});

after(async () => {
  try {
    await Promise.all(
      pools.filter((pool) => pool !== administrator).map((pool) => pool.end()),
    );
    for (const schema of createdSchemas)
      await administrator.query(`DROP SCHEMA ${quotedSchema(schema)} CASCADE`);
  } finally {
    await administrator.end();
  }
});

async function fixture(db: Database = firstDb) {
  const branchId = `case_${randomBytes(6).toString("hex")}`;
  const users = {
    admin: `${branchId}_admin`,
    manager: `${branchId}_manager`,
    cashier: `${branchId}_cashier`,
  };
  await db.transaction(async (connection) => {
    await connection.query(
      "INSERT INTO poker_branches(id,name) VALUES($1,$1)",
      [branchId],
    );
    await replaceStore(connection, branchId, configuredStore());
    for (const [name, role] of [
      [users.admin, "ADMIN"],
      [users.manager, "MANAGER"],
      [users.cashier, "CASHIER"],
    ] as const) {
      await connection.query(
        "INSERT INTO poker_users(id,username,password_hash) VALUES($1,$1,$2)",
        [name, passwordHash],
      );
      await connection.query(
        "INSERT INTO poker_memberships(user_id,branch_id,role) VALUES($1,$2,$3)",
        [name, branchId, role],
      );
    }
  });
  const tokens = {
    admin: await login(db, users.admin, password),
    manager: await login(db, users.manager, password),
    cashier: await login(db, users.cashier, password),
  };
  return { branchId, users, tokens };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
function payload(branchId: string, revision: number, command: Command) {
  return { branchId, revision, operationId: randomUUID(), command };
}
async function execute(
  run: Fixture,
  command: Command,
  actor: keyof Fixture["tokens"] = "admin",
) {
  const before = await readSnapshot(firstDb, run.tokens[actor]);
  return mutate(
    firstDb,
    run.tokens[actor],
    payload(run.branchId, before.revision, command),
  );
}
const tableCommand = (name: string): Extract<Command, { kind: "TABLE" }> => ({
  kind: "TABLE",
  name,
  dealer: "",
  status: "OPEN",
});
function status(error: unknown, expected: number) {
  assert.ok(error instanceof DomainError);
  assert.equal(error.status, expected);
}
function sqlState(expected: string) {
  return (error: unknown) => {
    assert.ok(error && typeof error === "object" && "code" in error);
    assert.equal(error.code, expected);
    return true;
  };
}
async function backendPid(pool: Pool) {
  return (await pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
    .rows[0].pid;
}

async function waitForBlocked(waiter: number, holder: number) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const { rows } = await administrator.query<{ blocked: boolean }>(
      `WITH RECURSIVE blockers(pid) AS (
         SELECT unnest(pg_blocking_pids($2::int))
         UNION
         SELECT unnest(pg_blocking_pids(blockers.pid)) FROM blockers
       )
       SELECT EXISTS(SELECT 1 FROM blockers WHERE pid=$1::int)
       AND EXISTS(SELECT 1 FROM pg_locks WHERE pid=$2 AND NOT granted) AS blocked`,
      [holder, waiter],
    );
    if (rows[0].blocked) return;
  }
  assert.fail(
    "Expected the independent PostgreSQL connection to wait for the held row lock.",
  );
}

/** Queue both requests behind a real lock, then release them together. */
async function simultaneous<T>(
  branchId: string,
  actions: [() => Promise<T>, () => Promise<T>],
) {
  const holder = await lockPool.connect();
  let pending: Promise<PromiseSettledResult<T>[]> | undefined;
  let committed = false;
  try {
    await holder.query("BEGIN");
    await holder.query(
      "SELECT branch_id FROM poker_branch_state WHERE branch_id=$1 FOR UPDATE",
      [branchId],
    );
    const holderPid = (
      await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
    ).rows[0].pid;
    const [firstPid, secondPid] = await Promise.all([
      backendPid(firstPool),
      backendPid(secondPool),
    ]);
    assert.notEqual(firstPid, secondPid);
    pending = Promise.allSettled(actions.map((action) => action()));
    await Promise.all([
      waitForBlocked(firstPid, holderPid),
      waitForBlocked(secondPid, holderPid),
    ]);
    await holder.query("COMMIT");
    committed = true;
    return await pending;
  } finally {
    if (!committed) await holder.query("ROLLBACK");
    holder.release();
    if (pending) await pending;
  }
}

/** Establish actual lock wait order before releasing independent requests. */
async function orderedRecoveryRace(
  branchId: string,
  actions: [() => Promise<unknown>, () => Promise<unknown>],
) {
  const holder = await lockPool.connect();
  const pending: Promise<PromiseSettledResult<unknown>>[] = [];
  let committed = false;
  try {
    await holder.query("BEGIN");
    await holder.query(
      "SELECT branch_id FROM poker_branch_state WHERE branch_id=$1 FOR UPDATE",
      [branchId],
    );
    const holderPid = (
      await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
    ).rows[0].pid;
    const pids = await Promise.all([
      backendPid(firstPool),
      backendPid(secondPool),
    ]);
    assert.notEqual(pids[0], pids[1]);
    for (let index = 0; index < actions.length; index++) {
      pending.push(
        Promise.allSettled([actions[index]()]).then((results) => results[0]),
      );
      await waitForBlocked(pids[index], holderPid);
    }
    await holder.query("COMMIT");
    committed = true;
    return await Promise.all(pending);
  } finally {
    if (!committed) await holder.query("ROLLBACK");
    holder.release();
    await Promise.all(pending);
  }
}

/** Change the session only after an independent writer is waiting on the row. */
async function sessionChangeWhileBlocked<T>(
  branchId: string,
  action: () => Promise<T>,
  changeSession: () => Promise<void>,
) {
  const holder = await lockPool.connect();
  let pending: Promise<PromiseSettledResult<T>[]> | undefined;
  let committed = false;
  try {
    await holder.query("BEGIN");
    await holder.query(
      "SELECT branch_id FROM poker_branch_state WHERE branch_id=$1 FOR UPDATE",
      [branchId],
    );
    const holderPid = (
      await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
    ).rows[0].pid;
    const waiterPid = await backendPid(secondPool);
    pending = Promise.allSettled([action()]);
    await waitForBlocked(waiterPid, holderPid);
    await changeSession();
    await holder.query("COMMIT");
    committed = true;
    return (await pending)[0];
  } finally {
    if (!committed) await holder.query("ROLLBACK");
    holder.release();
    if (pending) await pending;
  }
}

test("independent migration runners serialize fresh bootstrap and record the baseline once", async () => {
  assert.deepEqual(await schemaMigrationStatus(firstDb), {
    ready: true,
    appliedVersion: 5,
    expectedVersion: 5,
  });
  const recorded = await firstDb.query<{ total: string }>(
    "SELECT count(*)::text AS total FROM poker_schema_migrations",
  );
  assert.equal(recorded.rows[0].total, "5");
});

test("PostgreSQL integration target guard rejects operational and overridden destinations", () => {
  for (const value of [
    undefined,
    "",
    "not a URL",
    "postgresql://example.com/poker_test",
    "postgresql://127.0.0.1/poker",
    "postgresql://127.0.0.1/postgres",
    "postgresql://127.0.0.1/poker_test?host=example.com",
    "postgresql://127.0.0.1/poker_test?dbname=poker",
    "postgresql://127.0.0.1/poker_test?options=-csearch_path=public",
    "postgresql://127.0.0.1/poker_test#anything",
  ])
    assert.throws(() => testDatabaseUrl(value), /POSTGRES_TEST_DATABASE_URL/);
  for (const value of [
    "postgresql://127.0.0.1/poker_test",
    "postgresql://localhost/poker_test_local",
    "postgresql://[::1]/poker_test_ci",
  ])
    assert.equal(testDatabaseUrl(value).connectionString, value);
});

test("two independent requests with the same operation identifier commit one mutation", async () => {
  const run = await fixture();
  const input = payload(run.branchId, 0, tableCommand("Idempotent table"));
  const results = await simultaneous(run.branchId, [
    () => mutate(firstDb, run.tokens.admin, input),
    () => mutate(secondDb, run.tokens.admin, input),
  ]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    2,
  );
  const snapshot = await readSnapshot(firstDb, run.tokens.admin);
  assert.equal(snapshot.revision, 1);
  assert.equal(snapshot.store.tables.length, 1);
  assert.equal(snapshot.store.auditLogs.length, 1);
  assert.equal(
    (
      await firstPool.query(
        "SELECT 1 FROM poker_operations WHERE branch_id=$1",
        [run.branchId],
      )
    ).rowCount,
    1,
  );
});

for (const writer of ["state", "staff", "location"] as const)
  for (const first of ["writer", "recovery"] as const)
    test(`PostgreSQL ${writer} recovery serializes ${first} first and resolves one immutable outcome`, async () => {
      const run = await fixture();
      const targetId = `recover-${randomBytes(6).toString("hex")}`;
      const reference = {
        branchId: run.branchId,
        actorId: run.users.admin,
        operationId: randomUUID(),
      };
      const input = {
        ...reference,
        revision: 0,
        command:
          writer === "state"
            ? tableCommand(targetId)
            : writer === "staff"
              ? {
                  kind: "STAFF_CREATE",
                  username: targetId,
                  password,
                  role: "CASHIER",
                  reason: "Fictional recovery race",
                }
              : {
                  kind: "CREATE_LOCATION",
                  id: targetId,
                  name: targetId,
                  timezone: "Asia/Kuala_Lumpur",
                },
      };
      const save = (db: Database) =>
        writer === "state"
          ? mutate(db, run.tokens.admin, input, { compact: true })
          : writer === "staff"
            ? manageStaff(db, run.tokens.admin, input, { compact: true })
            : createLocation(db, run.tokens.admin, input, { compact: true });
      const recover = (db: Database) =>
        recoverOperation(db, run.tokens.admin, reference);
      const before = await readSnapshot(firstDb, run.tokens.admin);
      const results = await orderedRecoveryRace(run.branchId, [
        () => (first === "writer" ? save(firstDb) : recover(firstDb)),
        () => (first === "writer" ? recover(secondDb) : save(secondDb)),
      ]);
      const resolved = await recover(secondDb);
      assert.deepEqual(await recover(firstDb), resolved);
      if (first === "writer") {
        assert.equal(results[0].status, "fulfilled");
        assert.equal(results[1].status, "fulfilled");
        assert.equal(resolved.status, "saved");
        if (results[0].status === "fulfilled")
          assert.deepEqual(resolved.snapshot, results[0].value);
        assert.equal(resolved.snapshot.revision, 1);
      } else {
        assert.equal(results[0].status, "fulfilled");
        assert.equal(results[1].status, "rejected");
        if (results[1].status === "rejected") {
          status(results[1].reason, 409);
          assert.match(results[1].reason.message, /cancelled during recovery/);
        }
        assert.equal(resolved.status, "cancelled");
        await assert.rejects(save(secondDb), /cancelled during recovery/);
        assert.deepEqual(await readSnapshot(firstDb, run.tokens.admin), before);
        assert.equal(
          (
            await firstDb.query(
              "SELECT id FROM poker_users WHERE username=$1",
              [targetId],
            )
          ).rows.length,
          0,
        );
        assert.equal(
          (
            await firstDb.query("SELECT id FROM poker_branches WHERE id=$1", [
              targetId,
            ])
          ).rows.length,
          0,
        );
      }
      const saved = (
        await firstDb.query<{ fingerprint: string }>(
          "SELECT fingerprint FROM poker_operations WHERE branch_id=$1 AND operation_id=$2",
          [run.branchId, reference.operationId],
        )
      ).rows;
      assert.equal(saved.length, 1);
      assert.equal(
        saved[0].fingerprint === CANCELLED_OPERATION_FINGERPRINT,
        first === "recovery",
      );
    });

for (const sessionChange of ["logout", "venue switch"] as const)
  test(`PostgreSQL recovery waiting on the writer lock refuses a committed ${sessionChange} without creating a tombstone`, async () => {
    const run = await fixture();
    const destination = await fixture();
    await firstDb.query(
      "INSERT INTO poker_memberships(user_id,branch_id,role) VALUES($1,$2,'ADMIN')",
      [run.users.admin, destination.branchId],
    );
    const reference = {
      branchId: run.branchId,
      actorId: run.users.admin,
      operationId: randomUUID(),
    };
    const result = await sessionChangeWhileBlocked(
      run.branchId,
      () => recoverOperation(secondDb, run.tokens.admin, reference),
      () =>
        sessionChange === "logout"
          ? logout(firstDb, run.tokens.admin)
          : changeBranch(firstDb, run.tokens.admin, destination.branchId),
    );
    assert.equal(result.status, "rejected");
    if (result.status === "rejected")
      status(result.reason, sessionChange === "logout" ? 401 : 409);
    assert.equal(
      (
        await firstDb.query(
          "SELECT operation_id FROM poker_operations WHERE branch_id=$1 AND operation_id=$2",
          [run.branchId, reference.operationId],
        )
      ).rows.length,
      0,
    );
    assert.equal((await readSnapshot(firstDb, run.tokens.manager)).revision, 0);
  });

test("simultaneous stale edits commit one change and return one 409 conflict", async () => {
  const run = await fixture();
  const created = await execute(run, tableCommand("Shared table"));
  const tableId = created.store.tables[0].id;
  const results = await simultaneous(run.branchId, [
    () =>
      mutate(
        firstDb,
        run.tokens.admin,
        payload(run.branchId, created.revision, {
          ...tableCommand("First candidate"),
          tableId,
        }),
      ),
    () =>
      mutate(
        secondDb,
        run.tokens.admin,
        payload(run.branchId, created.revision, {
          ...tableCommand("Second candidate"),
          tableId,
        }),
      ),
  ]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const rejected = results.find((result) => result.status === "rejected");
  assert.ok(rejected?.status === "rejected");
  status(rejected.reason, 409);
  const snapshot = await readSnapshot(firstDb, run.tokens.admin);
  assert.equal(snapshot.revision, created.revision + 1);
  assert.equal(snapshot.store.tables.length, 1);
});

test("independent PostgreSQL writers save different tables from one reviewed revision", async () => {
  const run = await fixture();
  await execute(run, tableCommand("First table"));
  const before = await execute(run, tableCommand("Second table"));
  const results = await simultaneous(run.branchId, [
    () =>
      mutate(
        firstDb,
        run.tokens.admin,
        payload(run.branchId, before.revision, {
          ...tableCommand("First updated"),
          tableId: before.store.tables[0].id,
        }),
      ),
    () =>
      mutate(
        secondDb,
        run.tokens.manager,
        payload(run.branchId, before.revision, {
          ...tableCommand("Second updated"),
          tableId: before.store.tables[1].id,
        }),
      ),
  ]);
  assert.equal(
    results.filter((value) => value.status === "fulfilled").length,
    2,
  );
  const after = await readSnapshot(firstDb, run.tokens.admin);
  assert.equal(after.revision, before.revision + 2);
  assert.deepEqual(
    after.store.tables.map((value) => value.name),
    ["First updated", "Second updated"],
  );
});

test("concurrent independent approvals cannot post the same request twice", async () => {
  const run = await fixture();
  const table = await execute(run, tableCommand("Approval table"));
  await execute(run, { kind: "OPEN_DAY", date: "2026-10-28", openingCash: 0 });
  const requested = await execute(
    run,
    {
      kind: "REQUEST",
      type: "Rake",
      amount: 5000,
      tableId: table.store.tables[0].id,
      note: "Concurrent approval test",
    },
    "cashier",
  );
  const approvalId = requested.store.approvals[0].id;
  const command: Command = { kind: "DECIDE", approvalId, decision: "APPROVED" };
  const results = await simultaneous(run.branchId, [
    () =>
      mutate(
        firstDb,
        run.tokens.manager,
        payload(run.branchId, requested.revision, command),
      ),
    () =>
      mutate(
        secondDb,
        run.tokens.admin,
        payload(run.branchId, requested.revision, command),
      ),
  ]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const rejected = results.find((result) => result.status === "rejected");
  assert.ok(rejected?.status === "rejected");
  status(rejected.reason, 409);
  const snapshot = await readSnapshot(firstDb, run.tokens.admin);
  assert.equal(snapshot.revision, requested.revision + 1);
  assert.equal(snapshot.store.approvals[0].status, "APPROVED");
  assert.equal(snapshot.store.approvals[0].votes.length, 1);
  assert.equal(snapshot.store.transactions.length, 1);
  assert.equal(snapshot.store.transactions[0].approvalId, approvalId);
  assert.equal(snapshot.store.transactions[0].cashReceived, 5000);
});

test("independent PostgreSQL credit reservations from one reviewed balance cannot overcommit it", async () => {
  const run = await fixture();
  const table = await execute(run, tableCommand("Credit reservation table"));
  const tableId = table.store.tables[0].id;
  await execute(run, { kind: "OPEN_DAY", date: "2026-10-28", openingCash: 0 });
  const checked = await execute(run, {
    kind: "CHECK_IN",
    name: "Concurrent credit",
    phone: "+12025550901",
    type: "CREDIT",
    creditLimit: 100_000,
    tags: [],
    tableId,
    seat: 1,
  });
  const playerId = checked.store.profiles[0].id;
  const command: Command = {
    kind: "REQUEST",
    type: "Buy-in",
    playerId,
    amount: 60_000,
    note: "Competing credit reservation",
  };
  const result = await simultaneous(run.branchId, [
    () =>
      mutate(
        firstDb,
        run.tokens.cashier,
        payload(run.branchId, checked.revision, command),
      ),
    () =>
      mutate(
        secondDb,
        run.tokens.manager,
        payload(run.branchId, checked.revision, command),
      ),
  ]);
  assert.equal(
    result.filter((value) => value.status === "fulfilled").length,
    1,
  );
  const rejected = result.find((value) => value.status === "rejected");
  assert.ok(rejected?.status === "rejected");
  status(rejected.reason, 409);
  const after = await readSnapshot(firstDb, run.tokens.admin);
  assert.equal(
    after.store.approvals
      .filter((value) => value.status === "PENDING")
      .reduce((sum, value) => sum + value.amount, 0),
    60_000,
  );
  assert.equal(after.store.transactions.length, 0);
});

test("independent PostgreSQL approvals for different players both post from one reviewed revision", async () => {
  const run = await fixture();
  const table = await execute(run, tableCommand("Independent approvals"));
  const tableId = table.store.tables[0].id;
  await execute(run, { kind: "OPEN_DAY", date: "2026-10-28", openingCash: 0 });
  const approvalIds: string[] = [];
  for (let seat = 1; seat <= 2; seat++) {
    const checked = await execute(run, {
      kind: "CHECK_IN",
      name: `Cash player ${seat}`,
      phone: `+1202555080${seat}`,
      type: "CASH",
      creditLimit: 0,
      tags: [],
      tableId,
      seat,
    });
    const playerId = checked.store.profiles.at(-1)!.id;
    const request = await execute(
      run,
      {
        kind: "REQUEST",
        type: "Buy-in",
        playerId,
        amount: 50_000,
        note: "Independent cash request",
      },
      "cashier",
    );
    approvalIds.push(request.store.approvals[0].id);
  }
  const before = await readSnapshot(firstDb, run.tokens.admin);
  const results = await simultaneous(run.branchId, [
    () =>
      mutate(
        firstDb,
        run.tokens.manager,
        payload(run.branchId, before.revision, {
          kind: "DECIDE",
          approvalId: approvalIds[0],
          decision: "APPROVED",
        }),
      ),
    () =>
      mutate(
        secondDb,
        run.tokens.admin,
        payload(run.branchId, before.revision, {
          kind: "DECIDE",
          approvalId: approvalIds[1],
          decision: "APPROVED",
        }),
      ),
  ]);
  assert.equal(
    results.filter((value) => value.status === "fulfilled").length,
    2,
  );
  const after = await readSnapshot(firstDb, run.tokens.admin);
  assert.equal(after.revision, before.revision + 2);
  assert.equal(after.store.transactions.length, 2);
  assert.equal(
    after.store.transactions.reduce(
      (sum, value) => sum + value.cashReceived,
      0,
    ),
    100_000,
  );
  assert.equal(
    after.store.approvals.every((value) => value.status === "APPROVED"),
    true,
  );
});

test("a request waiting for a row lock rechecks revoked authentication before writing", async () => {
  const run = await fixture();
  const holder = await lockPool.connect();
  let pending: Promise<PromiseSettledResult<unknown>[]> | undefined;
  let committed = false;
  try {
    await holder.query("BEGIN");
    await holder.query(
      "SELECT branch_id FROM poker_branch_state WHERE branch_id=$1 FOR UPDATE",
      [run.branchId],
    );
    const holderPid = (
      await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
    ).rows[0].pid;
    const waiterPid = await backendPid(secondPool);
    pending = Promise.allSettled([
      mutate(
        secondDb,
        run.tokens.manager,
        payload(run.branchId, 0, tableCommand("Must not be saved")),
      ),
    ]);
    await waitForBlocked(waiterPid, holderPid);
    await holder.query("UPDATE poker_users SET active=false WHERE id=$1", [
      run.users.manager,
    ]);
    await holder.query("DELETE FROM poker_sessions WHERE user_id=$1", [
      run.users.manager,
    ]);
    await holder.query("COMMIT");
    committed = true;
    const [result] = await pending;
    assert.equal(result.status, "rejected");
    if (result.status === "rejected") status(result.reason, 401);
    const snapshot = await readSnapshot(firstDb, run.tokens.admin);
    assert.equal(snapshot.revision, 0);
    assert.equal(snapshot.store.tables.length, 0);
    assert.equal(snapshot.store.auditLogs.length, 0);
  } finally {
    if (!committed) await holder.query("ROLLBACK");
    holder.release();
    if (pending) await pending;
  }
});

for (const operationType of ["staff", "location"] as const)
  for (const sessionChange of ["logout", "venue switch"] as const)
    test(`${operationType} creation waiting for a venue lock rejects a committed ${sessionChange}`, async () => {
      const run = await fixture();
      const destination = await fixture();
      await firstDb.query(
        "INSERT INTO poker_memberships(user_id,branch_id,role) VALUES($1,$2,'ADMIN')",
        [run.users.admin, destination.branchId],
      );
      const targetId = `queued-${randomBytes(6).toString("hex")}`;
      const operationId = randomUUID();
      const input = {
        branchId: run.branchId,
        revision: 0,
        operationId,
        command:
          operationType === "staff"
            ? {
                kind: "STAFF_CREATE",
                username: targetId,
                password,
                role: "CASHIER",
                reason: "Must not survive a session change while waiting",
              }
            : {
                kind: "CREATE_LOCATION",
                id: targetId,
                name: "Must not be created after a session change",
                timezone: "Asia/Kuala_Lumpur",
              },
      };
      const result = await sessionChangeWhileBlocked(
        run.branchId,
        () =>
          operationType === "staff"
            ? manageStaff(secondDb, run.tokens.admin, input)
            : createLocation(secondDb, run.tokens.admin, input),
        () =>
          sessionChange === "logout"
            ? logout(firstDb, run.tokens.admin)
            : changeBranch(firstDb, run.tokens.admin, destination.branchId),
      );
      assert.equal(result.status, "rejected");
      if (result.status === "rejected")
        status(result.reason, sessionChange === "logout" ? 401 : 409);
      assert.equal(
        (
          await firstDb.query("SELECT id FROM poker_users WHERE username=$1", [
            targetId,
          ])
        ).rows.length,
        0,
      );
      assert.equal(
        (
          await firstDb.query("SELECT id FROM poker_branches WHERE id=$1", [
            targetId,
          ])
        ).rows.length,
        0,
      );
      const source = await readSnapshot(firstDb, run.tokens.manager);
      assert.equal(source.revision, 0);
      assert.equal(source.store.auditLogs.length, 0);
      assert.equal(
        (
          await firstDb.query(
            "SELECT operation_id FROM poker_operations WHERE branch_id=$1 AND operation_id=$2",
            [run.branchId, operationId],
          )
        ).rows.length,
        0,
      );
      const actor = await sessionUser(firstDb, run.tokens.admin);
      if (sessionChange === "logout") assert.equal(actor, null);
      else assert.equal(actor?.branchId, destination.branchId);
    });

test("server lock timeouts roll back the request and the connection remains usable", async () => {
  const run = await fixture();
  const timedPool = poolFor(sourceSchema, {
    DATABASE_LOCK_TIMEOUT_MS: "100",
    DATABASE_STATEMENT_TIMEOUT_MS: "1000",
  });
  const timedDb = databaseFromPool(timedPool);
  const holder = await lockPool.connect();
  try {
    await holder.query("BEGIN");
    await holder.query(
      "SELECT branch_id FROM poker_branch_state WHERE branch_id=$1 FOR UPDATE",
      [run.branchId],
    );
    await assert.rejects(
      mutate(
        timedDb,
        run.tokens.admin,
        payload(run.branchId, 0, tableCommand("Timed out")),
      ),
      sqlState("55P03"),
    );
  } finally {
    await holder.query("ROLLBACK");
    holder.release();
  }
  assert.equal(
    (await timedDb.query<{ value: number }>("SELECT 42 AS value")).rows[0]
      .value,
    42,
  );
  assert.equal((await readSnapshot(firstDb, run.tokens.admin)).revision, 0);
  assert.equal(
    (await readSnapshot(firstDb, run.tokens.admin)).store.tables.length,
    0,
  );
});

test("server statement timeouts cancel work and allow a subsequent transaction", async () => {
  const timedPool = poolFor(sourceSchema, {
    DATABASE_LOCK_TIMEOUT_MS: "100",
    DATABASE_STATEMENT_TIMEOUT_MS: "200",
  });
  const db = databaseFromPool(timedPool);
  assert.equal(
    (await db.query<{ statement_timeout: string }>("SHOW statement_timeout"))
      .rows[0].statement_timeout,
    "200ms",
  );
  await assert.rejects(
    db.transaction((connection) => connection.query("SELECT pg_sleep(1)")),
    sqlState("57014"),
  );
  const next = await db.transaction((connection) =>
    connection.query<{ value: number }>("SELECT 42 AS value"),
  );
  assert.equal(next.rows[0].value, 42);
});

/** The fallback releases only this test's holder. If the maintenance timeout
 * regresses, assertions fail safely instead of waiting for its full statement
 * budget. The same rollback promise is observed and drained in finally.
 */
async function withMaintenanceBarrier(sql: string, work: () => Promise<void>) {
  const holder = await lockPool.connect();
  let fallback: ReturnType<typeof setTimeout> | undefined;
  let releasing: Promise<unknown> | undefined;
  const release = () => (releasing ??= holder.query("ROLLBACK"));
  try {
    await holder.query("BEGIN");
    await holder.query(sql);
    fallback = setTimeout(() => {
      void release().catch(() => {});
    }, 7000);
    await work();
  } finally {
    clearTimeout(fallback);
    try {
      await release();
    } finally {
      holder.release();
    }
  }
}

async function assertMaintenanceIdle(pid: number) {
  const state = (
    await administrator.query<{ state: string; xact_start: Date | null }>(
      "SELECT state,xact_start FROM pg_stat_activity WHERE pid=$1",
      [pid],
    )
  ).rows[0];
  assert.equal(state.state, "idle");
  assert.equal(state.xact_start, null);
}

test(
  "native maintenance budgets stop an initializer lock wait before any native role or schema work",
  { timeout: 20_000 },
  async () => {
    await fixture();
    const before = await createBackup(firstDb);
    const pool = maintenancePoolForSource();
    const db = databaseFromPool(pool);
    assert.equal(
      (await db.query<{ statement_timeout: string }>("SHOW statement_timeout"))
        .rows[0].statement_timeout,
      "1min",
    );
    assert.equal(
      (await db.query<{ lock_timeout: string }>("SHOW lock_timeout")).rows[0]
        .lock_timeout,
      "5s",
    );
    assert.equal(
      (
        await db.query<{ idle_in_transaction_session_timeout: string }>(
          "SHOW idle_in_transaction_session_timeout",
        )
      ).rows[0].idle_in_transaction_session_timeout,
      "15s",
    );
    const pid = await backendPid(pool);
    const advisorySql = "SELECT pg_advisory_xact_lock(1886350181, 8)";
    const identitySql =
      "SELECT current_database() AS database,current_setting('server_version_num') AS version";
    let advisorySucceeded = false;
    const guarded: Database = {
      async query() {
        throw new Error("Initializer must use the guarded transaction.");
      },
      transaction: (work) =>
        db.transaction((connection) =>
          work({
            async query<T>(sql: string, values?: unknown[]) {
              assert.ok(
                sql === identitySql || sql === advisorySql,
                "Only the initializer identity and advisory-lock probes may execute in this fixture.",
              );
              const result = await connection.query<T>(sql, values);
              if (sql === advisorySql) {
                advisorySucceeded = true;
                throw new Error(
                  "Stop after the advisory lock; native role and schema setup is forbidden in this fixture.",
                );
              }
              return result;
            },
          }),
        ),
    };
    const secrets: NativeLocalSecrets = {
      version: 1,
      workspace: randomBytes(6).toString("hex"),
      bootstrapPassword: randomBytes(32).toString("hex"),
      ownerPassword: randomBytes(32).toString("hex"),
      appPassword: randomBytes(32).toString("hex"),
    };
    await withMaintenanceBarrier(advisorySql, async () => {
      const started = performance.now();
      await assert.rejects(
        initializeNativeSamples(guarded, secrets, new Date(), target.database),
        sqlState("55P03"),
      );
      assert.ok(
        performance.now() - started >= 4000,
        "The real five-second server lock budget must be exercised.",
      );
      assert.equal(advisorySucceeded, false);
      await assertMaintenanceIdle(pid);
      assert.equal(
        (await db.query<{ value: number }>("SELECT 42 AS value")).rows[0].value,
        42,
      );
    });
    const after = await createBackup(firstDb);
    assert.deepEqual(
      { ...after.payload, createdAt: "" },
      { ...before.payload, createdAt: "" },
    );
  },
);

test(
  "native integrity maintenance times out on a blocked source table and recovers after rollback",
  { timeout: 20_000 },
  async () => {
    await fixture();
    const before = await createBackup(firstDb);
    const pool = maintenancePoolForSource();
    const db = databaseFromPool(pool);
    const pid = await backendPid(pool);
    await withMaintenanceBarrier(
      `LOCK TABLE ${quotedSchema(sourceSchema)}.poker_profiles IN ACCESS EXCLUSIVE MODE`,
      async () => {
        const started = performance.now();
        await assert.rejects(verifyNativeSamples(db), sqlState("55P03"));
        assert.ok(
          performance.now() - started >= 4000,
          "The source-table lock must exercise the real maintenance budget.",
        );
        await assertMaintenanceIdle(pid);
        assert.equal(
          (await db.query<{ value: number }>("SELECT 42 AS value")).rows[0]
            .value,
          42,
        );
      },
    );
    const verified = await verifyNativeSamples(db);
    assert.ok(verified.venueCount > 0);
    const after = await createBackup(firstDb);
    assert.deepEqual(
      { ...after.payload, createdAt: "" },
      { ...before.payload, createdAt: "" },
    );
  },
);

test("a transaction failure rolls every preceding write back", async () => {
  const branchId = `rollback_${randomBytes(6).toString("hex")}`;
  await assert.rejects(
    firstDb.transaction(async (connection) => {
      await connection.query(
        "INSERT INTO poker_branches(id,name) VALUES($1,$1)",
        [branchId],
      );
      await connection.query("SELECT 1/0");
    }),
    sqlState("22012"),
  );
  assert.equal(
    (
      await firstDb.query("SELECT id FROM poker_branches WHERE id=$1", [
        branchId,
      ])
    ).rows.length,
    0,
  );
  assert.equal(
    (await firstDb.query<{ value: number }>("SELECT 42 AS value")).rows[0]
      .value,
    42,
  );
});

test("a full backup restores into a second isolated schema without changing its source", async () => {
  const source = await fixture();
  const originalInput = payload(
    source.branchId,
    0,
    tableCommand("Backup source table"),
  );
  await mutate(firstDb, source.tokens.admin, originalInput);
  const backup = await createBackup(firstDb);
  const destination = await fixture(restoredDb);
  let safetyBackup: Backup | undefined;
  await restoreBackup(restoredDb, backup, async (beforeRestore) => {
    safetyBackup = beforeRestore;
  });
  assert.ok(
    safetyBackup?.payload.branches.some(
      (branch) => branch.id === destination.branchId,
    ),
  );
  const restored = await createBackup(restoredDb);
  assert.deepEqual(
    { ...restored.payload, createdAt: "" },
    { ...backup.payload, createdAt: "" },
  );
  const sourceAfter = await createBackup(firstDb);
  assert.deepEqual(
    { ...sourceAfter.payload, createdAt: "" },
    { ...backup.payload, createdAt: "" },
  );
  assert.ok(await sessionUser(firstDb, source.tokens.admin));
  assert.equal(await sessionUser(restoredDb, destination.tokens.admin), null);
  const restoredToken = await login(restoredDb, source.users.admin, password);
  const retried = await mutate(restoredDb, restoredToken, originalInput);
  assert.equal(retried.revision, 1);
  assert.equal(retried.store.tables.length, 1);
  assert.equal(
    (await readSnapshot(firstDb, source.tokens.admin)).store.tables.length,
    1,
  );
});

function operatorInput(command: OperatorAccountCommand) {
  return {
    operationId: randomUUID(),
    operator: "Native security test operator",
    reason: "Fictional account safeguard verification",
    command,
  };
}

test("login quotas are atomic across independent connections and preserve newer failures", async () => {
  const run = await fixture();
  try {
    await firstDb.query(
      `INSERT INTO poker_login_budget(id,attempts,window_start) VALUES(1,119,now())
      ON CONFLICT(id) DO UPDATE SET attempts=119,window_start=now()`,
    );
    const globalClaims = await Promise.allSettled([
      claimLoginAttempt(firstDb, "fictional-missing-a"),
      claimLoginAttempt(secondDb, "fictional-missing-b"),
    ]);
    assert.equal(
      globalClaims.filter((result) => result.status === "fulfilled").length,
      1,
    );
    for (const result of globalClaims)
      if (result.status === "rejected") status(result.reason, 429);
    assert.equal(
      (
        await firstDb.query<{ attempts: number }>(
          "SELECT attempts FROM poker_login_budget WHERE id=1",
        )
      ).rows[0].attempts,
      121,
    );
    await firstDb.query(
      "UPDATE poker_login_budget SET window_start=now()-interval '61 seconds' WHERE id=1",
    );
    await claimLoginAttempt(firstDb, "fictional-after-window");
    assert.equal(
      (
        await firstDb.query<{ attempts: number }>(
          "SELECT attempts FROM poker_login_budget WHERE id=1",
        )
      ).rows[0].attempts,
      1,
    );

    await firstDb.query(
      `INSERT INTO poker_login_attempts(username,attempts,window_start) VALUES($1,9,now())
      ON CONFLICT(username) DO UPDATE SET attempts=9,window_start=now()`,
      [run.users.cashier],
    );
    const accountClaims = await Promise.allSettled([
      claimLoginAttempt(firstDb, run.users.cashier),
      claimLoginAttempt(secondDb, run.users.cashier),
    ]);
    const accepted = accountClaims.filter(
      (result) => result.status === "fulfilled",
    );
    assert.equal(accepted.length, 1);
    assert.ok(accepted[0].status === "fulfilled" && accepted[0].value);
    for (const result of accountClaims)
      if (result.status === "rejected") status(result.reason, 429);
    await clearSuccessfulLoginAttempt(firstDb, accepted[0].value);
    assert.equal(
      (
        await firstDb.query<{ attempts: number }>(
          "SELECT attempts FROM poker_login_attempts WHERE username=$1",
          [run.users.cashier],
        )
      ).rows[0].attempts,
      11,
      "An earlier success cannot erase a newer concurrent failed attempt",
    );
    const before = (
      await firstDb.query<{ attempts: number }>(
        "SELECT attempts FROM poker_login_budget WHERE id=1",
      )
    ).rows[0].attempts;
    await login(secondDb, run.users.manager, password);
    assert.equal(
      (
        await firstDb.query<{ attempts: number }>(
          "SELECT attempts FROM poker_login_budget WHERE id=1",
        )
      ).rows[0].attempts,
      before + 1,
      "A valid password must not reset the shared global budget",
    );
  } finally {
    await firstDb.query(
      "UPDATE poker_login_budget SET attempts=0,window_start=now() WHERE id=1",
    );
  }
});

test("competing operator disables cannot remove both remaining venue admins", async () => {
  const run = await fixture();
  await firstDb.query(
    "UPDATE poker_memberships SET role='ADMIN' WHERE user_id=$1 AND branch_id=$2",
    [run.users.manager, run.branchId],
  );
  const outcomes = await simultaneous(run.branchId, [
    () =>
      manageOperatorAccount(
        firstDb,
        operatorInput({ kind: "DISABLE", username: run.users.admin }),
      ),
    () =>
      manageOperatorAccount(
        secondDb,
        operatorInput({ kind: "DISABLE", username: run.users.manager }),
      ),
  ]);
  assert.equal(
    outcomes.filter((result) => result.status === "fulfilled").length,
    1,
  );
  for (const result of outcomes)
    if (result.status === "rejected") status(result.reason, 409);
  const accounts = (
    await firstDb.query<{ username: string; active: boolean }>(
      `SELECT u.username,u.active FROM poker_users u JOIN poker_memberships m ON m.user_id=u.id
    WHERE m.branch_id=$1 AND m.role='ADMIN' ORDER BY u.username`,
      [run.branchId],
    )
  ).rows;
  assert.equal(accounts.filter((account) => account.active).length, 1);
  const tokens = new Map([
    [run.users.admin, run.tokens.admin],
    [run.users.manager, run.tokens.manager],
  ]);
  for (const account of accounts)
    assert.equal(
      Boolean(await sessionUser(firstDb, tokens.get(account.username))),
      account.active,
    );
  assert.equal(
    (
      await firstDb.query<{ revision: number }>(
        "SELECT revision FROM poker_branch_state WHERE branch_id=$1",
        [run.branchId],
      )
    ).rows[0].revision,
    1,
  );
  assert.equal(
    (
      await firstDb.query<{ total: string }>(
        "SELECT count(*)::text AS total FROM poker_audit WHERE branch_id=$1",
        [run.branchId],
      )
    ).rows[0].total,
    "1",
  );
});

test("UI and operator account changes share the same last-admin serialization", async () => {
  const run = await fixture();
  await firstDb.query(
    "UPDATE poker_memberships SET role='ADMIN' WHERE user_id=$1 AND branch_id=$2",
    [run.users.manager, run.branchId],
  );
  const outcomes = await simultaneous<unknown>(run.branchId, [
    () =>
      manageStaff(firstDb, run.tokens.admin, {
        branchId: run.branchId,
        actorId: run.users.admin,
        revision: 0,
        operationId: randomUUID(),
        command: {
          kind: "STAFF_DISABLE",
          userId: run.users.manager,
          reason: "Fictional competing UI disable",
        },
      }),
    () =>
      manageOperatorAccount(
        secondDb,
        operatorInput({ kind: "DISABLE", username: run.users.admin }),
      ),
  ]);
  assert.equal(
    outcomes.filter((result) => result.status === "fulfilled").length,
    1,
  );
  for (const result of outcomes)
    if (result.status === "rejected") {
      assert.ok(result.reason instanceof DomainError);
      assert.ok([401, 409].includes(result.reason.status));
    }
  assert.equal(
    (
      await firstDb.query<{ total: string }>(
        `SELECT count(*)::text AS total FROM poker_users u JOIN poker_memberships m ON m.user_id=u.id
    WHERE m.branch_id=$1 AND m.role='ADMIN' AND u.active=true`,
        [run.branchId],
      )
    ).rows[0].total,
    "1",
  );
  assert.equal(
    (
      await firstDb.query<{ total: string }>(
        "SELECT count(*)::text AS total FROM poker_audit WHERE branch_id=$1",
        [run.branchId],
      )
    ).rows[0].total,
    "1",
  );
});

test("global disable and local demotion protect a shared admin's other venue", async () => {
  const first = await fixture();
  const other = await fixture();
  await firstDb.query(
    "UPDATE poker_memberships SET role='ADMIN' WHERE user_id=$1 AND branch_id=$2",
    [first.users.manager, first.branchId],
  );
  await firstDb.query(
    "UPDATE poker_memberships SET role='CASHIER' WHERE user_id=$1 AND branch_id=$2",
    [other.users.admin, other.branchId],
  );
  await firstDb.query(
    "INSERT INTO poker_memberships(user_id,branch_id,role) VALUES($1,$2,'ADMIN')",
    [first.users.admin, other.branchId],
  );
  for (const command of [
    { kind: "DISABLE", username: first.users.admin },
    {
      kind: "GRANT",
      username: first.users.admin,
      branchId: other.branchId,
      role: "MANAGER",
    },
  ] as OperatorAccountCommand[]) {
    await assert.rejects(
      manageOperatorAccount(secondDb, operatorInput(command)),
      (error: unknown) => {
        status(error, 409);
        return true;
      },
    );
  }
  assert.ok(await sessionUser(firstDb, first.tokens.admin));
  const states = (
    await firstDb.query<{ revision: number }>(
      "SELECT revision FROM poker_branch_state WHERE branch_id=ANY($1::text[])",
      [[first.branchId, other.branchId]],
    )
  ).rows;
  assert.deepEqual(
    states.map((row) => row.revision),
    [0, 0],
  );
  assert.equal(
    (
      await firstDb.query<{ total: string }>(
        "SELECT count(*)::text AS total FROM poker_audit WHERE branch_id=ANY($1::text[])",
        [[first.branchId, other.branchId]],
      )
    ).rows[0].total,
    "0",
  );
});

test("a cancelled JSON read drains queued checkout without application SQL and leaves staff saves available", async () => {
  const run = await fixture();
  const held = await firstPool.connect();
  const statements: string[] = [];
  let released = false;
  const observed = databaseFromPool({
    query: (sql, values) => firstPool.query(sql, values),
    async connect() {
      const client = await firstPool.connect();
      return {
        query(sql: string, values?: unknown[]) {
          statements.push(sql);
          return client.query(sql, values);
        },
        release(destroy?: boolean) {
          released = true;
          client.release(destroy);
        },
      };
    },
  });
  const controller = new AbortController();
  let finished = false;
  const reading = readPage(
    observed,
    run.tokens.admin,
    { resource: "players" },
    controller.signal,
  ).finally(() => {
    finished = true;
  });
  void reading.catch(() => {});
  let heldOpen = true;
  try {
    const deadline = Date.now() + 2000;
    while (firstPool.waitingCount === 0 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(firstPool.waitingCount, 1);
    controller.abort(new Error("private cancelled lookup"));
    assert.equal(
      finished,
      false,
      "A queued checkout must actually settle before returning",
    );
    const before = await readSnapshot(secondDb, run.tokens.admin);
    const saved = await mutate(
      secondDb,
      run.tokens.admin,
      payload(
        run.branchId,
        before.revision,
        tableCommand("Available while lookup checkout waits"),
      ),
    );
    held.release();
    heldOpen = false;
    await assert.rejects(reading, (error) => {
      status(error, 408);
      assert.equal((error as Error).message, "Cannot load records.");
      return true;
    });
    assert.deepEqual(statements, ["BEGIN", "ROLLBACK"]);
    assert.equal(released, true);
    assert.equal(firstPool.waitingCount, 0);
    const page = await readPage(firstDb, run.tokens.admin, {
      resource: "players",
    });
    assert.equal(page.context.branch.id, run.branchId);
    assert.equal(page.context.revision, saved.revision);
    assert.equal(page.total, 0);
    assert.equal(
      page.context.store.tables[0].name,
      "Available while lookup checkout waits",
    );
    assert.deepEqual(
      (await readSnapshot(secondDb, run.tokens.admin)).store,
      saved.store,
    );
  } finally {
    controller.abort();
    if (heldOpen) held.release();
    await reading.catch(() => {});
  }
});

test("a cancelled JSON authentication query drains real SQL and rollback before releasing its connection", async () => {
  const run = await fixture();
  const holder = await lockPool.connect();
  const lock = 7_318_292;
  const statements: string[] = [];
  let releaseRollback!: () => void;
  const allowRollback = new Promise<void>((resolve) => {
    releaseRollback = resolve;
  });
  let rollbackStarted!: () => void;
  const rollingBack = new Promise<void>((resolve) => {
    rollbackStarted = resolve;
  });
  let released = false;
  let blocked = false;
  const observed = databaseFromPool({
    query: (sql, values) => firstPool.query(sql, values),
    async connect() {
      const client = await firstPool.connect();
      return {
        async query(sql: string, values?: unknown[]) {
          statements.push(sql);
          if (sql === "ROLLBACK") {
            rollbackStarted();
            await allowRollback;
          }
          const result = await client.query(sql, values);
          if (sql.includes("FROM poker_sessions s")) {
            blocked = true;
            await client.query("SELECT pg_advisory_xact_lock($1)", [lock]);
          }
          return result;
        },
        release(destroy?: boolean) {
          released = true;
          client.release(destroy);
        },
      };
    },
  });
  const controller = new AbortController();
  let reading: Promise<unknown> | undefined;
  let finished = false;
  let holding = false;
  try {
    const holderPid = (
      await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
    ).rows[0].pid;
    const readerPid = await backendPid(firstPool);
    await holder.query("SELECT pg_advisory_lock($1)", [lock]);
    holding = true;
    reading = readPage(
      observed,
      run.tokens.admin,
      { resource: "players" },
      controller.signal,
    ).finally(() => {
      finished = true;
    });
    void reading.catch(() => {});
    await waitForBlocked(readerPid, holderPid);
    assert.equal(blocked, true);
    controller.abort("private auth-read cancellation reason");
    const before = await readSnapshot(secondDb, run.tokens.admin);
    const saved = await mutate(
      secondDb,
      run.tokens.admin,
      payload(
        run.branchId,
        before.revision,
        tableCommand("Staff save during cancelled lookup"),
      ),
    );
    assert.equal(finished, false);
    assert.equal(released, false);
    await holder.query("SELECT pg_advisory_unlock($1)", [lock]);
    holding = false;
    await rollingBack;
    assert.equal(finished, false);
    assert.equal(released, false);
    assert.equal(
      statements.length,
      4,
      "Only BEGIN, SET, authentication and ROLLBACK may run",
    );
    assert.equal(statements[3], "ROLLBACK");
    releaseRollback();
    await assert.rejects(reading, (error) => {
      status(error, 408);
      assert.equal((error as Error).message, "Cannot load records.");
      return true;
    });
    assert.equal(released, true);
    const page = await readPage(firstDb, run.tokens.admin, {
      resource: "players",
    });
    assert.equal(page.total, 0);
    assert.equal(
      page.context.store.tables[0].name,
      "Staff save during cancelled lookup",
    );
    assert.equal(page.context.revision, saved.revision);
    assert.deepEqual(
      (await readSnapshot(secondDb, run.tokens.admin)).store,
      saved.store,
    );
  } finally {
    controller.abort();
    if (holding) await holder.query("SELECT pg_advisory_unlock($1)", [lock]);
    releaseRollback();
    await reading?.catch(() => {});
    holder.release();
  }
});

test("concurrent CSV requests fail before acquisition and an aborted export keeps its slot through real rollback", async () => {
  const run = await fixture();
  await execute(run, tableCommand("Export admission table"));
  const opened = await execute(run, {
    kind: "OPEN_DAY",
    date: "2026-10-29",
    openingCash: 100_000,
  });
  const access = {
    actorId: run.users.admin,
    branchId: run.branchId,
    role: "ADMIN" as const,
  };
  const daily = { resource: "report", dayId: opened.store.currentDayId };
  const period = { resource: "range", from: "2026-10-29", to: "2026-10-29" };
  const holder = await lockPool.connect();
  const lock = 7_318_291;
  let holding = false;
  let releaseRollback!: () => void;
  const allowRollback = new Promise<void>((resolve) => {
    releaseRollback = resolve;
  });
  let rollbackStarted!: () => void;
  const rollingBack = new Promise<void>((resolve) => {
    rollbackStarted = resolve;
  });
  let checkouts = 0;
  let released = false;
  const observed = databaseFromPool({
    query: (sql, values) => firstPool.query(sql, values),
    async connect() {
      checkouts++;
      const client = await firstPool.connect();
      return {
        async query(sql: string, values?: unknown[]) {
          if (sql === "ROLLBACK") {
            rollbackStarted();
            await allowRollback;
          }
          const result = await client.query(sql, values);
          if (sql.startsWith("SET TRANSACTION"))
            await client.query("SELECT pg_advisory_xact_lock($1)", [lock]);
          return result;
        },
        release(destroy?: boolean) {
          released = true;
          client.release(destroy);
        },
      };
    },
  });
  let refusedTransactions = 0;
  const refused: Database = {
    ...secondDb,
    transaction: (work) => {
      refusedTransactions++;
      return secondDb.transaction(work);
    },
  };
  const expectBusy = async () => {
    for (const query of [daily, period])
      await assert.rejects(
        readCsv(refused, run.tokens.admin, query, access),
        (error) => {
          assert.deepEqual(csvExportBusyDetails(error), {
            status: 503,
            retryAfterSeconds: 1,
            message:
              "Another report is being exported. Please try again shortly.",
          });
          return true;
        },
      );
    assert.equal(refusedTransactions, 0);
    assert.equal(checkouts, 1);
    assert.equal(released, false);
  };
  const controller = new AbortController();
  let finished = false;
  let exported: Promise<unknown> | undefined;
  try {
    const holderPid = (
      await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
    ).rows[0].pid;
    const exporterPid = await backendPid(firstPool);
    await holder.query("SELECT pg_advisory_lock($1)", [lock]);
    holding = true;
    exported = readCsv(
      observed,
      run.tokens.admin,
      daily,
      access,
      controller.signal,
    ).finally(() => {
      finished = true;
    });
    void exported.catch(() => {});
    await waitForBlocked(exporterPid, holderPid);
    await expectBusy();
    controller.abort(new Error("private export cancellation reason"));
    await expectBusy();
    assert.equal(
      finished,
      false,
      "Client abort cannot release active SQL work",
    );
    const before = await readSnapshot(secondDb, run.tokens.admin);
    const saved = await mutate(
      secondDb,
      run.tokens.admin,
      payload(
        run.branchId,
        before.revision,
        tableCommand("Staff save during export"),
      ),
    );
    assert.ok(
      saved.store.tables.some(
        (table) => table.name === "Staff save during export",
      ),
    );
    await holder.query("SELECT pg_advisory_unlock($1)", [lock]);
    holding = false;
    await rollingBack;
    await expectBusy();
    assert.equal(
      finished,
      false,
      "Rollback and release must finish before admission reopens",
    );
    releaseRollback();
    await assert.rejects(exported, (error) => {
      status(error, 408);
      assert.equal(
        (error as Error).message,
        "Cannot download report. Please try again.",
      );
      return true;
    });
    assert.equal(released, true);
    assert.equal(firstPool.waitingCount, 0);
    const after = await readSnapshot(secondDb, run.tokens.admin);
    assert.equal(after.revision, saved.revision);
    assert.deepEqual(after.store, saved.store);
    for (const query of [daily, period])
      assert.ok(
        (
          await readCsv(firstDb, run.tokens.admin, query, access)
        ).value.includes('"Branch"'),
      );
  } finally {
    controller.abort();
    if (holding) await holder.query("SELECT pg_advisory_unlock($1)", [lock]);
    releaseRollback();
    await exported?.catch(() => {});
    holder.release();
  }
});

test("a large daily CSV retains one snapshot while another staff member posts a buy-in", async () => {
  const run = await fixture();
  const actors = Object.fromEntries(
    Object.entries(run.users).map(([key, id]) => [
      key,
      {
        id,
        username: id,
        branchId: run.branchId,
        role:
          key === "admin" ? "ADMIN" : key === "manager" ? "MANAGER" : "CASHIER",
      },
    ]),
  ) as Record<keyof Fixture["users"], Staff>;
  let store = configuredStore();
  let tick = Date.parse("2026-10-29T00:00:00Z");
  const apply = (command: Command, actor = actors.admin) => {
    store = applyCommand(store, command, actor, new Date(tick++).toISOString());
  };
  apply(tableCommand("CSV snapshot table"));
  const tableId = store.tables[0].id;
  apply({ kind: "OPEN_DAY", date: "2026-10-29", openingCash: 1_000_000 });
  for (let index = 0; index < 61; index++) {
    const name = "CSV snapshot participant " + String(index).padStart(3, "0");
    apply(
      {
        kind: "CHECK_IN",
        name,
        phone: "+1202558" + String(index).padStart(4, "0"),
        type: "CASH",
        creditLimit: 0,
        tags: [],
        tableId,
        seat: 1,
      },
      actors.cashier,
    );
    const playerId = store.profiles.find(
      (profile) => profile.name === name,
    )!.id;
    apply(
      { kind: "REQUEST", type: "Buy-in", playerId, amount: 50_000, note: "" },
      actors.cashier,
    );
    apply({
      kind: "DECIDE",
      approvalId: store.approvals[0].id,
      decision: "APPROVED",
    });
    if (index < 60) {
      apply(
        {
          kind: "REQUEST",
          type: "Cash-out",
          playerId,
          amount: 50_000,
          note: "",
        },
        actors.cashier,
      );
      apply({
        kind: "DECIDE",
        approvalId: store.approvals[0].id,
        decision: "APPROVED",
      });
    }
  }
  await firstDb.transaction((connection) =>
    replaceStore(connection, run.branchId, store),
  );
  const query = { resource: "report", dayId: store.currentDayId };
  const access = {
    actorId: actors.admin.id,
    branchId: run.branchId,
    role: actors.admin.role,
  };
  const baseline = await readCsv(firstDb, run.tokens.admin, query, access);
  assert.ok(baseline.value.includes('"Cash received","30500"'));
  assert.equal(
    baseline.value
      .split("\n")
      .filter((line) => line.startsWith('"CSV snapshot participant ')).length,
    61,
  );
  let interleaved = false;
  let queries = 0;
  const observed: Database = {
    ...firstDb,
    transaction: (work) =>
      firstDb.transaction((connection) =>
        work({
          async query<T>(sql: string, values?: unknown[]) {
            queries++;
            if (sql.includes("daily_csv_participant_projection")) {
              assert.equal(interleaved, false);
              interleaved = true;
              const before = await readSnapshot(secondDb, run.tokens.cashier);
              const checkedIn = await mutate(
                secondDb,
                run.tokens.cashier,
                payload(run.branchId, before.revision, {
                  kind: "CHECK_IN",
                  name: "After export snapshot",
                  phone: "+12025589999",
                  type: "CASH",
                  creditLimit: 0,
                  tags: [],
                  tableId,
                  seat: 2,
                }),
              );
              const playerId = checkedIn.store.profiles.find(
                (profile) => profile.name === "After export snapshot",
              )!.id;
              const requested = await mutate(
                secondDb,
                run.tokens.cashier,
                payload(run.branchId, checkedIn.revision, {
                  kind: "REQUEST",
                  type: "Buy-in",
                  playerId,
                  amount: 70_000,
                  note: "Concurrent CSV test",
                }),
              );
              const request = requested.store.approvals.find(
                (entry) =>
                  entry.playerId === playerId && entry.status === "PENDING",
              )!;
              await mutate(
                secondDb,
                run.tokens.admin,
                payload(run.branchId, requested.revision, {
                  kind: "DECIDE",
                  approvalId: request.id,
                  decision: "APPROVED",
                }),
              );
            }
            return connection.query<T>(sql, values);
          },
        }),
      ),
  };
  const exported = await readCsv(observed, run.tokens.admin, query, access);
  assert.equal(interleaved, true);
  assert.ok(
    queries <= 22,
    `Expected at most22 SQL queries, received ${queries}.`,
  );
  assert.equal(exported.value, baseline.value);
  assert.deepEqual(exported.access, access);
  assert.equal(exported.value.includes("After export snapshot"), false);
  const current = await readCsv(firstDb, run.tokens.admin, query, access);
  assert.ok(current.value.includes("After export snapshot"));
  assert.ok(current.value.includes('"Cash received","31200"'));
  assert.equal(
    current.value
      .split("\n")
      .filter((line) => line.startsWith('"CSV snapshot participant ')).length,
    61,
  );
});

test("shared credential changes revoke every venue session and replay safely after restore", async () => {
  const first = await fixture();
  const other = await fixture();
  await firstDb.query(
    "INSERT INTO poker_memberships(user_id,branch_id,role) VALUES($1,$2,'MANAGER')",
    [first.users.cashier, other.branchId],
  );
  const otherToken = await login(secondDb, first.users.cashier, password);
  await changeBranch(secondDb, otherToken, other.branchId);
  await firstDb.query(
    "INSERT INTO poker_login_attempts(username,attempts,window_start) VALUES($1,10,now()) ON CONFLICT(username) DO UPDATE SET attempts=10,window_start=now()",
    [first.users.cashier],
  );
  const resetPassword = "native-reset-credential-2026";
  const finalPassword = "native-enabled-credential-2026";
  const reset = operatorInput({
    kind: "PASSWORD",
    username: first.users.cashier,
    password: resetPassword,
    enable: false,
  });
  const result = await manageOperatorAccount(secondDb, reset);
  assert.deepEqual(result.branchIds, [first.branchId, other.branchId].sort());
  assert.equal(await sessionUser(firstDb, first.tokens.cashier), null);
  assert.equal(await sessionUser(firstDb, otherToken), null);
  assert.equal(
    (
      await firstDb.query(
        "SELECT username FROM poker_login_attempts WHERE username=$1",
        [first.users.cashier],
      )
    ).rows.length,
    0,
  );
  const fresh = await login(firstDb, first.users.cashier, resetPassword);
  const retry = await manageOperatorAccount(secondDb, reset);
  assert.equal(retry.replayed, true);
  assert.ok(
    await sessionUser(firstDb, fresh),
    "Replaying a completed reset must not revoke a newer session",
  );
  await manageOperatorAccount(
    firstDb,
    operatorInput({ kind: "DISABLE", username: first.users.cashier }),
  );
  assert.equal(await sessionUser(secondDb, fresh), null);
  await manageOperatorAccount(
    secondDb,
    operatorInput({
      kind: "PASSWORD",
      username: first.users.cashier,
      password: finalPassword,
      enable: true,
    }),
  );
  const active = await login(firstDb, first.users.cashier, finalPassword);
  assert.ok(await sessionUser(firstDb, active));
  const events = (
    await firstDb.query<{ data: { actorId: string; actor: string } }>(
      "SELECT data FROM poker_audit WHERE entity=$1 ORDER BY branch_id,order_no",
      [first.users.cashier],
    )
  ).rows;
  assert.equal(events.length, 6);
  assert.ok(
    events.every((row) =>
      row.data.actor.startsWith("Operator: Native security test operator ("),
    ),
  );
  assert.equal(JSON.stringify(events).includes(resetPassword), false);
  assert.equal(JSON.stringify(events).includes(finalPassword), false);
  assert.equal(JSON.stringify(events).includes("password_hash"), false);
  const actorId = events[0].data.actorId;
  assert.equal(
    (
      await firstDb.query<{ active: boolean }>(
        "SELECT active FROM poker_users WHERE id=$1",
        [actorId],
      )
    ).rows[0].active,
    false,
  );
  assert.equal(
    (
      await firstDb.query(
        "SELECT user_id FROM poker_memberships WHERE user_id=$1",
        [actorId],
      )
    ).rows.length,
    0,
  );

  const backup = await createBackup(firstDb);
  await restoreBackup(restoredDb, backup, async () => {});
  assert.equal((await manageOperatorAccount(restoredDb, reset)).replayed, true);
  const restoredToken = await login(
    restoredDb,
    first.users.cashier,
    finalPassword,
  );
  assert.ok(await sessionUser(restoredDb, restoredToken));
  assert.equal(
    (
      await restoredDb.query<{ total: string }>(
        "SELECT count(*)::text AS total FROM poker_audit WHERE entity=$1",
        [first.users.cashier],
      )
    ).rows[0].total,
    "6",
  );
});
