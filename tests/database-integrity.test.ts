import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "./helpers/database";
import { seedLocalSamples } from "../scripts/sample-data";
import { createBackup, restoreBackup } from "../src/server/backup";
import {
  verifyDatabaseIntegrity,
  DatabaseIntegrityError,
} from "../src/server/integrity";

test("explicit database verification checks exact records and projections without returning private data or changing state", async () => {
  const { db, engine } = await testDatabase();
  try {
    await seedLocalSamples(db, new Date("2026-10-02T15:00:00Z"));
    const before = await createBackup(db);
    const report = await verifyDatabaseIntegrity(db);
    assert.equal(report.readOnly, true);
    assert.equal(report.venueCount, 2);
    assert.equal(report.counts.transactions, 86);
    assert.ok(report.counts.financialSummaryRows > 0);
    assert.ok(report.checks.includes("independent-financial-summary-parity"));
    for (const privateField of [
      "password_hash",
      "fingerprint",
      "cashReceived",
      "creditDelta",
      "sample.admin",
    ])
      assert.equal(JSON.stringify(report).includes(privateField), false);
    const after = await createBackup(db);
    assert.deepEqual(
      { ...after.payload, createdAt: "" },
      { ...before.payload, createdAt: "" },
    );
  } finally {
    await engine.close();
  }
});

test("wrong, missing and extra projections fail verification; a validated restore rebuilds them", async () => {
  const { db, engine } = await testDatabase();
  try {
    await seedLocalSamples(db, new Date("2026-10-02T15:00:00Z"));
    const backup = await createBackup(db);
    const wrong = (error: unknown) =>
      error instanceof DatabaseIntegrityError &&
      error.code === "FINANCIAL_SUMMARY_MISMATCH";
    await db.query(
      "UPDATE poker_financial_totals SET cash_received=cash_received+1 WHERE branch_id='local' AND scope='VENUE'",
    );
    await assert.rejects(verifyDatabaseIntegrity(db), wrong);
    await restoreBackup(db, backup, async () => {});
    await verifyDatabaseIntegrity(db);
    await db.query(
      "DELETE FROM poker_financial_totals WHERE branch_id='local' AND scope='VENUE'",
    );
    await assert.rejects(verifyDatabaseIntegrity(db), wrong);
    await restoreBackup(db, backup, async () => {});
    await db.query(
      "INSERT INTO poker_financial_totals(branch_id,scope,entity_id,day_id) VALUES('other','VENUE','','')",
    );
    await assert.rejects(verifyDatabaseIntegrity(db), wrong);
    await restoreBackup(db, backup, async () => {});
    await verifyDatabaseIntegrity(db);
  } finally {
    await engine.close();
  }
});

test("verification uses one read-only repeatable-read transaction and rejects incomplete migration history", async () => {
  const { db, engine } = await testDatabase();
  try {
    const statements: string[] = [];
    const observed = {
      ...db,
      transaction: <T>(work: Parameters<typeof db.transaction<T>>[0]) =>
        db.transaction((connection) =>
          work({
            query: async <R>(sql: string, values?: unknown[]) => {
              statements.push(sql);
              return connection.query<R>(sql, values);
            },
          }),
        ),
    };
    await verifyDatabaseIntegrity(observed);
    assert.equal(
      statements[0],
      "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    assert.equal(
      statements.filter((sql) =>
        /^\s*(?:INSERT|UPDATE|DELETE|TRUNCATE|ALTER|CREATE|DROP|LOCK)\b/i.test(
          sql,
        ),
      ).length,
      0,
    );
    await db.query("DELETE FROM poker_schema_migrations WHERE version=4");
    await assert.rejects(
      verifyDatabaseIntegrity(db),
      (error: unknown) =>
        error instanceof DatabaseIntegrityError &&
        error.code === "SCHEMA_NOT_READY",
    );
  } finally {
    await engine.close();
  }
});
