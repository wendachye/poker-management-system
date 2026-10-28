import test from "node:test";
import assert from "node:assert/strict";
import type { Backup, BackupPayload } from "../src/server/backup";
import { emptyStore } from "../src/domain/selectors";
import type { Transaction } from "../src/domain/model";
import {
  backupRecoveryDigest,
  expectedRecoveryFinancialRows,
  recoveryDigest,
  recoveryDrillTarget,
  recoveryPostgresVersionGuard,
  recoveryRecordCounts,
  recoveryResourceName,
} from "../scripts/recovery-contract";

test("the recovery drill only accepts an explicit disposable loopback target without startup overrides", () => {
  for (const value of [
    undefined,
    "",
    "invalid",
    "postgresql://remote.example/poker_test",
    "postgresql://127.0.0.1/operations",
    "postgresql://127.0.0.1/poker_test?options=-csearch_path=public",
    "postgresql://127.0.0.1/poker_test#ignored",
    "postgresql://127.0.0.1/poker_test_*",
    "postgresql://127.0.0.1:0/poker_test",
  ])
    assert.throws(
      () =>
        recoveryDrillTarget({
          POSTGRES_TEST_DATABASE_URL: value,
          DATABASE_URL: "postgresql://127.0.0.1/poker_test",
        }),
      /POSTGRES_TEST_DATABASE_URL/,
    );
  assert.throws(
    () =>
      recoveryDrillTarget({
        POSTGRES_TEST_DATABASE_URL: "postgresql://127.0.0.1/poker_test",
        PGOPTIONS: "-c search_path=public",
      }),
    /PGOPTIONS/,
  );
  for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
    const selected = recoveryDrillTarget({
      POSTGRES_TEST_DATABASE_URL: `postgresql://fixture:fictional@${host}:55438/poker_test_recovery`,
      DATABASE_URL: "postgresql://production.example/real",
    });
    assert.equal(selected.database, "poker_test_recovery");
    assert.equal(selected.host, host);
    assert.equal(selected.port, 55438);
    assert.equal(selected.expectedPostgresMajor, 17);
  }
});

test("recovery major selection defaults to 17 and only accepts explicit 17 or 18", () => {
  const url =
    "postgresql://fixture:fictional@127.0.0.1:55438/poker_test_recovery";
  assert.equal(
    recoveryDrillTarget({ POSTGRES_TEST_DATABASE_URL: url })
      .expectedPostgresMajor,
    17,
  );
  for (const major of ["17", "18"] as const) {
    const target = recoveryDrillTarget({
      POSTGRES_TEST_DATABASE_URL: url,
      RECOVERY_POSTGRES_MAJOR: major,
    });
    assert.equal(target.expectedPostgresMajor, Number(major));
    assert.equal(target.connectionString, url);
    for (const unsafe of [
      "postgresql://remote.example/poker_test",
      "postgresql://127.0.0.1/operations",
      "postgresql://127.0.0.1/poker_test?options=-csearch_path=public",
    ])
      assert.throws(
        () =>
          recoveryDrillTarget({
            POSTGRES_TEST_DATABASE_URL: unsafe,
            DATABASE_URL: url,
            RECOVERY_POSTGRES_MAJOR: major,
          }),
        /POSTGRES_TEST_DATABASE_URL/,
      );
    assert.throws(
      () =>
        recoveryDrillTarget({
          POSTGRES_TEST_DATABASE_URL: url,
          RECOVERY_POSTGRES_MAJOR: major,
          PGOPTIONS: "-c search_path=public",
        }),
      /PGOPTIONS/,
    );
  }
  for (const invalid of [
    "",
    "16",
    "19",
    " 17",
    "18 ",
    "17.0",
    "018",
    "170000",
    "auto",
    "latest",
    "Infinity",
    "-18",
  ])
    assert.throws(
      () =>
        recoveryDrillTarget({
          POSTGRES_TEST_DATABASE_URL: url,
          RECOVERY_POSTGRES_MAJOR: invalid,
        }),
      /RECOVERY_POSTGRES_MAJOR/,
    );
});

test("recovery version guard verifies exactly the selected actual server major", () => {
  for (const [major, versions] of [
    [17, ["170000", "170011", "179999"]],
    [18, ["180000", "180006", "189999"]],
  ] as const)
    for (const version of versions) {
      assert.deepEqual(recoveryPostgresVersionGuard(major, version), {
        expectedMajor: major,
        actualMajor: major,
        serverVersionNumber: version,
        matches: true,
      });
      const otherMajor = major === 17 ? 18 : 17;
      assert.deepEqual(recoveryPostgresVersionGuard(otherMajor, version), {
        expectedMajor: otherMajor,
        actualMajor: major,
        serverVersionNumber: version,
        matches: false,
      });
    }
  for (const unsupported of ["160009", "190000"])
    for (const major of [17, 18] as const)
      assert.equal(
        recoveryPostgresVersionGuard(major, unsupported).matches,
        false,
      );
  for (const malformed of [
    undefined,
    null,
    180006,
    "",
    "18",
    "1800000",
    "180006.0",
    " 180006",
    "180006extra",
    "private-version-marker",
  ])
    assert.deepEqual(recoveryPostgresVersionGuard(18, malformed), {
      expectedMajor: 18,
      actualMajor: null,
      serverVersionNumber: null,
      matches: false,
    });
});

