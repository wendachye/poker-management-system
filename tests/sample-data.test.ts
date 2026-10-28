import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { seedLocalSamples, sampleSummary } from "../scripts/sample-data";
import { migrate } from "../src/server/schema";
import { importStore, readStore } from "../src/server/storage";
import { emptyStore, debt, totalsForDay } from "../src/domain/selectors";
import { applyCommand, canApprove } from "../src/domain/operations";
import type { Database, SqlConnection } from "../src/server/database";
import type { Staff } from "../src/domain/model";

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
async function setup() {
  const engine = await PGlite.create();
  await migrate(adapt(engine));
  await engine.query(
    "INSERT INTO poker_branches(id,name,timezone) VALUES('local','Local Venue','Asia/Kuala_Lumpur')",
  );
  await importStore(adapt(engine), "local", emptyStore());
  return engine;
}

test("sample loader creates valid scenarios once and leaves accounts unable to sign in", async () => {
  const engine = await setup();
  try {
    const db = adapt(engine),
      now = new Date("2026-10-02T15:00:00Z");
    const first = await seedLocalSamples(db, now);
    assert.equal(first.added, true);
    assert.equal(first.players, 16);
    assert.equal(first.activePlayers, 12);
    assert.equal(first.tables, 4);
    assert.equal(first.businessDays, 3);
    assert.equal(first.pendingRequests, 5);
    assert.equal(first.rejectedRequests, 1);
    const before = {
      revision: (
        await db.query<{ revision: number }>(
          "SELECT revision FROM poker_branch_state WHERE branch_id='local'",
        )
      ).rows[0].revision,
      data: await readStore(db, "local"),
    };
    const store = before.data;
    assert.deepEqual(
      store.days.map((d) => d.date),
      ["2026-09-30", "2026-10-01", "2026-10-02"],
    );
    assert.deepEqual(
      store.days.map((d) => d.status),
      ["CLOSED", "CLOSED", "OPEN"],
    );
    assert.equal(store.days[0].closes[0].variance, -2_500);
    assert.equal(store.days[1].closes[0].variance, 0);
    const active = store.sessions.filter((s) => s.status === "ACTIVE");
    assert.equal(
      new Set(active.map((s) => s.tableId + ":" + s.seat)).size,
      active.length,
    );
    assert.equal(
      active.filter((s) => s.tableId === store.tables[0].id).length,
      9,
    );
    for (const profile of store.profiles)
      assert.ok(
        debt(store, profile.id) >= 0 &&
          debt(store, profile.id) <= profile.creditLimit,
      );
    assert.ok(totalsForDay(store).expectedCash > 0);
    assert.ok(
      store.auditLogs.every((log) => Date.parse(log.time) <= now.getTime()),
    );
    const staff: Staff = {
      id: "real-local-admin",
      username: "local.admin",
      role: "ADMIN",
      branchId: "local",
    };
    for (const r of store.approvals.filter((r) => r.status === "PENDING")) {
      assert.ok(canApprove(staff, r));
      assert.doesNotThrow(() =>
        applyCommand(
          store,
          { kind: "DECIDE", approvalId: r.id, decision: "APPROVED" },
          staff,
        ),
      );
    }
    const actors = (
      await db.query<{ active: boolean }>("SELECT active FROM poker_users")
    ).rows;
    assert.equal(actors.length, 4);
    assert.ok(actors.every((actor) => !actor.active));
    const second = await seedLocalSamples(db, now);
    assert.equal(second.added, false);
    assert.deepEqual(
      sampleSummary(store),
      Object.fromEntries(
        Object.entries(second).filter(([key]) => key !== "added"),
      ),
    );
    const after = {
      revision: (
        await db.query<{ revision: number }>(
          "SELECT revision FROM poker_branch_state WHERE branch_id='local'",
        )
      ).rows[0].revision,
      data: await readStore(db, "local"),
    };
    assert.deepEqual(after, before);
  } finally {
    await engine.close();
  }
});

test("sample loader refuses existing venue records without modifying them", async () => {
  const engine = await setup();
  try {
    const store = emptyStore();
    store.tables.push({
      id: "existing",
      name: "Existing table",
      dealer: "",
      status: "OPEN",
    });
    await importStore(adapt(engine), "local", store, 7);
    await assert.rejects(
      seedLocalSamples(adapt(engine)),
      /already contains records/,
    );
    const after = {
      revision: (
        await engine.query<{ revision: number }>(
          "SELECT revision FROM poker_branch_state WHERE branch_id='local'",
        )
      ).rows[0].revision,
      data: await readStore(adapt(engine), "local"),
    };
    assert.deepEqual(after, { data: store, revision: 7 });
    assert.equal(
      (await engine.query("SELECT id FROM poker_users")).rows.length,
      0,
    );
  } finally {
    await engine.close();
  }
});
