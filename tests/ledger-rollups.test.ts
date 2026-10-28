import assert from "node:assert/strict";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { Command } from "../src/domain/commands";
import type { Staff, Store } from "../src/domain/model";
import { applyCommand } from "../src/domain/operations";
import { buildSampleStore } from "../scripts/sample-data";
import { createBackup, restoreBackup } from "../src/server/backup";
import type { Database, SqlConnection } from "../src/server/database";
import { rebuildLedgerRollups } from "../src/server/ledger-rollups";
import { financialColumns } from "../src/server/rollup-schema";
import { migrate, schema } from "../src/server/schema";
import { importStore, readStore, writeStoreDelta } from "../src/server/storage";
import { testDatabase } from "./helpers/database";

const actors = Object.fromEntries(
  ["admin", "manager", "cashier", "dealer"].map((name) => [
    name,
    { id: name, username: name, role: name.toUpperCase(), branchId: "local" },
  ]),
) as Record<"admin" | "manager" | "cashier" | "dealer", Staff>;
const sample = () =>
  JSON.parse(
    JSON.stringify(
      buildSampleStore(actors, new Date("2026-10-28T15:00:00.000Z")),
    ),
  ) as Store;
async function seedActors(db: SqlConnection) {
  for (const actor of Object.values(actors)) {
    await db.query(
      "INSERT INTO poker_users(id,username,password_hash) VALUES($1,$1,'test-only-no-login')",
      [actor.id],
    );
    await db.query(
      "INSERT INTO poker_memberships(user_id,branch_id,role) VALUES($1,'local',$2)",
      [actor.id, actor.role],
    );
  }
}
type TotalsRow = { scope: string; entity_id: string; day_id: string } & Record<
  (typeof financialColumns)[number],
  string
>;
async function totals(connection: SqlConnection) {
  return (
    await connection.query<TotalsRow>(
      `SELECT scope,entity_id,day_id,${financialColumns.map((name) => `${name}::text AS ${name}`).join(",")} FROM poker_financial_totals WHERE branch_id='local' ORDER BY scope,entity_id,day_id`,
    )
  ).rows;
}
function expected(store: Store) {
  const groups = new Map<string, TotalsRow>();
  const original = new Map(store.transactions.map((tx) => [tx.id, tx]));
  for (const tx of store.transactions) {
    const type = tx.reversesId ? original.get(tx.reversesId)!.type : tx.type;
    const amount = BigInt(tx.amount);
    const values: Record<(typeof financialColumns)[number], bigint> = {
      buy_in: type === "Buy-in" ? amount : BigInt(0),
      cash_out: type === "Cash-out" ? amount : BigInt(0),
      rake: type === "Rake" ? amount : BigInt(0),
      tips: type === "Tips" ? amount : BigInt(0),
      insurance:
        type === "Insurance Premium"
          ? amount
          : type === "Insurance Payout"
            ? -amount
            : BigInt(0),
      jackpot:
        type === "Jackpot Contribution"
          ? amount
          : type === "Jackpot Payout"
            ? -amount
            : BigInt(0),
      cash_received: BigInt(tx.cashReceived),
      cash_payout: BigInt(tx.cashPayout),
      credit_delta: BigInt(tx.creditDelta),
    };
    const buckets = [
      ["VENUE", "", ""],
      ["DAY", "", tx.dayId],
    ];
    if (tx.playerId)
      buckets.push(
        ["PLAYER", tx.playerId, ""],
        ["PLAYER_DAY", tx.playerId, tx.dayId],
      );
    if (tx.tableId) buckets.push(["TABLE_DAY", tx.tableId, tx.dayId]);
    for (const [scope, entity_id, day_id] of buckets) {
      const key = [scope, entity_id, day_id].join("|");
      const row =
        groups.get(key) ??
        ({
          scope,
          entity_id,
          day_id,
          ...Object.fromEntries(financialColumns.map((name) => [name, "0"])),
        } as TotalsRow);
      for (const name of financialColumns)
        row[name] = (BigInt(row[name]) + values[name]).toString();
      groups.set(key, row);
    }
  }
  return [...groups.values()].sort(
    (a, b) =>
      a.scope.localeCompare(b.scope) ||
      a.entity_id.localeCompare(b.entity_id) ||
      a.day_id.localeCompare(b.day_id),
  );
}
function adapt(engine: PGlite): Database {
  const connection = (client: Pick<PGlite, "query">): SqlConnection => ({
    async query<T>(sql: string, values?: unknown[]) {
      return { rows: (await client.query<T>(sql, values)).rows };
    },
  });
  return {
    ...connection(engine),
    transaction: (work) =>
      engine.transaction((tx) => work(connection(tx as unknown as PGlite))),
  };
}

