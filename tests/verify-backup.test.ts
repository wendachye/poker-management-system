import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "./helpers/database";
import { seedLocalSamples } from "../scripts/sample-data";
import { createBackup, sealBackup } from "../src/server/backup";
import { verifyBackup } from "../scripts/verify-backup";

test("offline restore verification accepts legacy retry-context defaults without losing authoritative records", async () => {
  const { db, engine } = await testDatabase();
  try {
    await seedLocalSamples(db, new Date("2026-10-02T15:00:00Z"));
    const original = await createBackup(db);
    const payload = structuredClone(original.payload);
    assert.ok(payload.operations.length > 0);
    for (const operation of payload.operations) delete operation.result_context;
    const source = JSON.stringify(original);
    await verifyBackup(sealBackup(payload));
    assert.equal(JSON.stringify(original), source);
  } finally {
    await engine.close();
  }
});
