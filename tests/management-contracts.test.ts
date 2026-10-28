import assert from "node:assert/strict";
import { test } from "node:test";
import type { Snapshot } from "../src/domain/model";
import { emptyStore } from "../src/domain/selectors";
import {
  authReceipt,
  okReceipt,
  snapshotReceipt,
  staffReceipt,
} from "../src/lib/management-contracts";
import { ManagementResponseError } from "../src/lib/management-response";
import { createPrototypeSample } from "../src/prototype/sample-data";

function snapshot(): Snapshot {
  return {
    revision: 0,
    branch: {
      id: "test-venue",
      name: "Test venue",
      timezone: "Asia/Kuala_Lumpur",
      role: "ADMIN",
    },
    user: {
      id: "test-admin",
      username: "test.admin",
      branchId: "test-venue",
      role: "ADMIN",
    },
    store: emptyStore(),
  };
}

function unconfirmed(error: unknown) {
  assert.ok(error instanceof ManagementResponseError);
  assert.equal(error.status, 200);
  assert.equal(error.uncertain, true);
  assert.equal(error.requestId, null);
  assert.equal(
    error.message,
    "The server response could not be confirmed. Refresh records and retry the last request.",
  );
  return true;
}

test("an empty-store snapshot is a valid initial operations receipt", () => {
  const source = snapshot();
  assert.equal(snapshotReceipt(source), source);
  assert.deepEqual(snapshotReceipt(JSON.parse(JSON.stringify(source))), source);
});

test("missing snapshot envelopes cannot confirm a saved operation", () => {
  for (const malformed of [undefined, null, {}, [], 1, "ok", { ok: true }])
    assert.throws(() => snapshotReceipt(malformed), unconfirmed);
});

test("snapshot revisions must be nonnegative safe integers", () => {
  for (const revision of [
    undefined,
    null,
    "1",
    -1,
    0.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ])
    assert.throws(
      () => snapshotReceipt({ ...snapshot(), revision }),
      unconfirmed,
    );
  assert.equal(
    snapshotReceipt({ ...snapshot(), revision: Number.MAX_SAFE_INTEGER })
      .revision,
    Number.MAX_SAFE_INTEGER,
  );
});

test("snapshot identity must describe the same active venue and role", () => {
  const source = snapshot();
  for (const malformed of [
    { ...source, branch: null },
    { ...source, user: null },
    { ...source, user: { ...source.user, branchId: "other-venue" } },
    { ...source, user: { ...source.user, role: "CASHIER" } },
    { ...source, branch: { ...source.branch, role: "OWNER" } },
    { ...source, branch: { ...source.branch, timezone: "" } },
    { ...source, user: { ...source.user, id: "" } },
  ])
    assert.throws(() => snapshotReceipt(malformed), unconfirmed);
});

test("all store collections must be present as arrays before replacing client state", () => {
  const collections = [
    "profiles",
    "sessions",
    "tables",
    "transactions",
    "approvals",
    "auditLogs",
    "days",
  ];
  for (const name of collections) {
    for (const replacement of [undefined, null, {}]) {
      const source = snapshot();
      assert.throws(
        () =>
          snapshotReceipt({
            ...source,
            store: { ...source.store, [name]: replacement },
          }),
        unconfirmed,
      );
    }
  }
});

test("store version and current-day envelope must be understood", () => {
  for (const store of [
    null,
    [],
    {},
    { ...emptyStore(), schemaVersion: 2 },
    { ...emptyStore(), currentDayId: undefined },
    { ...emptyStore(), currentDayId: "" },
    { ...emptyStore(), currentDayId: 3 },
  ])
    assert.throws(() => snapshotReceipt({ ...snapshot(), store }), unconfirmed);
});

test("all real prototype scenarios survive JSON transfer and the operations envelope check", () => {
  for (const scenario of ["busy", "walkthrough", "closing"] as const) {
    const sample = createPrototypeSample(
      "demo-city",
      "City Centre",
      scenario,
      new Date("2026-10-28T04:00:00Z"),
    );
    const admin = sample.accounts.find((account) => account.role === "ADMIN")!;
    const source = {
      revision: 7,
      branch: { ...snapshot().branch, id: "demo-city", name: "City Centre" },
      user: {
        id: admin.id,
        username: admin.username,
        role: admin.role,
        branchId: "demo-city",
      },
      store: sample.store,
    };
    const transferred = JSON.parse(JSON.stringify(source));
    assert.equal(snapshotReceipt(transferred), transferred);
    assert.equal(
      transferred.store.profiles.length,
      sample.store.profiles.length,
    );
    assert.equal(
      transferred.store.transactions.length,
      sample.store.transactions.length,
    );
    assert.deepEqual(
      staffReceipt(
        JSON.parse(
          JSON.stringify({ branchId: "demo-city", accounts: sample.accounts }),
        ),
      ),
      { branchId: "demo-city", accounts: sample.accounts },
    );
  }
});

test("auth receipts accept multiple venue roles when the active membership agrees", () => {
  const source = snapshot();
  const data = {
    user: source.user,
    branches: [
      source.branch,
      { ...source.branch, id: "other-venue", role: "CASHIER" },
    ],
  };
  assert.deepEqual(authReceipt(JSON.parse(JSON.stringify(data))), data);
});

test("auth receipts reject absent, invalid or conflicting active memberships", () => {
  const source = snapshot();
  for (const malformed of [
    {},
    { user: source.user, branches: [] },
    { user: source.user, branches: null },
    { user: source.user, branches: [{ ...source.branch, id: "other-venue" }] },
    { user: source.user, branches: [{ ...source.branch, role: "CASHIER" }] },
    { user: source.user, branches: [source.branch, {}] },
    { user: { ...source.user, role: "OWNER" }, branches: [source.branch] },
  ])
    assert.throws(() => authReceipt(malformed), unconfirmed);
});

test("staff receipts accept an empty location and real account flags", () => {
  assert.deepEqual(staffReceipt({ branchId: "test-venue", accounts: [] }), {
    branchId: "test-venue",
    accounts: [],
  });
  const data = {
    branchId: "test-venue",
    accounts: [
      {
        id: "test-cashier",
        username: "test.cashier",
        role: "CASHIER",
        active: true,
        sharedAccount: false,
      },
    ],
  };
  assert.equal(staffReceipt(data), data);
});

test("staff account receipts require identity, known role and explicit boolean flags", () => {
  const account = {
    id: "test-cashier",
    username: "test.cashier",
    role: "CASHIER",
    active: true,
    sharedAccount: false,
  };
  for (const malformed of [
    {},
    { branchId: "", accounts: [] },
    { branchId: "test-venue", accounts: {} },
    ...[
      null,
      {},
      { ...account, id: "" },
      { ...account, username: "" },
      { ...account, role: "OWNER" },
      { ...account, active: "true" },
      { ...account, sharedAccount: undefined },
    ].map((value) => ({ branchId: "test-venue", accounts: [value] })),
  ])
    assert.throws(() => staffReceipt(malformed), unconfirmed);
});

test("acknowledgements require an explicit true result", () => {
  assert.equal(okReceipt({ ok: true }), undefined);
  for (const value of [null, [], {}, { ok: false }, { ok: "true" }, { ok: 1 }])
    assert.throws(() => okReceipt(value), unconfirmed);
});
