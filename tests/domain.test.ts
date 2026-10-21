import test from "node:test";
import assert from "node:assert/strict";
import { applyCommand } from "../src/domain/operations";
import { debt, totalsForDay } from "../src/domain/selectors";
import { configuredStore } from "./helpers/store";
import { parseMoney, csv } from "../src/domain/money";
import type { Command } from "../src/domain/commands";
import type { Staff, Store } from "../src/domain/model";

const admin: Staff = {
  id: "admin",
  username: "admin",
  role: "ADMIN",
  branchId: "kl",
};
const manager: Staff = {
  ...admin,
  id: "manager",
  username: "manager",
  role: "MANAGER",
};
const cashier: Staff = {
  ...admin,
  id: "cashier",
  username: "cashier",
  role: "CASHIER",
};
const dealer: Staff = {
  ...admin,
  id: "dealer",
  username: "dealer",
  role: "DEALER",
};
let tick = 0;
function act(store: Store, command: Command, actor = admin) {
  return applyCommand(
    store,
    command,
    actor,
    new Date(Date.UTC(2026, 8, 30, 0, 0, tick++)).toISOString(),
  );
}
function fixture(credit = false) {
  let store = act(configuredStore(), {
    kind: "OPEN_DAY",
    date: "2026-09-30",
    openingCash: 1_000_000,
  });
  store = act(store, {
    kind: "TABLE",
    name: "Table 1",
    dealer: "Dealer",
    status: "OPEN",
  });
  store = act(store, {
    kind: "CHECK_IN",
    name: "Player",
    phone: "+60123456789",
    type: credit ? "CREDIT" : "CASH",
    creditLimit: credit ? 5_000_000 : 0,
    tags: [],
    tableId: store.tables[0].id,
    seat: 1,
  });
  return store;
}
function request(
  store: Store,
  type: "Buy-in" | "Cash-out" | "Rake" | "Credit Repayment",
  amount: number,
) {
  return act(
    store,
    {
      kind: "REQUEST",
      type,
      amount,
      playerId: store.profiles[0].id,
      tableId: store.tables[0].id,
      note: "Test transaction",
    },
    cashier,
  );
}
function approve(store: Store, actor = admin, id = store.approvals[0].id) {
  return act(
    store,
    { kind: "DECIDE", approvalId: id, decision: "APPROVED" },
    actor,
  );
}

