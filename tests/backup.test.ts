import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "./helpers/database";
import { seedLocalSamples } from "../scripts/sample-data";
import {
  createBackup,
  parseBackup,
  restoreBackup,
  sealBackup,
  type Backup,
} from "../src/server/backup";
import { hashPassword, login, sessionUser } from "../src/server/auth";
import { readStore } from "../src/server/storage";

test("full backup round trip preserves sample records, credentials and retry markers, but revokes sessions", async () => {
  const { db, engine } = await testDatabase();
  try {
    await seedLocalSamples(db, new Date("2026-10-02T15:00:00Z"));
    await db.query(
      "INSERT INTO poker_users(id,username,password_hash) VALUES('local-admin','local.admin',$1)",
      [await hashPassword("local-test-password")],
    );
    await db.query(
      "INSERT INTO poker_memberships(user_id,branch_id,role) VALUES('local-admin','local','ADMIN')",
    );
    const token = await login(db, "local.admin", "local-test-password");
    await db.query(
      "INSERT INTO poker_login_attempts(username,attempts,window_start) VALUES('!unknown:7',11,now())",
    );
    const backup = await createBackup(db);
    const fromFile = parseBackup(JSON.parse(JSON.stringify(backup, null, 2)));
    assert.equal(
      fromFile.payload.states.find((s) => s.branch_id === "local")!.data
        .transactions.length,
      86,
    );
    assert.equal(JSON.stringify(backup).includes(token), false);
    await db.query("UPDATE poker_branches SET name='Changed' WHERE id='local'");
    let before: Backup | undefined;
    await restoreBackup(db, fromFile, async (value) => {
      before = value;
    });
    assert.equal(
      before!.payload.branches.find((b) => b.id === "local")!.name,
      "Changed",
    );
    const restored = await createBackup(db);
    assert.deepEqual(
      { ...restored.payload, createdAt: "" },
      { ...backup.payload, createdAt: "" },
    );
    assert.equal(await sessionUser(db, token), null);
    assert.equal(
      (await db.query("SELECT * FROM poker_login_budget")).rows.length,
      0,
    );
    assert.equal(
      (await db.query("SELECT * FROM poker_login_attempts")).rows.length,
      0,
    );
    assert.ok(await login(db, "local.admin", "local-test-password"));
    assert.equal((await seedLocalSamples(db)).added, false);
  } finally {
    await engine.close();
  }
});
test("bounded retry contexts survive restore and older backups without them remain compatible", async () => {
  const { db, engine } = await testDatabase();
  try {
    await seedLocalSamples(db, new Date("2026-10-02T15:00:00Z"));
    const store = await readStore(db, "local");
    const context = {
      playerIds: [store.profiles[0].id],
      approvalIds: [store.approvals[0].id],
      transactionIds: [store.transactions[0].id],
    };
    await db.query(
      "UPDATE poker_operations SET result_context=$1 WHERE branch_id='local'",
      [JSON.stringify(context)],
    );
    const backup = await createBackup(db);
    assert.deepEqual(backup.payload.operations[0].result_context, context);
    await restoreBackup(db, backup, async () => {});
    assert.deepEqual(
      (
        await db.query<{ result_context: unknown }>(
          "SELECT result_context FROM poker_operations WHERE branch_id='local'",
        )
      ).rows[0].result_context,
      context,
    );
    const broken = structuredClone(backup.payload);
    broken.operations[0].result_context!.playerIds = ["missing-player"];
    assert.throws(() => parseBackup(sealBackup(broken)), /missing record/i);
    const legacy = structuredClone(backup.payload);
    delete legacy.operations[0].result_context;
    await restoreBackup(db, sealBackup(legacy), async () => {});
    assert.deepEqual(
      (
        await db.query<{ result_context: unknown }>(
          "SELECT result_context FROM poker_operations WHERE branch_id='local'",
        )
      ).rows[0].result_context,
      {},
    );
    assert.deepEqual(await readStore(db, "local"), store);
  } finally {
    await engine.close();
  }
});

test("damaged or incomplete backups and failed safety backups leave the database intact", async () => {
  const { db, engine } = await testDatabase();
  try {
    const backup = await createBackup(db);
    const damaged = structuredClone(backup);
    damaged.payload.branches[0].name = "Tampered";
    await assert.rejects(
      restoreBackup(db, damaged, async () =>
        assert.fail("must not start restore"),
      ),
      /checksum/,
    );
    const invalid = structuredClone(backup.payload);
    invalid.states[0].data.currentDayId = "missing-day";
    assert.throws(() => parseBackup(sealBackup(invalid)), /reference/);
    const incomplete = structuredClone(backup.payload);
    incomplete.states = [];
    assert.throws(
      () => parseBackup(sealBackup(incomplete)),
      /missing branch state/,
    );
    assert.throws(
      () => parseBackup({ branchId: "local", data: {} }),
      /Not a full local backup/,
    );
    await assert.rejects(
      restoreBackup(db, backup, async () => {
        throw new Error("disk is full");
      }),
      /disk is full/,
    );
    assert.deepEqual(
      { ...(await createBackup(db)).payload, createdAt: "" },
      { ...backup.payload, createdAt: "" },
    );
  } finally {
    await engine.close();
  }
});
test("a write failure during replacement rolls the whole restore back", async () => {
  const { db, engine } = await testDatabase();
  try {
    const original = await createBackup(db);
    const replacement = structuredClone(original.payload);
    replacement.branches[0].name = "Replacement";
    const faulty = {
      ...db,
      transaction: <T>(work: Parameters<typeof db.transaction<T>>[0]) =>
        db.transaction((connection) =>
          work({
            query: async <R>(sql: string, values?: unknown[]) => {
              if (sql.startsWith("INSERT INTO poker_branch_state"))
                throw new Error("simulated write failure");
              return connection.query<R>(sql, values);
            },
          }),
        ),
    };
    await assert.rejects(
      restoreBackup(faulty, sealBackup(replacement), async () => {}),
      /simulated write failure/,
    );
    assert.deepEqual(
      { ...(await createBackup(db)).payload, createdAt: "" },
      { ...original.payload, createdAt: "" },
    );
  } finally {
    await engine.close();
  }
});
