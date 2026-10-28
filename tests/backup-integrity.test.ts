import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "./helpers/database";
import { seedLocalSamples } from "../scripts/sample-data";
import {
  captureBackup,
  createBackup,
  parseBackup,
  restoreBackup,
  sealBackup,
  type Backup,
} from "../src/server/backup";
import { FinancialIntegrityError } from "../src/domain/store-integrity";
import { readStore } from "../src/server/storage";
import type { Database } from "../src/server/database";

test("sealed financial corruptions are rejected before a restore transaction or safety write", async () => {
  const { db, engine } = await testDatabase();
  try {
    await seedLocalSamples(db, new Date("2026-10-02T15:00:00Z"));
    const good = await createBackup(db),
      broken = structuredClone(good.payload);
    const store = broken.states.find(
      (row) => row.data.transactions.length,
    )!.data;
    const tx = store.transactions.find(
      (tx) => tx.type === "Buy-in" && tx.cashReceived > 0,
    )!;
    tx.cashReceived++;
    const corrupt = sealBackup(broken);
    assert.throws(() => parseBackup(corrupt), FinancialIntegrityError);
    let touched = false;
    const forbidden: Database = {
      query: async () => {
        touched = true;
        throw new Error("Must not query");
      },
      transaction: async () => {
        touched = true;
        throw new Error("Must not transact");
      },
    };
    await assert.rejects(
      restoreBackup(forbidden, corrupt, async () => {
        touched = true;
      }),
      FinancialIntegrityError,
    );
    assert.equal(touched, false);
    const captured = await db.transaction((connection) =>
      captureBackup(connection),
    );
    assert.deepEqual(
      { ...captured.payload, createdAt: "" },
      { ...good.payload, createdAt: "" },
    );
  } finally {
    await engine.close();
  }
});

test("a validated backup can heal corrupt current finances while preserving an unverified forensic safety copy", async () => {
  const { db, engine } = await testDatabase();
  try {
    await seedLocalSamples(db, new Date("2026-10-02T15:00:00Z"));
    const good = await createBackup(db);
    const branch = good.payload.states.find(
      (row) => row.data.transactions.length,
    )!;
    const tx = branch.data.transactions.find(
      (tx) => tx.type === "Buy-in" && tx.cashReceived > 0,
    )!;
    await db.query(
      "UPDATE poker_ledger SET data=jsonb_set(data,'{cashReceived}',to_jsonb(cash_received+1)) WHERE branch_id=$1 AND id=$2",
      [branch.branch_id, tx.id],
    );
    await assert.rejects(createBackup(db), FinancialIntegrityError);
    let safety: Backup | undefined;
    await restoreBackup(db, good, async (value) => {
      safety = value;
    });
    assert.ok(safety);
    assert.equal(sealBackup(safety.payload).checksum, safety.checksum);
    assert.throws(
      () => parseBackup(safety),
      FinancialIntegrityError,
      "The forensic safety copy is not a verified restorable backup",
    );
    const badTx = safety.payload.states
      .find((row) => row.branch_id === branch.branch_id)!
      .data.transactions.find((row) => row.id === tx.id)!;
    assert.equal(badTx.cashReceived, tx.cashReceived + 1);
    assert.equal(
      (await readStore(db, branch.branch_id)).transactions.find(
        (row) => row.id === tx.id,
      )!.cashReceived,
      tx.cashReceived,
    );
    const restored = await createBackup(db);
    assert.deepEqual(
      { ...restored.payload, createdAt: "" },
      { ...good.payload, createdAt: "" },
    );
  } finally {
    await engine.close();
  }
});

test("backup revisions stay within database integer bounds and retry markers cannot exceed their containing state", async () => {
  const { db, engine } = await testDatabase();
  try {
    await seedLocalSamples(db, new Date("2026-10-02T15:00:00Z"));
    const good = await createBackup(db);
    for (const invalid of [2_147_483_648, Number.MAX_SAFE_INTEGER + 1]) {
      const state = structuredClone(good.payload);
      state.states[0].revision = invalid;
      assert.throws(() => parseBackup(sealBackup(state)), /format or data/i);
      const operation = structuredClone(good.payload);
      operation.operations[0].revision = invalid;
      assert.throws(
        () => parseBackup(sealBackup(operation)),
        /format or data/i,
      );
    }
    const future = structuredClone(good.payload);
    const operation = future.operations[0];
    operation.revision =
      future.states.find((state) => state.branch_id === operation.branch_id)!
        .revision + 1;
    assert.throws(() => parseBackup(sealBackup(future)), /revision exceeds/i);
    assert.doesNotThrow(() => parseBackup(good));
  } finally {
    await engine.close();
  }
});