test("money rejects fractional sen, scientific notation, negative and oversized amounts", () => {
  assert.equal(parseMoney("100.01"), 10001);
  assert.equal(parseMoney("0", true), 0);
  for (const amount of [
    "0",
    "0.001",
    "-1",
    "1e3",
    "Infinity",
    "9007199254740993",
    "",
  ])
    assert.throws(() => parseMoney(amount));
});
test("cash movements are counted once and variance compares counted cash", () => {
  let s = approve(request(fixture(), "Rake", 10000));
  assert.equal(totalsForDay(s).expectedCash, 1010000);
  assert.equal(totalsForDay(s).variance, null);
  s = approve(request(s, "Cash-out", 10000));
  assert.equal(totalsForDay(s).expectedCash, 1000000);
  s = act(s, { kind: "CLOSE_DAY", countedCash: 1000000, reason: "" });
  assert.equal(totalsForDay(s).variance, 0);
});
test("dual approval requires different reviewers including admin", () => {
  let s = request(fixture(), "Buy-in", 3000000);
  const id = s.approvals[0].id;
  s = approve(s, manager);
  assert.equal(s.transactions.length, 0);
  assert.equal(s.approvals[0].status, "PENDING");
  assert.throws(() => approve(s, manager, id), /Independent/);
  s = approve(s, admin, id);
  assert.equal(s.transactions.length, 1);
  assert.equal(s.approvals[0].status, "APPROVED");
  assert.throws(() => approve(s, admin, id));
});
test("two managers cannot complete a dual request without an admin", () => {
  let s = approve(request(fixture(), "Buy-in", 3000000), manager);
  s = approve(s, { ...manager, id: "manager2", username: "manager2" });
  assert.equal(s.transactions.length, 0);
  s = approve(s);
  assert.equal(s.transactions.length, 1);
});
test("requester cannot approve, cashiers cannot review, manager cannot approve payouts", () => {
  const own = act(
    fixture(),
    {
      kind: "REQUEST",
      type: "Cash Received",
      amount: 10000,
      note: "Manager request",
    },
    manager,
  );
  assert.throws(() => approve(own, manager), /Independent/);
  let s = request(fixture(), "Buy-in", 10000);
  assert.throws(() => approve(s, cashier), /Independent/);
  s = approve(s);
  s = request(s, "Cash-out", 1000);
  assert.throws(() => approve(s, manager), /Independent/);
});
test("dealer cannot perform cashier or manager actions", () => {
  const s = fixture();
  assert.throws(
    () =>
      act(s, { kind: "OPEN_DAY", date: "2026-10-01", openingCash: 0 }, dealer),
    /permission/,
  );
  assert.throws(
    () =>
      act(
        s,
        {
          kind: "REQUEST",
          type: "Buy-in",
          playerId: s.profiles[0].id,
          amount: 100,
          note: "",
        },
        dealer,
      ),
    /permission/,
  );
});
test("returning player reuses profile and bans cannot be replaced at check-in", () => {
  let s = approve(request(fixture(), "Cash-out", 0));
  const playerId = s.profiles[0].id;
  s = act(s, {
    kind: "UPDATE_PROFILE",
    playerId,
    name: "Player",
    tags: ["Banned"],
    creditLimit: 0,
    reason: "Restriction",
  });
  assert.throws(
    () =>
      act(s, {
        kind: "CHECK_IN",
        name: "New name",
        phone: "+60 123456789",
        type: "CASH",
        creditLimit: 0,
        tags: ["VIP"],
        tableId: s.tables[0].id,
        seat: 2,
      }),
    /banned/,
  );
  s = act(s, {
    kind: "UPDATE_PROFILE",
    playerId,
    name: "Player",
    tags: [],
    creditLimit: 0,
    reason: "Restriction removed",
  });
  s = act(s, {
    kind: "CHECK_IN",
    name: "New name",
    phone: "+60123456789",
    type: "CASH",
    creditLimit: 0,
    tags: [],
    tableId: s.tables[0].id,
    seat: 2,
  });
  assert.equal(s.profiles.length, 1);
  assert.equal(s.sessions.length, 2);
  assert.equal(s.profiles[0].id, playerId);
});
test("zero cash-out closes the visit without payment", () => {
  const s = approve(request(fixture(), "Cash-out", 0));
  assert.equal(s.sessions[0].status, "OUT");
  assert.equal(s.transactions[0].cashPayout, 0);
});
test("credit cash-out settles debt and pays only the remainder", () => {
  let s = approve(request(fixture(true), "Buy-in", 100000));
  assert.equal(debt(s, s.profiles[0].id), 100000);
  assert.equal(totalsForDay(s).cashReceived, 0);
  s = approve(request(s, "Cash-out", 150000));
  assert.equal(debt(s, s.profiles[0].id), 0);
  assert.equal(s.transactions[0].cashPayout, 50000);
  assert.equal(s.transactions[0].amount, 150000);
});
test("unpaid credit carries across closed days and can be repaid later", () => {
  let s = approve(request(fixture(true), "Buy-in", 100000));
  s = approve(request(s, "Cash-out", 0));
  s = act(s, { kind: "CLOSE_DAY", countedCash: 1000000, reason: "" });
  s = act(s, { kind: "OPEN_DAY", date: "2026-10-01", openingCash: 500000 });
  assert.equal(debt(s, s.profiles[0].id), 100000);
  assert.equal(totalsForDay(s).buyInTotal, 0);
  s = approve(request(s, "Credit Repayment", 100000));
  assert.equal(debt(s, s.profiles[0].id), 0);
  assert.throws(() => request(s, "Credit Repayment", 1), /exceed outstanding/);
});
test("pending credit is reserved and cannot exceed the limit", () => {
  const s = request(fixture(true), "Buy-in", 3000000);
  assert.throws(() => request(s, "Buy-in", 3000000), /Credit limit/);
});
test("corrections create an independent approval and append a reversal", () => {
  let s = approve(request(fixture(), "Rake", 10000));
  const original = structuredClone(s.transactions[0]);
  s = act(
    s,
    { kind: "CORRECT", transactionId: original.id, reason: "Wrong amount" },
    cashier,
  );
  assert.equal(s.approvals[0].type, "Reversal");
  assert.equal(s.transactions.length, 1);
  s = approve(s);
  assert.equal(s.transactions.length, 2);
  assert.deepEqual(s.transactions[1], original);
  assert.equal(totalsForDay(s).rake, 0);
  assert.equal(totalsForDay(s).expectedCash, 1000000);
  assert.throws(
    () =>
      act(
        s,
        { kind: "CORRECT", transactionId: original.id, reason: "Duplicate" },
        cashier,
      ),
    /already/,
  );
});
test("cash-out reversal reopens the same session only when seat is available", () => {
  let s = approve(request(fixture(), "Cash-out", 0));
  s = act(
    s,
    {
      kind: "CORRECT",
      transactionId: s.transactions[0].id,
      reason: "Mistaken checkout",
    },
    cashier,
  );
  s = approve(s);
  assert.equal(s.sessions[0].status, "ACTIVE");
  assert.equal(s.sessions[0].sessionEnd, undefined);
});

