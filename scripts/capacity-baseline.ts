import { randomBytes, randomUUID } from "node:crypto";
import { availableParallelism, arch, platform, totalmem } from "node:os";
import { performance } from "node:perf_hooks";
import { Pool } from "pg";
import type { Staff, Store } from "../src/domain/model";
import { DomainError } from "../src/domain/operations";
import { emptyStore } from "../src/domain/selectors";
import { defaultSettings } from "../src/domain/settings";
import { hashPassword, login } from "../src/server/auth";
import {
  capacityDatabaseTarget,
  capacityLimits,
  capacityOptions,
  latencySummary,
} from "../src/server/capacity-target";
import { databaseFromPool, type Database } from "../src/server/database";
import {
  databasePoolErrorCode,
  databasePoolOptions,
} from "../src/server/database-options";
import { mutate } from "../src/server/repository";
import { readOperationalSnapshot } from "../src/server/queries";
import { migrate } from "../src/server/schema";
import { readStore, replaceStore } from "../src/server/storage";

// Do not load .env or use database(): this command owns only its random schemas
// inside the explicitly provided disposable test database.
const target = capacityDatabaseTarget(process.env.POSTGRES_TEST_DATABASE_URL);
const options = capacityOptions();
const budgets = databasePoolOptions({ DATABASE_URL: target.connectionString });
const password = "fictional-capacity-baseline-password";
type Worker = { staff: Staff; token: string; tableId: string; index: number };
type ReadResult = { ms?: number; bytes?: number; error?: string };
type WriteResult = {
  succeeded: boolean;
  ms: number;
  attempts: number;
  attemptsMs: number[];
  responseBytes?: number;
  conflicts: number;
  error?: string;
};

function errorCategory(error: unknown) {
  if (error instanceof DomainError) return `HTTP_${error.status}`;
  return databasePoolErrorCode(error);
}
function errorCounts(results: { error?: string }[]) {
  const counts: Record<string, number> = {};
  for (const { error } of results)
    if (error) counts[error] = (counts[error] ?? 0) + 1;
  return counts;
}

function syntheticStore(
  branchId: string,
  staff: Staff[],
  retained: number,
): Store {
  const store = emptyStore();
  store.settings = {
    ...defaultSettings(),
    setupCompleted: true,
    venueName: branchId,
  };
  store.tables = staff.map((person, index) => ({
    id: `${branchId}_table_${index}`,
    name: `Fictional table ${index + 1}`,
    dealer: person.username,
    status: "OPEN",
  }));
  store.profiles = Array.from(
    { length: options.playerProfilesPerVenue },
    (_, index) => ({
      id: `${branchId}_player_${index}`,
      name: `Fictional player ${index + 1}`,
      phone: `+1202${String(index).padStart(7, "0")}`,
      type: "CASH",
      creditLimit: 0,
      tags: [],
    }),
  );
  const dayId = `${branchId}_history`;
  const openingCash = 2_000_000;
  store.days = [
    {
      id: dayId,
      date: "2026-01-01",
      openedAt: "2026-01-01T00:00:00.000Z",
      openingCash,
      status: "CLOSED",
      closes: [
        {
          time: "2026-01-01T23:59:00.000Z",
          actor: staff[1].username,
          countedCash: openingCash + retained * 100,
          expectedCash: openingCash + retained * 100,
          variance: 0,
          reason: "Fictional fixture close",
        },
      ],
    },
    {
      id: `${branchId}_current`,
      date: "2026-01-02",
      openedAt: "2026-01-02T00:00:00.000Z",
      openingCash,
      status: "OPEN",
      closes: [],
    },
  ];
  store.currentDayId = store.days[1].id;
  for (let index = 0; index < retained; index++) {
    const approvalId = `${branchId}_approval_${index}`;
    const txId = `${branchId}_transaction_${index}`;
    const time = new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString();
    const tableId = store.tables[index % store.tables.length].id;
    store.approvals.push({
      id: approvalId,
      dayId,
      type: "Rake",
      amount: 100,
      tableId,
      staff: staff[0].username,
      note: "Fictional retained entry",
      status: "APPROVED",
      approvalLevel: "MANAGER",
      riskReason: "Independent review",
      requestedBy: staff[0].username,
      requestedById: staff[0].id,
      createdAt: time,
      decidedBy: staff[1].username,
      decidedAt: time,
      votes: [
        {
          staffId: staff[1].id,
          username: staff[1].username,
          role: "MANAGER",
          time,
        },
      ],
    });
    store.transactions.push({
      id: txId,
      dayId,
      type: "Rake",
      tableId,
      amount: 100,
      staff: staff[0].username,
      staffId: staff[0].id,
      cashReceived: 100,
      cashPayout: 0,
      creditDelta: 0,
      time,
      note: "Fictional retained entry",
      approvalId,
    });
    store.auditLogs.push(
      {
        id: `${branchId}_requested_${index}`,
        time,
        actor: staff[0].username,
        actorId: staff[0].id,
        action: "Requested transaction",
        entity: approvalId,
        reason: "Fictional retained entry",
      },
      {
        id: `${branchId}_posted_${index}`,
        time,
        actor: staff[1].username,
        actorId: staff[1].id,
        action: "Posted transaction",
        entity: txId,
        reason: "Fictional independent approval",
      },
    );
  }
  return store;
}

