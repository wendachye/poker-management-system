import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import type { Database, SqlConnection } from "../src/server/database";
import type { Staff, Store } from "../src/domain/model";
import { schema, migrate } from "../src/server/schema";
import { emptyStore } from "../src/domain/selectors";
import { buildSampleStore } from "../scripts/sample-data";
import { importStore, readStore, writeStoreDelta } from "../src/server/storage";
import { testDatabase } from "./helpers/database";

function adapt(engine: PGlite): Database {
  const connection = (client: Pick<PGlite, "query">): SqlConnection => ({
    async query<T>(sql: string, values?: unknown[]) {
      return { rows: (await client.query<T>(sql, values)).rows };
    },
  });
  return {
    ...connection(engine),
    transaction: (work) =>
      engine.transaction((client) =>
        work(connection(client as unknown as PGlite)),
      ),
  };
}
const actors = Object.fromEntries(
  ["cashier", "manager", "admin", "dealer"].map((name) => [
    name,
    {
      id: name,
      username: name,
      role: name.toUpperCase(),
      branchId: "local",
    },
  ]),
) as Record<"cashier" | "manager" | "admin" | "dealer", Staff>;
async function seedActors(db: SqlConnection) {
  for (const actor of Object.values(actors))
    await db.query(
      "INSERT INTO poker_users(id,username,password_hash) VALUES($1,$1,'no-login')",
      [actor.id],
    );
}
const sample = () =>
  JSON.parse(
    JSON.stringify(buildSampleStore(actors, new Date("2026-10-28T15:00:00Z"))),
  ) as Store;

test("v2 migrates populated legacy records exactly, replaces the blob and retains indexed fields", async () => {
  const engine = await PGlite.create();
  const db = adapt(engine);
  try {
    await engine.exec(schema);
    await seedActors(db);
    const original = sample();
    await db.query(
      "INSERT INTO poker_branches(id,name) VALUES('local','Legacy sample')",
    );
    await db.query(
      "INSERT INTO poker_branch_state(branch_id,revision,data) VALUES('local',37,$1)",
      [JSON.stringify(original)],
    );
    await migrate(db);
    assert.deepEqual(await readStore(db, "local"), original);
    const metadata = (
      await db.query<{ data: Record<string, unknown>; revision: number }>(
        "SELECT data,revision FROM poker_branch_state WHERE branch_id='local'",
      )
    ).rows[0];
    assert.equal(metadata.revision, 37);
    assert.equal(metadata.data.storageVersion, 2);
    assert.equal(metadata.data.concurrencyFloor, 37);
    assert.equal("transactions" in metadata.data, false);
    assert.equal("profiles" in metadata.data, false);
    assert.ok(Buffer.byteLength(JSON.stringify(metadata.data)) < 2000);
    const ledger = (
      await db.query<{
        id: string;
        amount: string;
        approval_id: string;
        last_revision: string;
      }>(
        "SELECT id,amount::text,approval_id,last_revision::text FROM poker_ledger WHERE branch_id='local' ORDER BY order_no LIMIT 1",
      )
    ).rows[0];
    assert.equal(ledger.id, original.transactions[0].id);
    assert.equal(Number(ledger.amount), original.transactions[0].amount);
    assert.equal(ledger.approval_id, original.transactions[0].approvalId);
    assert.equal(ledger.last_revision, "37");
    const indexes = (
      await db.query<{ indexname: string }>(
        "SELECT indexname FROM pg_indexes WHERE schemaname=current_schema() AND tablename IN ('poker_ledger','poker_approvals','poker_visits')",
      )
    ).rows;
    for (const name of [
      "poker_ledger_day",
      "poker_ledger_player",
      "poker_approvals_status",
      "poker_visits_active",
    ])
      assert.ok(
        indexes.some((row) => row.indexname === name),
        name,
      );
    await migrate(db);
    assert.deepEqual(await readStore(db, "local"), original);
  } finally {
    await engine.close();
  }
});

test("a broken legacy reference rolls the indexed migration back without deleting its source", async () => {
  const engine = await PGlite.create();
  const db = adapt(engine);
  try {
    await engine.exec(schema);
    await seedActors(db);
    const original = sample();
    original.transactions[0].approvalId = "missing-original-request";
    await db.query(
      "INSERT INTO poker_branches(id,name) VALUES('local','Broken legacy fixture')",
    );
    await db.query(
      "INSERT INTO poker_branch_state(branch_id,revision,data) VALUES('local',9,$1)",
      [JSON.stringify(original)],
    );
    await assert.rejects(migrate(db), /foreign key/i);
    assert.deepEqual(
      (
        await db.query<{ data: Store }>(
          "SELECT data FROM poker_branch_state WHERE branch_id='local'",
        )
      ).rows[0].data,
      original,
    );
    const tables = (
      await db.query<{ ledger: string | null; versions: string | null }>(
        "SELECT to_regclass('poker_ledger')::text AS ledger,to_regclass('poker_schema_migrations')::text AS versions",
      )
    ).rows[0];
    assert.deepEqual(tables, { ledger: null, versions: null });
  } finally {
    await engine.close();
  }
});