test("v3 backfills all five financial scopes from existing cash, credit and reversal records", async () => {
  const engine = await PGlite.create();
  const db = adapt(engine);
  try {
    await engine.exec(schema);
    await db.query(
      "INSERT INTO poker_branches(id,name) VALUES('local','Legacy totals sample')",
    );
    await seedActors(db);
    const original = sample();
    await db.query(
      "INSERT INTO poker_branch_state(branch_id,revision,data) VALUES('local',41,$1)",
      [JSON.stringify(original)],
    );
    await migrate(db);
    assert.deepEqual(await readStore(db, "local"), original);
    assert.ok(original.transactions.some((value) => value.reversesId));
    assert.ok(
      new Set(original.transactions.map((value) => value.dayId)).size > 1,
    );
    assert.deepEqual(await totals(db), expected(original));
    const projection = await totals(db);
    assert.deepEqual(
      new Set(projection.map((value) => value.scope)),
      new Set(["VENUE", "PLAYER", "DAY", "PLAYER_DAY", "TABLE_DAY"]),
    );
    await migrate(db);
    assert.deepEqual(await totals(db), projection);
  } finally {
    await engine.close();
  }
});

test("new ledger postings and compensating reversals update exact totals in the same transaction", async (t) => {
  const run = await testDatabase();
  t.after(() => run.engine.close());
  await seedActors(run.db);
  let store = sample();
  await importStore(run.db, "local", store);
  let revision = 0;
  const apply = async (command: Command, actor = actors.cashier) => {
    const before = store;
    const after = applyCommand(before, command, actor);
    await run.db.transaction((connection) =>
      writeStoreDelta(connection, "local", before, after, ++revision),
    );
    store = after;
    assert.deepEqual(await totals(run.db), expected(store));
  };
  await apply({
    kind: "REQUEST",
    type: "Rake",
    amount: 1000,
    tableId: store.tables[0].id,
    note: "Incremental rollup test",
  });
  await apply(
    { kind: "DECIDE", approvalId: store.approvals[0].id, decision: "APPROVED" },
    actors.manager,
  );
  const original = store.transactions[0];
  await apply({
    kind: "CORRECT",
    transactionId: original.id,
    reason: "Reverse fictional incremental rake",
  });
  await apply(
    { kind: "DECIDE", approvalId: store.approvals[0].id, decision: "APPROVED" },
    actors.admin,
  );
  assert.equal(store.transactions[0].reversesId, original.id);
  const before = await totals(run.db);
  await run.db.transaction((connection) =>
    rebuildLedgerRollups(connection, "local"),
  );
  assert.deepEqual(await totals(run.db), before);
});

test("a failed write rolls back the ledger and its derived totals and immutable entries cannot be edited", async (t) => {
  const run = await testDatabase();
  t.after(() => run.engine.close());
  await seedActors(run.db);
  let store = sample();
  await importStore(run.db, "local", store);
  const requested = applyCommand(
    store,
    {
      kind: "REQUEST",
      type: "Tips",
      tableId: store.tables[0].id,
      amount: 1000,
      note: "Rollback sample",
    },
    actors.cashier,
  );
  await run.db.transaction((connection) =>
    writeStoreDelta(connection, "local", store, requested, 1),
  );
  store = await readStore(run.db, "local");
  const posted = applyCommand(
    store,
    { kind: "DECIDE", approvalId: store.approvals[0].id, decision: "APPROVED" },
    actors.manager,
  );
  const before = await totals(run.db);
  await assert.rejects(
    run.db.transaction(async (connection) => {
      await writeStoreDelta(connection, "local", store, posted, 2);
      assert.notDeepEqual(await totals(connection), before);
      throw new Error("Synthetic failure after totals update");
    }),
    /Synthetic failure/,
  );
  assert.deepEqual(await totals(run.db), before);
  assert.deepEqual(await readStore(run.db, "local"), store);
  const changed = structuredClone(store);
  changed.transactions[0].amount++;
  await assert.rejects(
    run.db.transaction((connection) =>
      writeStoreDelta(connection, "local", store, changed, 2),
    ),
    /immutable/,
  );
  assert.deepEqual(await totals(run.db), before);
  assert.deepEqual(await readStore(run.db, "local"), store);
});

test("restore rebuilds derived totals from the saved ledger instead of trusting cached projections", async (t) => {
  const run = await testDatabase();
  t.after(() => run.engine.close());
  await seedActors(run.db);
  const store = sample();
  await importStore(run.db, "local", store);
  const backup = await createBackup(run.db);
  const reference = await totals(run.db);
  await run.db.query(
    "UPDATE poker_financial_totals SET rake=rake+12345 WHERE branch_id='local'",
  );
  assert.notDeepEqual(await totals(run.db), reference);
  let safetyCopies = 0;
  await restoreBackup(run.db, backup, async () => {
    safetyCopies++;
  });
  assert.equal(safetyCopies, 1);
  assert.deepEqual(await totals(run.db), reference);
  assert.deepEqual(await readStore(run.db, "local"), store);
  assert.equal(
    (
      await run.db.query(
        "SELECT * FROM poker_financial_totals WHERE branch_id='other'",
      )
    ).rows.length,
    0,
  );
});