async function seed(db: Database, retained: number, passwordHash: string) {
  const workers: Worker[] = [];
  for (let venue = 0; venue < options.venues; venue++) {
    const branchId = `capacity_venue_${venue}`;
    const staff: Staff[] = Array.from(
      { length: options.staffPerVenue },
      (_, index) => ({
        id: `${branchId}_staff_${index}`,
        username: `${branchId}_staff_${index}`,
        branchId,
        role: "MANAGER",
      }),
    );
    await db.transaction(async (connection) => {
      await connection.query(
        "INSERT INTO poker_branches(id,name) VALUES($1,$1)",
        [branchId],
      );
      for (const person of staff) {
        await connection.query(
          "INSERT INTO poker_users(id,username,password_hash) VALUES($1,$2,$3)",
          [person.id, person.username, passwordHash],
        );
        await connection.query(
          "INSERT INTO poker_memberships(user_id,branch_id,role) VALUES($1,$2,$3)",
          [person.id, branchId, person.role],
        );
      }
      await replaceStore(
        connection,
        branchId,
        syntheticStore(branchId, staff, retained),
      );
    });
    // Hashing/login is setup, not part of the sustained read/write timing.
    for (const [index, person] of staff.entries())
      workers.push({
        staff: person,
        index,
        token: await login(db, person.username, password),
        tableId: `${branchId}_table_${index}`,
      });
  }
  // Interleave venues so pool queue order does not give the first venue all slots.
  return workers.sort((first, second) => first.index - second.index);
}

async function read(db: Database, worker: Worker): Promise<ReadResult> {
  const started = performance.now();
  try {
    const snapshot = await compactSnapshot(db, worker.token);
    const bytes = Buffer.byteLength(JSON.stringify(snapshot), "utf8");
    return { ms: performance.now() - started, bytes };
  } catch (error) {
    return { error: errorCategory(error) };
  }
}