test("repayment reversal cannot exceed a reduced credit limit", () => {
  let s = approve(request(fixture(true), "Buy-in", 100000));
  s = approve(request(s, "Credit Repayment", 100000));
  const repayment = s.transactions[0];
  s = act(s, {
    kind: "UPDATE_PROFILE",
    playerId: s.profiles[0].id,
    name: "Player",
    tags: [],
    creditLimit: 50000,
    reason: "Reduced limit",
  });
  assert.throws(
    () =>
      act(
        s,
        {
          kind: "CORRECT",
          transactionId: repayment.id,
          reason: "Wrong repayment",
        },
        cashier,
      ),
    /exceed the credit limit/,
  );
});
test("closing requires no active sessions or unresolved approvals", () => {
  assert.throws(
    () => act(fixture(), { kind: "CLOSE_DAY", countedCash: 0, reason: "" }),
    /active players/,
  );
  let s = approve(request(fixture(), "Cash-out", 0));
  s = request(s, "Rake", 100);
  assert.throws(
    () => act(s, { kind: "CLOSE_DAY", countedCash: 1000000, reason: "" }),
    /pending approvals/,
  );
});
test("closing snapshots survive an admin reopening and dates are validated", () => {
  let s = approve(request(fixture(), "Cash-out", 0));
  assert.throws(
    () => act(s, { kind: "CLOSE_DAY", countedCash: 0, reason: "" }),
    /Explain/,
  );
  s = act(s, { kind: "CLOSE_DAY", countedCash: 1000000, reason: "" });
  const close = structuredClone(s.days[0].closes[0]);
  assert.throws(
    () => act(s, { kind: "REOPEN_DAY", reason: "Review" }, manager),
    /permission/,
  );
  assert.throws(
    () => act(s, { kind: "OPEN_DAY", date: "2026-99-99", openingCash: 0 }),
    /Invalid business date/,
  );
  s = act(s, { kind: "REOPEN_DAY", reason: "Review" });
  assert.deepEqual(s.days[0].closes[0], close);
});
test("seat occupancy and pending requests block unsafe moves and table closes", () => {
  let s = fixture();
  s = act(
    s,
    {
      kind: "MOVE",
      playerId: s.profiles[0].id,
      tableId: s.tables[0].id,
      seat: 2,
    },
    cashier,
  );
  assert.equal(s.sessions[0].seat, 2);
  assert.throws(
    () =>
      act(s, {
        kind: "TABLE",
        tableId: s.tables[0].id,
        name: "Table 1",
        dealer: "",
        status: "CLOSED",
      }),
    /all players/,
  );
  s = request(s, "Buy-in", 100);
  assert.throws(
    () =>
      act(
        s,
        {
          kind: "MOVE",
          playerId: s.profiles[0].id,
          tableId: s.tables[0].id,
          seat: 3,
        },
        cashier,
      ),
    /pending/,
  );
});
test("CSV keeps formulas as text and retains numeric negative amounts", () => {
  assert.equal(
    csv([["=1+1", "  @SUM(A1)", -1.25, 'A,"B"']]),
    '"\t=1+1","\t  @SUM(A1)","-1.25","A,""B"""',
  );
});