test("the current-day pointer cannot survive migration or import without a day in the same venue", async () => {
  const legacy = await PGlite.create();
  const legacyDb = adapt(legacy);
  try {
    await legacy.exec(schema);
    const original = { ...emptyStore(), currentDayId: "missing-day" };
    await legacyDb.query(
      "INSERT INTO poker_branches(id,name) VALUES('local','Broken day fixture')",
    );
    await legacyDb.query(
      "INSERT INTO poker_branch_state(branch_id,data) VALUES('local',$1)",
      [JSON.stringify(original)],
    );
    await assert.rejects(migrate(legacyDb), /foreign key/i);
    assert.deepEqual(
      (
        await legacyDb.query<{ data: Store }>(
          "SELECT data FROM poker_branch_state WHERE branch_id='local'",
        )
      ).rows[0].data,
      original,
    );
    assert.equal(
      (
        await legacyDb.query<{ name: string | null }>(
          "SELECT to_regclass('poker_days')::text AS name",
        )
      ).rows[0].name,
      null,
    );
  } finally {
    await legacy.close();
  }
  const { db, engine } = await testDatabase();
  try {
    const other = emptyStore();
    other.days = [
      {
        id: "other-day",
        date: "2026-10-28",
        status: "OPEN",
        openedAt: "2026-10-28T00:00:00.000Z",
        openingCash: 0,
        closes: [],
      },
    ];
    other.currentDayId = "other-day";
    await importStore(db, "other", other);
    await assert.rejects(
      importStore(db, "local", { ...emptyStore(), currentDayId: "other-day" }),
      /foreign key/i,
    );
    assert.deepEqual(await readStore(db, "local"), emptyStore());
    assert.deepEqual(await readStore(db, "other"), other);
  } finally {
    await engine.close();
  }
});

test("metadata and record identity checks reject unknown SQL truth values instead of accepting JSON nulls", async () => {
  const { db, engine } = await testDatabase();
  try {
    const before = (
      await db.query<{ data: unknown }>(
        "SELECT data FROM poker_branch_state WHERE branch_id='local'",
      )
    ).rows[0].data;
    const malformed = [
      {},
      { currentDayId: null },
      { schemaVersion: 1, currentDayId: null },
      { schemaVersion: null, storageVersion: 2, currentDayId: null },
      { schemaVersion: 1, storageVersion: null, currentDayId: null },
      { schemaVersion: 1, storageVersion: 2 },
      {
        schemaVersion: 1,
        storageVersion: 2,
        currentDayId: null,
        transactions: [],
      },
      {
        schemaVersion: 1,
        storageVersion: 2,
        currentDayId: null,
        readModel: {},
      },
    ];
    for (const value of malformed) {
      await assert.rejects(
        db.query(
          "UPDATE poker_branch_state SET data=$1 WHERE branch_id='local'",
          [JSON.stringify(value)],
        ),
        /check constraint/i,
      );
      assert.deepEqual(
        (
          await db.query<{ data: unknown }>(
            "SELECT data FROM poker_branch_state WHERE branch_id='local'",
          )
        ).rows[0].data,
        before,
      );
    }
    for (const id of [null, "different-id"]) {
      const data = {
        id,
        name: "Invalid identity fixture",
        phone: "+60120000001",
        type: "CASH",
        creditLimit: 0,
        tags: [],
      };
      await assert.rejects(
        db.query(
          "INSERT INTO poker_profiles(branch_id,id,data,order_no,last_revision) VALUES('local','expected-id',$1,1,0)",
          [JSON.stringify(data)],
        ),
        /check constraint/i,
      );
    }
    assert.equal(
      (await db.query("SELECT id FROM poker_profiles WHERE branch_id='local'"))
        .rows.length,
      0,
    );
    assert.deepEqual(await readStore(db, "local"), emptyStore());
  } finally {
    await engine.close();
  }
});