async function compactSnapshot(db: Database, token: string) {
  return db.transaction(async (connection) => {
    await connection.query(
      "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    return readOperationalSnapshot(connection, token);
  });
}

async function write(db: Database, worker: Worker): Promise<WriteResult> {
  const started = performance.now();
  const operationId = randomUUID();
  const result: WriteResult = {
    succeeded: false,
    ms: 0,
    attempts: 0,
    attemptsMs: [],
    conflicts: 0,
  };
  const command = {
    kind: "TABLE" as const,
    tableId: worker.tableId,
    name: `Fictional table ${worker.index + 1} edited`,
    dealer: worker.staff.username,
    status: "OPEN" as const,
  };
  for (let attempt = 0; attempt < options.mutationAttempts; attempt++) {
    result.attempts++;
    try {
      const { revision } = await compactSnapshot(db, worker.token);
      const attemptStarted = performance.now();
      try {
        const receipt = await mutate(
          db,
          worker.token,
          {
            branchId: worker.staff.branchId,
            actorId: worker.staff.id,
            revision,
            operationId,
            command,
          },
          { compact: true },
        );
        result.responseBytes = Buffer.byteLength(
          JSON.stringify(receipt),
          "utf8",
        );
        result.succeeded = true;
        break;
      } finally {
        result.attemptsMs.push(performance.now() - attemptStarted);
      }
    } catch (error) {
      if (error instanceof DomainError && error.status === 409) {
        result.conflicts++;
        if (attempt + 1 < options.mutationAttempts) continue;
      }
      result.error = errorCategory(error);
      break;
    }
  }
  result.ms = performance.now() - started;
  return result;
}

async function invariants(
  db: Database,
  workers: Worker[],
  retained: number,
  writes: WriteResult[],
) {
  const results = [];
  for (let venue = 0; venue < options.venues; venue++) {
    const venueWorkers = workers.filter(
      (worker) => worker.staff.branchId === `capacity_venue_${venue}`,
    );
    const branchId = venueWorkers[0].staff.branchId;
    const store = await readStore(db, branchId);
    const revision = (
      await db.query<{ revision: number }>(
        "SELECT revision FROM poker_branch_state WHERE branch_id=$1",
        [branchId],
      )
    ).rows[0].revision;
    const snapshot = { branch: { id: branchId }, store, revision };
    const successes = writes.filter(
      (result, index) =>
        result.succeeded &&
        workers[index].staff.branchId === snapshot.branch.id,
    ).length;
    const operationCount = (
      await db.query<{ count: number }>(
        "SELECT count(*)::integer AS count FROM poker_operations WHERE branch_id=$1",
        [snapshot.branch.id],
      )
    ).rows[0].count;
    const approvals = new Map(
      store.approvals.map((request) => [request.id, request]),
    );
    const staffIds = new Set(venueWorkers.map((worker) => worker.staff.id));
    const referencesValid = store.transactions.every((tx) => {
      const request = approvals.get(tx.approvalId);
      return (
        request?.status === "APPROVED" &&
        request.dayId === tx.dayId &&
        request.amount === tx.amount &&
        request.requestedById === tx.staffId &&
        staffIds.has(tx.staffId) &&
        request.votes.length === 1 &&
        staffIds.has(request.votes[0].staffId) &&
        request.votes[0].staffId !== tx.staffId
      );
    });
    const txIds = new Set(store.transactions.map((tx) => tx.id));
    const tableIds = new Set(store.tables.map((table) => table.id));
    const dayIds = new Set(store.days.map((day) => day.id));
    const expectedRollups = new Map<string, number>();
    const bucket = (scope: string, entityId: string, dayId: string) =>
      JSON.stringify([scope, entityId, dayId]);
    for (const tx of store.transactions) {
      for (const key of [
        bucket("VENUE", "", ""),
        bucket("DAY", "", tx.dayId),
        bucket("TABLE_DAY", tx.tableId!, tx.dayId),
      ])
        expectedRollups.set(key, (expectedRollups.get(key) ?? 0) + tx.amount);
    }
    const rollups = (
      await db.query<{
        scope: string;
        entity_id: string;
        day_id: string;
        rake: string;
        cash_received: string;
        buy_in: string;
        cash_out: string;
        tips: string;
        insurance: string;
        jackpot: string;
        cash_payout: string;
        credit_delta: string;
      }>(
        "SELECT scope,entity_id,day_id,rake::text,cash_received::text,buy_in::text,cash_out::text,tips::text,insurance::text,jackpot::text,cash_payout::text,credit_delta::text FROM poker_financial_totals WHERE branch_id=$1",
        [branchId],
      )
    ).rows;
    const projectionMatchesLedger =
      rollups.length === expectedRollups.size &&
      rollups.every((row) => {
        const expected = expectedRollups.get(
          bucket(row.scope, row.entity_id, row.day_id),
        );
        return (
          expected !== undefined &&
          Number(row.rake) === expected &&
          Number(row.cash_received) === expected &&
          [
            row.buy_in,
            row.cash_out,
            row.tips,
            row.insurance,
            row.jackpot,
            row.cash_payout,
            row.credit_delta,
          ].every((value) => value === "0")
        );
      });
    const referencesAndCountsHold =
      referencesValid &&
      projectionMatchesLedger &&
      approvals.size === retained &&
      new Set(store.transactions.map((tx) => tx.id)).size === retained &&
      store.transactions.length === retained &&
      store.approvals.length === retained &&
      store.auditLogs.length === retained * 2 + successes &&
      new Set(store.auditLogs.map((log) => log.id)).size ===
        store.auditLogs.length &&
      store.profiles.length === options.playerProfilesPerVenue &&
      store.tables.length === options.staffPerVenue &&
      store.tables.filter((table) => table.name.endsWith(" edited")).length ===
        successes &&
      snapshot.revision === successes &&
      operationCount === successes &&
      store.transactions.every(
        (tx) =>
          tx.cashReceived === 100 &&
          tx.cashPayout === 0 &&
          tx.creditDelta === 0 &&
          tx.amount === 100 &&
          tx.type === "Rake" &&
          !!tx.tableId &&
          tableIds.has(tx.tableId) &&
          dayIds.has(tx.dayId),
      ) &&
      store.auditLogs.every(
        (log) =>
          staffIds.has(log.actorId) &&
          (approvals.has(log.entity) ||
            txIds.has(log.entity) ||
            store.tables.some((table) => table.id === log.entity)),
      );
    results.push({
      venue: snapshot.branch.id,
      retainedTransactions: store.transactions.length,
      approvedRequests: store.approvals.length,
      auditRecords: store.auditLogs.length,
      successfulEdits: successes,
      revision: snapshot.revision,
      operationRecords: operationCount,
      financialSummaryRows: rollups.length,
      projectionMatchesLedger,
      referencesAndCountsHold,
    });
  }
  return results;
}

async function scenario(admin: Pool, retained: number, passwordHash: string) {
  const schema = `poker_test_capacity_${randomBytes(8).toString("hex")}`;
  if (!/^poker_test_capacity_[a-f0-9]{16}$/.test(schema))
    throw new Error("Invalid owned schema.");
  let created = false;
  let pool: Pool | undefined;
  let idlePoolErrors = 0;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    pool = new Pool({
      connectionString: target.connectionString,
      ...budgets,
      options: `-c search_path=${schema}`,
      application_name: "poker-capacity-baseline",
    });
    pool.on("error", () => {
      idlePoolErrors++;
    });
    const db = databaseFromPool(pool);
    const selected = (
      await db.query<{ name: string }>("SELECT current_schema() AS name")
    ).rows[0].name;
    if (selected !== schema)
      throw new Error("Owned test schema was not selected.");
    await migrate(db);
    const workers = await seed(db, retained, passwordHash);
    const reads: ReadResult[] = [];
    const readStarted = performance.now();
    for (let round = 0; round < options.readRounds; round++)
      reads.push(
        ...(await Promise.all(workers.map((worker) => read(db, worker)))),
      );
    const readWallMs = performance.now() - readStarted;
    const writeStarted = performance.now();
    const writes = await Promise.all(
      workers.map((worker) => write(db, worker)),
    );
    const writeWallMs = performance.now() - writeStarted;
    const checks = await invariants(db, workers, retained, writes);
    const bytes = reads.flatMap((result) =>
      result.bytes === undefined ? [] : [result.bytes],
    );
    return {
      retainedLedgerEntriesPerVenue: retained,
      syntheticRecordsPerVenue: {
        profiles: options.playerProfilesPerVenue,
        transactions: retained,
        approvals: retained,
        initialAuditRecords: retained * 2,
        businessDays: 2,
        tables: options.staffPerVenue,
      },
      reads: {
        latency: latencySummary(
          reads.flatMap((result) =>
            result.ms === undefined ? [] : [result.ms],
          ),
        ),
        phaseWallMs: Number(readWallMs.toFixed(3)),
        errors: errorCounts(reads),
        serializedSnapshotBytes: {
          samples: bytes.length,
          min: bytes.length ? Math.min(...bytes) : null,
          max: bytes.length ? Math.max(...bytes) : null,
          mean: bytes.length
            ? Math.round(bytes.reduce((a, b) => a + b, 0) / bytes.length)
            : null,
        },
      },
      tableEdits: {
        requested: workers.length,
        succeeded: writes.filter((result) => result.succeeded).length,
        failed: writes.filter((result) => !result.succeeded).length,
        revisionConflicts: writes.reduce(
          (sum, result) => sum + result.conflicts,
          0,
        ),
        retries: writes.reduce(
          (sum, result) => sum + Math.max(0, result.attempts - 1),
          0,
        ),
        operationAttempts: writes.reduce(
          (sum, result) => sum + result.attempts,
          0,
        ),
        mutationCalls: writes.reduce(
          (sum, result) => sum + result.attemptsMs.length,
          0,
        ),
        phaseWallMs: Number(writeWallMs.toFixed(3)),
        errors: errorCounts(writes),
        mutationAttemptLatency: latencySummary(
          writes.flatMap((result) => result.attemptsMs),
        ),
        serializedReceiptBytes: (() => {
          const sizes = writes.flatMap((result) =>
            result.responseBytes === undefined ? [] : [result.responseBytes],
          );
          return {
            samples: sizes.length,
            min: sizes.length ? Math.min(...sizes) : null,
            max: sizes.length ? Math.max(...sizes) : null,
            mean: sizes.length
              ? Math.round(
                  sizes.reduce((sum, value) => sum + value, 0) / sizes.length,
                )
              : null,
          };
        })(),
        successfulEndToEndLatency: latencySummary(
          writes
            .filter((result) => result.succeeded)
            .map((result) => result.ms),
        ),
        allEndToEndLatency: latencySummary(writes.map((result) => result.ms)),
      },
      idlePoolErrors,
      invariants: checks,
      invariantCheckPassed: checks.every(
        (check) => check.referencesAndCountsHold,
      ),
      schemaCleanup: "Owned generated schema removed after this scenario",
    };
  } finally {
    try {
      await pool?.end();
    } finally {
      if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    }
  }
}

