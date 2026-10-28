import { test } from "node:test";
import assert from "node:assert/strict";
import type { Staff } from "../src/domain/model";
import { DomainError } from "../src/domain/operations";
import { parseBackup, sealBackup } from "../src/server/backup";
import type { Database } from "../src/server/database";
import {
  mixedHistory,
  mixedOptions,
  mixedRunner,
  summarizeMeasurements,
  type Measurement,
} from "../scripts/mixed-workload-scenario";

test("mixed workload bounds venue, worker, financial-cycle and retained-history allocations", () => {
  assert.deepEqual(mixedOptions({}), {
    venues: 2,
    staffPerVenue: 10,
    workers: 20,
    retainedEntriesPerVenue: 1000,
    cycles: 2,
    readRoundsPerReader: 20,
    readersPerVenue: 5,
    readPauseMs: 25,
  });
  const larger = mixedOptions({
    MIXED_VENUES: "5",
    MIXED_CYCLES: "10",
    MIXED_RETAINED_ENTRIES: "10000",
    MIXED_READ_ROUNDS: "100",
  });
  assert.equal(larger.workers, 50);
  for (const [key, value] of [
    ["MIXED_VENUES", "1"],
    ["MIXED_VENUES", "3"],
    ["MIXED_VENUES", "6"],
    ["MIXED_CYCLES", "0"],
    ["MIXED_CYCLES", "11"],
    ["MIXED_CYCLES", "1.5"],
    ["MIXED_RETAINED_ENTRIES", "20001"],
    ["MIXED_RETAINED_ENTRIES", "-1"],
    ["MIXED_READ_ROUNDS", "101"],
    ["MIXED_READ_ROUNDS", " "],
  ])
    assert.throws(() => mixedOptions({ [key]: value }), new RegExp(key));
});

test("mixed retained fixture passes independent complete financial backup validation", () => {
  const staff: Staff[] = Array.from({ length: 10 }, (_, index) => ({
    id: `fictional_staff_${index}`,
    username: `fictional_staff_${index}`,
    branchId: "mixed_test",
    role: index === 0 ? "ADMIN" : index < 3 ? "MANAGER" : "CASHIER",
  }));
  const store = mixedHistory("mixed_test", staff, 45);
  const payload = {
    format: "poker-local-backup" as const,
    version: 1 as const,
    createdAt: "2026-10-29T00:00:00.000Z",
    branches: [
      { id: "mixed_test", name: "mixed_test", timezone: "Asia/Kuala_Lumpur" },
    ],
    users: staff.map((row) => ({
      id: row.id,
      username: row.username,
      password_hash: "fictional-unusable-hash",
      active: true,
    })),
    memberships: staff.map((row) => ({
      user_id: row.id,
      branch_id: row.branchId,
      role: row.role,
    })),
    states: [{ branch_id: "mixed_test", revision: 0, data: store }],
    operations: [],
  };
  assert.equal(
    parseBackup(sealBackup(payload)).payload.states[0].data.transactions.length,
    45,
  );
  assert.equal(store.profiles.length, 100);
  assert.equal(store.auditLogs.length, 90);
  const damaged = structuredClone(payload);
  damaged.states[0].data.days[0].closes[0].expectedCash++;
  assert.throws(() => parseBackup(sealBackup(damaged)));
  const brokenReference = structuredClone(payload);
  brokenReference.states[0].data.transactions[0].approvalId = "absent";
  assert.throws(() => parseBackup(sealBackup(brokenReference)));
});

test("only deliberate named race/isolation failures are classified as expected", async () => {
  const rows: Measurement[] = [];
  const runner = mixedRunner({} as Database, rows);
  const fail = (status: number) => async () => {
    throw new DomainError("Fictional failure", status);
  };
  await assert.rejects(runner.measure("ordinary", fail(409)));
  await assert.rejects(runner.measure("ordinary", fail(409), "ordinary", 409));
  await assert.rejects(
    runner.measure("named-seat-race", fail(409), "deliberate-race", 409),
  );
  await assert.rejects(
    runner.measure("named-seat-race", fail(403), "deliberate-race", 409),
  );
  await assert.rejects(
    runner.measure("foreign-player", fail(404), "isolation", 404),
  );
  assert.deepEqual(
    rows.map((row) => row.outcome),
    ["error", "error", "expected-conflict", "error", "expected-denial"],
  );
  const summary = summarizeMeasurements(rows);
  assert.equal(
    summary.find((row) => row.action === "ordinary")?.errors.HTTP_409,
    2,
  );
  assert.equal(
    summary.find((row) => row.action === "named-seat-race")?.expectedConflicts,
    1,
  );
  assert.equal(
    summary.find((row) => row.action === "named-seat-race")?.errors.HTTP_403,
    1,
  );
});

test("descriptive measurements retain failures, barrier timing and response sizes separately", () => {
  const summary = summarizeMeasurements([
    {
      action: "approve",
      mode: "ordinary",
      ms: 20,
      bytes: 100,
      outcome: "success",
    },
    {
      action: "approve",
      mode: "ordinary",
      ms: 100,
      outcome: "error",
      error: "HTTP_409",
    },
    {
      action: "approve",
      mode: "deliberate-race",
      ms: 300,
      outcome: "expected-conflict",
      error: "HTTP_409",
    },
  ]);
  assert.equal(summary[0].latency.p95Ms, 100);
  assert.equal(summary[0].successfulLatency.p95Ms, 20);
  assert.equal(summary[0].errors.HTTP_409, 1);
  assert.deepEqual(summary[0].responseBytes, {
    samples: 1,
    min: 100,
    max: 100,
  });
  assert.equal(summary[1].latency.p95Ms, 300);
  assert.equal(summary[1].expectedConflicts, 1);
});