test("scoped deltas leave omitted history and unrelated versions unchanged", async () => {
  const { db, engine } = await testDatabase();
  try {
    const full = emptyStore();
    full.profiles = [
      {
        id: "one",
        name: "First",
        phone: "+60120000001",
        type: "CASH",
        creditLimit: 0,
        tags: [],
      },
      {
        id: "two",
        name: "Second",
        phone: "+60120000002",
        type: "CASH",
        creditLimit: 0,
        tags: [],
      },
    ];
    await importStore(db, "local", full);
    const before = { ...emptyStore(), profiles: [full.profiles[0]] };
    const after = structuredClone(before);
    after.profiles[0].name = "Updated first";
    Reflect.set(after, "readModel", { balances: { one: 999 } });
    await db.transaction((connection) =>
      writeStoreDelta(connection, "local", before, after, 1),
    );
    const stored = await readStore(db, "local");
    assert.deepEqual(
      stored.profiles.map((value) => value.name),
      ["Updated first", "Second"],
    );
    assert.equal("readModel" in stored, false);
    assert.deepEqual(
      (
        await db.query(
          "SELECT id,last_revision::text AS version FROM poker_profiles WHERE branch_id='local' ORDER BY order_no",
        )
      ).rows,
      [
        { id: "one", version: "1" },
        { id: "two", version: "0" },
      ],
    );
    const invalid = structuredClone(stored);
    Reflect.set(invalid, "readModel", {});
    await assert.rejects(
      importStore(db, "local", invalid),
      /complete Store without read-model/,
    );
    assert.deepEqual(await readStore(db, "local"), stored);
  } finally {
    await engine.close();
  }
});

function seatedStore(): Store {
  const store = emptyStore();
  store.profiles = [1, 2].map((seat) => ({
    id: "player-" + seat,
    name: "Player " + seat,
    phone: "+6012000000" + seat,
    type: "CASH",
    creditLimit: 0,
    tags: [],
  }));
  store.tables = [{ id: "table", name: "Main", dealer: "", status: "OPEN" }];
  store.days = [
    {
      id: "day",
      date: "2026-10-28",
      openedAt: "2026-10-28T00:00:00.000Z",
      openingCash: 0,
      status: "OPEN",
      closes: [],
    },
  ];
  store.currentDayId = "day";
  store.sessions = [1, 2].map((seat) => ({
    id: "visit-" + seat,
    playerId: "player-" + seat,
    dayId: "day",
    status: "ACTIVE",
    tableId: "table",
    seat,
    sessionStart: "2026-10-28T00:00:00.000Z",
  }));
  return store;
}
test("deferred active-seat constraints permit an atomic swap and reject a final collision", async () => {
  const { db, engine } = await testDatabase();
  try {
    const before = seatedStore();
    await importStore(db, "local", before);
    const swapped = structuredClone(before);
    swapped.sessions[0].seat = 2;
    swapped.sessions[1].seat = 1;
    await db.transaction((connection) =>
      writeStoreDelta(connection, "local", before, swapped, 1),
    );
    assert.deepEqual((await readStore(db, "local")).sessions, swapped.sessions);
    const collision = structuredClone(swapped);
    collision.sessions[0].seat = 1;
    await assert.rejects(
      db.transaction((connection) =>
        writeStoreDelta(connection, "local", swapped, collision, 2),
      ),
      /unique constraint/i,
    );
    assert.deepEqual((await readStore(db, "local")).sessions, swapped.sessions);
    const duplicateVisit = structuredClone(swapped);
    duplicateVisit.sessions.push({
      ...duplicateVisit.sessions[0],
      id: "second-active-visit",
      seat: 3,
    });
    await assert.rejects(
      importStore(db, "local", duplicateVisit, 2),
      /unique constraint/i,
    );
    assert.deepEqual((await readStore(db, "local")).sessions, swapped.sessions);
  } finally {
    await engine.close();
  }
});

test("indexed financial constraints reject duplicate posting and duplicate reversal imports", async () => {
  const { db, engine } = await testDatabase();
  try {
    await seedActors(db);
    const original = sample();
    await importStore(db, "local", original);
    const duplicatePosting = structuredClone(original);
    duplicatePosting.transactions.push({
      ...duplicatePosting.transactions[0],
      id: "duplicate-posting",
    });
    await assert.rejects(
      importStore(db, "local", duplicatePosting, 1),
      /unique constraint/i,
    );
    assert.deepEqual(await readStore(db, "local"), original);
    const duplicateReversal = structuredClone(original);
    const reversal = duplicateReversal.transactions.find(
      (value) => value.reversesId,
    )!;
    assert.ok(reversal);
    const request = duplicateReversal.approvals.find(
      (value) => value.id === reversal.approvalId,
    )!;
    duplicateReversal.approvals.push({
      ...request,
      id: "second-reversal-request",
    });
    duplicateReversal.transactions.push({
      ...reversal,
      id: "second-reversal",
      approvalId: "second-reversal-request",
    });
    await assert.rejects(
      importStore(db, "local", duplicateReversal, 1),
      /unique constraint/i,
    );
    assert.deepEqual(await readStore(db, "local"), original);
  } finally {
    await engine.close();
  }
});