async function main() {
  const admin = new Pool({
    connectionString: target.connectionString,
    ...budgets,
    max: 1,
    options: "-c search_path=pg_catalog",
    application_name: "poker-capacity-owner",
  });
  let administratorIdlePoolErrors = 0;
  admin.on("error", () => {
    administratorIdlePoolErrors++;
  });
  try {
    const server = (
      await admin.query<{ name: string; version: string }>(
        "SELECT current_database() AS name, version() AS version",
      )
    ).rows[0];
    if (server.name !== target.database)
      throw new Error("Unexpected test database.");
    const passwordHash = await hashPassword(password);
    const scenarios = [];
    for (const retained of options.retainedEntryScenarios)
      scenarios.push(await scenario(admin, retained, passwordHash));
    console.log(
      JSON.stringify(
        {
          kind: "descriptive-local-indexed-capacity-baseline",
          generatedAt: new Date().toISOString(),
          platform: {
            node: process.version,
            platform: platform(),
            architecture: arch(),
            logicalCpus: availableParallelism(),
            hostMemoryBytes: totalmem(),
            postgresql: server.version,
          },
          target: {
            host: target.host,
            port: target.port,
            database: target.database,
          },
          assumptions: [
            "Synthetic retained ledger volumes are scenario assumptions, not forecasts or counts derived from RM100,000+ daily activity.",
            "One authenticated Manager per worker; login and fixture setup are excluded from timings.",
            "Read timing includes actual authentication, database work and UTF-8 JSON serialization; no HTTP, TLS or browser rendering.",
            "Each worker performs one nonfinancial table edit using fresh snapshots, with the same operation identifier on bounded revision-conflict retries.",
            "Routine reads and mutation receipts use the compact operations contract; changed records persist through indexed storage. Full Store reconstruction is used only for untimed integrity checks. Scenarios run sequentially.",
            "Workers are interleaved by venue, scheduled concurrently, and return only metrics rather than retained snapshot objects.",
            "No cloud capacity, service-level objective, financial throughput or production-readiness pass is inferred from this local baseline.",
          ],
          options,
          resourceCaps: capacityLimits,
          databaseBudgets: budgets,
          administratorIdlePoolErrors,
          scenarios,
          invariantChecksPassed: scenarios.every(
            (item) => item.invariantCheckPassed,
          ),
        },
        null,
        2,
      ),
    );
    if (scenarios.some((item) => !item.invariantCheckPassed))
      process.exitCode = 1;
  } finally {
    await admin.end();
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      kind: "capacity-baseline-failed",
      errorCategory: errorCategory(error),
    }),
  );
  process.exitCode = 1;
});
