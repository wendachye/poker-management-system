import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { initializeLocal } from "../scripts/local-setup";
import { login, sessionUser } from "../src/server/auth";
import { mutate, readSnapshot } from "../src/server/repository";
import type { Database, SqlConnection } from "../src/server/database";
import { defaultSettings } from "../src/domain/settings";
import type { Command } from "../src/domain/commands";

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

test("local accounts and branch records survive a database restart without reseeding", async () => {
  const directory = await mkdtemp(join(tmpdir(), "poker-local-test-"));
  let engine = await PGlite.create(directory);
  try {
    const db = adapt(engine);
    const accounts = await initializeLocal(db);
    assert.equal(accounts.length, 3);
    const admin = accounts.find((account) => account.role === "ADMIN")!;
    const token = await login(db, admin.username, admin.password);
    await db.query(
      "UPDATE poker_users SET username='admin' WHERE username=$1",
      [admin.username],
    );
    const { setupCompleted: _, ...settings } = defaultSettings();
    void _;
    let revision = 0;
    for (const command of [
      { kind: "UPDATE_SETTINGS", settings, reason: "Initial local setup" },
      { kind: "TABLE", name: "Main table", dealer: "", status: "OPEN" },
      { kind: "COMPLETE_SETUP" },
      { kind: "OPEN_DAY", date: "2026-10-02", openingCash: 12345 },
    ] satisfies Command[]) {
      const next = await mutate(db, token, {
        branchId: "local",
        operationId: crypto.randomUUID(),
        revision,
        command,
      });
      revision = next.revision;
    }
    await engine.close();
    engine = await PGlite.create(directory);
    const reopened = adapt(engine);
    assert.deepEqual(await initializeLocal(reopened), []);
    const nextToken = await login(reopened, "admin", admin.password);
    assert.equal(
      (
        await reopened.query(
          "SELECT id FROM poker_users WHERE username='local.admin'",
        )
      ).rows.length,
      0,
    );
    const snapshot = await readSnapshot(reopened, nextToken);
    assert.equal(snapshot.store.days.length, 1);
    assert.equal(snapshot.store.days[0].openingCash, 12345);
    assert.equal(snapshot.revision, 4);
    assert.equal(snapshot.store.settings?.setupCompleted, true);
    const cashier = accounts.find((account) => account.role === "CASHIER")!;
    const cashierToken = await login(
      reopened,
      cashier.username,
      cashier.password,
    );
    assert.equal((await sessionUser(reopened, cashierToken))?.role, "CASHIER");
  } finally {
    if (!engine.closed) await engine.close();
    // Only this test's freshly allocated temporary directory is removed.
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith("poker-local-test-"));
    await rm(directory, { recursive: true, force: true });
  }
});