test("owned recovery identities reject injection and cannot collide through PostgreSQL truncation", () => {
  const suffix = "0123456789abcdef";
  const kinds = [
    "source",
    "destination",
    "source_owner",
    "source_app",
    "destination_owner",
    "destination_app",
  ] as const;
  const names = kinds.map((kind) => recoveryResourceName(suffix, kind));
  assert.equal(new Set(names).size, 6);
  for (const name of names) {
    assert.match(name, /^poker_test_recovery_[a-f0-9]{16}_[a-z_]+$/);
    assert.ok(Buffer.byteLength(name) <= 63);
  }
  for (const invalid of [
    "",
    "f".repeat(17),
    "G".repeat(16),
    '"; DROP SCHEMA public',
  ])
    assert.throws(() => recoveryResourceName(invalid, "source"));
  assert.throws(() => recoveryResourceName(suffix, 'source";DROP' as "source"));
});

test("recovery digests ignore object key order and capture time but preserve record order", () => {
  assert.equal(
    recoveryDigest({ second: 2, first: { z: 3, a: 1 } }),
    recoveryDigest({ first: { a: 1, z: 3 }, second: 2 }),
  );
  assert.notEqual(
    recoveryDigest([{ id: "first" }, { id: "second" }]),
    recoveryDigest([{ id: "second" }, { id: "first" }]),
  );
  const original = {
    payload: { createdAt: "first", branches: [{ id: "same" }] },
    checksum: "one",
  } as Backup;
  const next = {
    payload: { createdAt: "later", branches: [{ id: "same" }] },
    checksum: "two",
  } as Backup;
  assert.equal(backupRecoveryDigest(original), backupRecoveryDigest(next));
  assert.notEqual(
    backupRecoveryDigest(original),
    backupRecoveryDigest({
      ...next,
      payload: {
        ...next.payload,
        branches: [{ id: "changed", name: "Changed", timezone: "UTC" }],
      },
    }),
  );
});

function entry(id: string, patch: Partial<Transaction>): Transaction {
  return {
    id,
    dayId: "day",
    type: "Buy-in",
    playerId: "cash-player",
    tableId: "table",
    amount: 0,
    cashReceived: 0,
    cashPayout: 0,
    creditDelta: 0,
    staff: "Fictional staff",
    staffId: "staff",
    time: "2026-10-20T00:00:00.000Z",
    note: "Fictional arithmetic fixture",
    approvalId: "approval-" + id,
    ...patch,
  };
}

test("independent recovery arithmetic includes all scopes and original-type reversal signs", () => {
  const store = emptyStore();
  store.transactions = [
    entry("cash", { amount: 50_000, cashReceived: 50_000 }),
    entry("reverse-cash", {
      type: "Reversal",
      reversesId: "cash",
      amount: -50_000,
      cashReceived: -50_000,
    }),
    entry("credit", {
      playerId: "credit-player",
      amount: 20_000,
      creditDelta: 20_000,
    }),
    entry("repayment", {
      type: "Credit Repayment",
      playerId: "credit-player",
      amount: 5_000,
      cashReceived: 5_000,
      creditDelta: -5_000,
    }),
    entry("insurance-premium", {
      type: "Insurance Premium",
      playerId: undefined,
      amount: 2_000,
      cashReceived: 2_000,
    }),
    entry("insurance-payout", {
      type: "Insurance Payout",
      playerId: undefined,
      amount: 500,
      cashPayout: 500,
    }),
  ];
  const rows = expectedRecoveryFinancialRows([
    { branch_id: "venue", data: store },
  ]);
  const venue = rows.find((row) => row.scope === "VENUE")!;
  assert.equal(venue.buy_in, "20000");
  assert.equal(venue.cash_received, "7000");
  assert.equal(venue.cash_payout, "500");
  assert.equal(venue.credit_delta, "15000");
  assert.equal(venue.insurance, "1500");
  assert.deepEqual(
    new Set(rows.map((row) => row.scope)),
    new Set(["VENUE", "DAY", "PLAYER", "PLAYER_DAY", "TABLE_DAY"]),
  );
  assert.equal(
    rows.find(
      (row) => row.scope === "PLAYER" && row.entity_id === "cash-player",
    )!.buy_in,
    "0",
  );
  assert.equal(
    rows.find(
      (row) => row.scope === "PLAYER" && row.entity_id === "credit-player",
    )!.credit_delta,
    "15000",
  );
  const other = expectedRecoveryFinancialRows([
    { branch_id: "other", data: store },
  ]);
  assert.ok(other.every((row) => row.branch_id === "other"));
  const broken = {
    ...store,
    transactions: [
      entry("unresolved", { type: "Reversal", reversesId: "missing" }),
    ],
  };
  assert.throws(
    () => expectedRecoveryFinancialRows([{ branch_id: "venue", data: broken }]),
    /unresolved reversal/,
  );
});

test("recovery comparison keeps exact integers and report counts do not expose record secrets", () => {
  const store = emptyStore();
  store.transactions = [
    entry("large-first", {
      amount: Number.MAX_SAFE_INTEGER,
      cashReceived: Number.MAX_SAFE_INTEGER,
    }),
    entry("large-second", {
      amount: Number.MAX_SAFE_INTEGER,
      cashReceived: Number.MAX_SAFE_INTEGER,
    }),
  ];
  const rows = expectedRecoveryFinancialRows([
    { branch_id: "venue", data: store },
  ]);
  assert.equal(
    rows.find((row) => row.scope === "VENUE")!.cash_received,
    "18014398509481982",
  );
  const payload = {
    branches: [{ id: "venue" }],
    users: [{ password_hash: "private-hash-marker" }],
    memberships: [],
    operations: [],
    states: [{ branch_id: "venue", data: store }],
  } as unknown as BackupPayload;
  const counts = recoveryRecordCounts(payload);
  assert.equal(counts.transactions, 2);
  assert.equal(counts.users, 1);
  assert.equal(counts.branches, 1);
  assert.equal(JSON.stringify(counts).includes("private-hash-marker"), false);
});
