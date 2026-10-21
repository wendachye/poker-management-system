import test from "node:test";
import assert from "node:assert/strict";
import { applyCommand } from "../src/domain/operations";
import { configuredStore } from "./helpers/store";
import { ledgerImpact } from "../src/domain/ledger-impact";
import { filterRequests } from "../src/domain/request-filters";
import { auditChanges, auditReason } from "../src/lib/audit-presentation";
import { timestamp } from "../src/components/page/PokerManagementPage/utils";
import type { Command } from "../src/domain/commands";
import type { Staff, Store, AuditLog } from "../src/domain/model";

const admin: Staff = {
  id: "admin",
  username: "admin",
  role: "ADMIN",
  branchId: "local",
};
const cashier: Staff = {
  ...admin,
  id: "cashier",
  username: "cashier",
  role: "CASHIER",
};
function act(store: Store, command: Command, staff = admin) {
  return applyCommand(store, command, staff, "2026-10-02T16:30:00Z");
}
function fixture(credit = false) {
  let store = act(configuredStore(), {
    kind: "OPEN_DAY",
    date: "2026-10-02",
    openingCash: 100_000,
  });
  store = act(store, {
    kind: "TABLE",
    name: "Main table",
    dealer: "",
    status: "OPEN",
  });
  return act(store, {
    kind: "CHECK_IN",
    name: "Alice",
    phone: "+60123456789",
    type: credit ? "CREDIT" : "CASH",
    creditLimit: credit ? 100_000 : 0,
    tags: [],
    tableId: store.tables[0].id,
    seat: 1,
  });
}
function request(
  store: Store,
  type: "Buy-in" | "Cash-out" | "Credit Repayment",
  amount: number,
) {
  return act(
    store,
    {
      kind: "REQUEST",
      type,
      amount,
      playerId: store.profiles[0].id,
      note: "Counter request",
    },
    cashier,
  );
}
function approve(store: Store) {
  return act(store, {
    kind: "DECIDE",
    approvalId: store.approvals[0].id,
    decision: "APPROVED",
  });
}

for (const credit of [false, true])
  test(`${credit ? "credit" : "cash"} approval preview matches settlement and cash-out reversal`, () => {
    let store = request(fixture(credit), "Buy-in", 20_001);
    assert.deepEqual(ledgerImpact(store, store.approvals[0]), {
      amount: 20_001,
      cashReceived: credit ? 0 : 20_001,
      cashPayout: 0,
      creditDelta: credit ? 20_001 : 0,
    });
    store = approve(store);
    store = request(store, "Cash-out", 30_003);
    const preview = ledgerImpact(store, store.approvals[0]);
    assert.deepEqual(preview, {
      amount: 30_003,
      cashReceived: 0,
      cashPayout: credit ? 10_002 : 30_003,
      creditDelta: credit ? -20_001 : 0,
    });
    const approved = approve(store),
      tx = approved.transactions[0];
    assert.equal(tx.cashPayout, preview.cashPayout);
    assert.equal(tx.creditDelta, preview.creditDelta);
    assert.equal(approved.sessions[0].status, "OUT");
    store = act(
      approved,
      { kind: "CORRECT", transactionId: tx.id, reason: "Wrong payout entered" },
      cashier,
    );
    const reversal = ledgerImpact(store, store.approvals[0]);
    assert.equal(reversal.cashPayout, -preview.cashPayout);
    assert.equal(reversal.creditDelta + preview.creditDelta, 0);
    store = approve(store);
    assert.equal(store.sessions[0].status, "ACTIVE");
    assert.equal(store.transactions[0].cashPayout, reversal.cashPayout);
  });

test("request tabs preserve rejected reasons and link approved requests to receipts", () => {
  let store = request(fixture(), "Buy-in", 20_000);
  const rejected = store.approvals[0].id;
  store = act(store, {
    kind: "DECIDE",
    approvalId: rejected,
    decision: "REJECTED",
    reason: "Duplicate counter slip",
  });
  store = approve(request(store, "Buy-in", 10_000));
  const approved = store.approvals[0].id;
  store = request(store, "Buy-in", 5_000);
  assert.equal(filterRequests(store, { view: "PENDING" }).length, 1);
  assert.deepEqual(
    filterRequests(store, { view: "REJECTED", query: "duplicate" }).map(
      (r) => r.id,
    ),
    [rejected],
  );
  assert.equal(
    filterRequests(store, { view: "MINE", userId: cashier.id }).length,
    3,
  );
  assert.equal(
    filterRequests(store, { view: "MINE", userId: admin.id }).length,
    0,
  );
  assert.deepEqual(
    filterRequests(store, {
      view: "APPROVED",
      query: store.transactions[0].id,
    }).map((r) => r.id),
    [approved],
  );
  assert.equal(
    filterRequests(store, { view: "APPROVED", dayId: "another-day" }).length,
    0,
  );
  assert.equal(
    filterRequests(store, { view: "PENDING", type: "Cash-out" }).length,
    0,
  );
  assert.equal(
    filterRequests(store, { view: "PENDING", query: "ALICE" }).length,
    1,
  );
});

test("audit change summaries preserve sen, show only changes, and resolve table references", () => {
  const store = fixture(true);
  const log: AuditLog = {
    id: "log",
    actor: "manager",
    actorId: "manager",
    time: "2026-10-02T16:30:00Z",
    action: "Updated profile",
    entity: store.profiles[0].id,
    reason: "Updated credit limit",
    before: JSON.stringify({
      id: "p",
      name: "Alice",
      creditLimit: 100_001,
      tags: [],
    }),
    after: JSON.stringify({
      id: "p",
      name: "Alice",
      creditLimit: 200_002,
      tags: ["VIP"],
    }),
  };
  const changes = auditChanges(log, store);
  assert.deepEqual(
    changes.map((c) => c.label),
    ["Credit limit", "Tags"],
  );
  assert.match(changes[0].before, /1,000\.01/);
  assert.match(changes[0].after, /2,000\.02/);
  assert.equal(changes[1].after, "VIP");
  const moved = {
    ...log,
    action: "Moved player",
    before: `${store.tables[0].id}, seat 1`,
    after: `${store.tables[0].id}, seat 2`,
  };
  assert.deepEqual(auditChanges(moved, store), [
    { label: "Value", before: "Main table · 1", after: "Main table · 2" },
  ]);
  const requested = request(store, "Buy-in", 12_550);
  assert.match(
    auditReason(requested.auditLogs[0], requested),
    /^Buy-in · RM\s125\.50$/,
  );
});

test("timestamps follow the selected language and branch timezone across midnight", () => {
  const value = "2026-10-02T16:30:00Z";
  const chinese = timestamp(value, "Asia/Kuala_Lumpur", "zh");
  assert.match(chinese, /2026年10月3日/);
  assert.match(timestamp(value, "UTC", "zh"), /2026年10月2日/);
  assert.notEqual(timestamp(value, "Asia/Kuala_Lumpur", "en"), chinese);
});
