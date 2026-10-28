import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { Database, SqlConnection } from "../src/server/database";
import { createBackup } from "../src/server/backup";
import { readBackupFile } from "../scripts/backup-files";
import { backupNativeSamples } from "../scripts/local-postgres-backup";
import {
  initializeNativeSamples,
  NATIVE_APP,
  NATIVE_SCHEMA,
  type NativeLocalSecrets,
} from "../scripts/local-postgres-setup";

async function fixture(initialized = true) {
  const engine = await PGlite.create();
  const adapt = (connection: Pick<PGlite, "query">): SqlConnection => ({
    async query<T>(sql: string, values?: unknown[]) {
      return { rows: (await connection.query<T>(sql, values)).rows };
    },
  });
  const db: Database = {
    ...adapt(engine),
    transaction: (work) =>
      engine.transaction((tx) => work(adapt(tx as unknown as PGlite))),
  };
  const secrets: NativeLocalSecrets = {
    version: 1,
    workspace: "123456789abc",
    bootstrapPassword: randomBytes(32).toString("hex"),
    ownerPassword: randomBytes(32).toString("hex"),
    appPassword: randomBytes(32).toString("hex"),
  };
  if (initialized) {
    await initializeNativeSamples(
      db,
      secrets,
      new Date("2026-10-29T15:00:00Z"),
      "postgres",
    );
    await db.query(`SET ROLE ${NATIVE_APP}`);
    await db.query(`SET search_path TO ${NATIVE_SCHEMA},pg_catalog`);
  }
  const directory = await mkdtemp(join(tmpdir(), "poker-native-backup-test-"));
  return {
    engine,
    db,
    secrets,
    directory,
    close: async () => {
      await engine.close();
      for (const filename of await readdir(directory))
        await unlink(join(directory, filename));
      await rmdir(directory);
    },
  };
}

test("native backup reads one immutable snapshot and verifies the published file without modifying its source", async () => {
  const { db, secrets, directory, close } = await fixture();
  try {
    const before = await createBackup(db);
    const statements: string[] = [];
    const observed: Database = {
      ...db,
      transaction: (work) =>
        db.transaction((connection) =>
          work({
            query: async <T>(sql: string, values?: unknown[]) => {
              statements.push(sql);
              return connection.query<T>(sql, values);
            },
          }),
        ),
    };
    const report = await backupNativeSamples(
      observed,
      directory,
      secrets.workspace,
      "postgres",
    );
    assert.equal(report.readOnlyCapture, true);
    assert.equal(report.isolatedRestoreVerified, true);
    assert.equal(report.transactions, 86);
    assert.equal(report.branches, 2);
    assert.match(report.checksum, /^[a-f0-9]{64}$/);
    assert.ok(report.bytes > 0);
    assert.equal(
      statements[0],
      "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    assert.equal(
      statements.filter((sql) =>
        /^\s*(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT|REVOKE|LOCK|TRUNCATE)\b/i.test(
          sql,
        ),
      ).length,
      0,
    );
    const saved = await readBackupFile(report.filename);
    assert.equal(saved.checksum, report.checksum);
    const after = await createBackup(db);
    assert.deepEqual(
      { ...after.payload, createdAt: "" },
      { ...before.payload, createdAt: "" },
    );
    assert.deepEqual(
      { ...saved.payload, createdAt: "" },
      { ...before.payload, createdAt: "" },
    );
    assert.deepEqual(await readdir(directory), [
      report.filename.slice(
        report.filename.lastIndexOf(process.platform === "win32" ? "\\" : "/") +
          1,
      ),
    ]);
  } finally {
    await close();
  }
});

test("native backup refuses missing initialization and wrong workspace before publishing any file", async () => {
  const uninitialized = await fixture(false);
  try {
    await uninitialized.db.query(`CREATE SCHEMA ${NATIVE_SCHEMA}`);
    await uninitialized.db.query(
      `SET search_path TO ${NATIVE_SCHEMA},pg_catalog`,
    );
    await assert.rejects(
      backupNativeSamples(
        uninitialized.db,
        uninitialized.directory,
        uninitialized.secrets.workspace,
        "postgres",
      ),
      /not initialized/,
    );
    assert.deepEqual(await readdir(uninitialized.directory), []);
    assert.equal(
      (
        await uninitialized.db.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1",
          [NATIVE_SCHEMA],
        )
      ).rows[0].count,
      "0",
    );
  } finally {
    await uninitialized.close();
  }
  const initialized = await fixture();
  try {
    await assert.rejects(
      backupNativeSamples(
        initialized.db,
        initialized.directory,
        "another-workspace",
        "postgres",
      ),
      /another workspace/,
    );
    await assert.rejects(
      backupNativeSamples(
        initialized.db,
        initialized.directory,
        initialized.secrets.workspace,
        "wrong_database",
      ),
      /initialized native local/,
    );
    assert.deepEqual(await readdir(initialized.directory), []);
  } finally {
    await initialized.close();
  }
});
