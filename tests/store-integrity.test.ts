import test from "node:test";
import assert from "node:assert/strict";
import { buildSampleStore } from "../scripts/sample-data";
import { applyCommand } from "../src/domain/operations";
import { configuredStore } from "./helpers/store";
import type { Command } from "../src/domain/commands";
import type {
  ApprovalRequest,
  EntryType,
  Staff,
  Store,
  Transaction,
} from "../src/domain/model";
import { MAX_MONEY } from "../src/domain/money";
import {
  assertFinancialIntegrity,
  FinancialIntegrityError,
  type FinancialIntegrityCode,
} from "../src/domain/store-integrity";

const actors = {
  admin: {
    id: "admin",
    username: "fixture.admin",
    role: "ADMIN",
    branchId: "fixture",
  },
  manager: {
    id: "manager",
    username: "fixture.manager",
    role: "MANAGER",
    branchId: "fixture",
  },
  cashier: {
    id: "cashier",
    username: "fixture.cashier",
    role: "CASHIER",
    branchId: "fixture",
  },
  dealer: {
    id: "dealer",
    username: "fixture.dealer",
    role: "DEALER",
    branchId: "fixture",
  },
} satisfies Record<string, Staff>;
const baseline = buildSampleStore(actors, new Date("2026-10-02T15:00:00Z"));
function cashEntry(store: Store) {
  return store.transactions.find(
    (tx) =>
      tx.type === "Buy-in" &&
      store.profiles.find((profile) => profile.id === tx.playerId)?.type ===
        "CASH" &&
      !store.transactions.some((other) => other.reversesId === tx.id),
  )!;
}
function rejected(code: FinancialIntegrityCode, run: () => unknown) {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof FinancialIntegrityError);
    assert.equal(error.code, code);
    assert.equal(error.message, `Financial integrity check failed (${code}).`);
    return true;
  });
}
function flow() {
  let store = configuredStore(),
    tick = 0;
  function run(command: Command, actor: Staff = actors.admin) {
    store = applyCommand(
      store,
      command,
      actor,
      new Date(Date.UTC(2026, 9, 1, 1, tick++)).toISOString(),
    );
    assertFinancialIntegrity(store);
    return store;
  }
  function request(type: EntryType, amount: number, playerId?: string) {
    run(
      {
        kind: "REQUEST",
        type,
        amount,
        playerId,
        note: "Fictional integrity check",
      },
      actors.cashier,
    );
    return store.approvals[0].id;
  }
  function approve(approvalId: string, actor: Staff = actors.admin) {
    return run({ kind: "DECIDE", approvalId, decision: "APPROVED" }, actor);
  }
  run({ kind: "TABLE", name: "First", dealer: "", status: "OPEN" });
  run({ kind: "TABLE", name: "Second", dealer: "", status: "OPEN" });
  run({ kind: "OPEN_DAY", date: "2026-10-01", openingCash: 100_000 });
  return {
    run,
    request,
    approve,
    get store() {
      return store;
    },
  };
}

function cashVisit() {
  const fixture = flow();
  fixture.run({
    kind: "CHECK_IN",
    name: "Cash lifecycle fixture",
    phone: "+12025550003",
    type: "CASH",
    creditLimit: 0,
    tags: [],
    tableId: fixture.store.tables[0].id,
    seat: 1,
  });
  const playerId = fixture.store.profiles[0].id;
  fixture.approve(fixture.request("Buy-in", 50_000, playerId));
  const buyIn = fixture.store.transactions[0];
  return { fixture, playerId, buyIn };
}
function swapPostings(store: Store, firstId: string, secondId: string) {
  const first = store.transactions.findIndex((tx) => tx.id === firstId);
  const second = store.transactions.findIndex((tx) => tx.id === secondId);
  [store.transactions[first], store.transactions[second]] = [
    store.transactions[second],
    store.transactions[first],
  ];
}

test("complete domain-generated sample history validates without trusting read projections", () => {
  assert.doesNotThrow(() => assertFinancialIntegrity(baseline));
  const scoped = {
    ...baseline,
    readModel: {} as NonNullable<Store["readModel"]>,
  };
  rejected("INCOMPLETE_STORE", () => assertFinancialIntegrity(scoped));
});

test("moves, reduced limits, stale repayments and earlier closing snapshots remain valid", () => {
  const fixture = flow();
  fixture.run({
    kind: "CHECK_IN",
    name: "Credit fixture",
    phone: "+12025550001",
    type: "CREDIT",
    creditLimit: 100_000,
    tags: [],
    tableId: fixture.store.tables[0].id,
    seat: 1,
  });
  const playerId = fixture.store.profiles[0].id;
  fixture.approve(fixture.request("Buy-in", 50_000, playerId));
  fixture.run({
    kind: "MOVE",
    playerId,
    tableId: fixture.store.tables[1].id,
    seat: 2,
  });
  const first = fixture.request("Credit Repayment", 40_000, playerId);
  const stale = fixture.request("Credit Repayment", 40_000, playerId);
  fixture.approve(first); // The other request is now larger than current debt.
  fixture.run({
    kind: "UPDATE_PROFILE",
    playerId,
    name: "Credit fixture",
    tags: [],
    creditLimit: 10_000,
    reason: "Reduce unused credit",
  });
  fixture.run({
    kind: "DECIDE",
    approvalId: stale,
    decision: "REJECTED",
    reason: "Repayment already received",
  });
  fixture.approve(fixture.request("Cash-out", 20_000, playerId));
  const cashOut = fixture.store.transactions[0];
  fixture.run({ kind: "CLOSE_DAY", countedCash: 130_000, reason: "" });
  fixture.run({ kind: "REOPEN_DAY", reason: "Correct the fictional payout" });
  fixture.run(
    {
      kind: "CORRECT",
      transactionId: cashOut.id,
      reason: "Correct the fictional payout",
    },
    actors.cashier,
  );
  fixture.approve(fixture.store.approvals[0].id);
  fixture.approve(fixture.request("Cash-out", 10_000, playerId));
  fixture.run({ kind: "CLOSE_DAY", countedCash: 140_000, reason: "" });
  assert.equal(fixture.store.days[0].closes.length, 2);
  assert.equal(fixture.store.days[0].closes[0].expectedCash, 130_000);
  assert.equal(fixture.store.days[0].closes[1].expectedCash, 140_000);
});

test("dual approval accepts partial managers and requires an independent admin before posting", () => {
  const fixture = flow();
  fixture.run({
    kind: "CHECK_IN",
    name: "Cash fixture",
    phone: "+12025550002",
    type: "CASH",
    creditLimit: 0,
    tags: [],
    tableId: fixture.store.tables[0].id,
    seat: 1,
  });
  const id = fixture.request("Buy-in", 2_500_000, fixture.store.profiles[0].id);
  fixture.approve(id, actors.manager);
  fixture.approve(id, {
    ...actors.manager,
    id: "manager-two",
    username: "fixture.manager.two",
  });
  assert.equal(fixture.store.approvals[0].status, "PENDING");
  fixture.approve(id);
  assert.equal(fixture.store.approvals[0].votes.length, 3);
  assert.equal(fixture.store.approvals[0].status, "APPROVED");
});

test("recorded quorum permits an admin-first dual review but stops at the completing vote", () => {
  const { fixture, playerId } = cashVisit();
  const id = fixture.request("Buy-in", 2_500_000, playerId);
  fixture.approve(id, actors.admin);
  assert.equal(fixture.store.approvals[0].status, "PENDING");
  fixture.approve(id, actors.manager);
  assert.equal(fixture.store.approvals[0].status, "APPROVED");
  assert.equal(fixture.store.approvals[0].decidedBy, actors.manager.username);
  assert.doesNotThrow(() => assertFinancialIntegrity(fixture.store));
});

test("approval replay rejects unauthorized admin-level votes and every review after quorum", () => {
  const { fixture, playerId } = cashVisit();
  const adminId = fixture.request("Cash-out", 70_000, playerId);
  const unauthorizedPending = structuredClone(fixture.store);
  const pending = unauthorizedPending.approvals.find(
    (request) => request.id === adminId,
  )!;
  pending.votes.push({
    staffId: actors.manager.id,
    username: actors.manager.username,
    role: "MANAGER",
    time: pending.createdAt,
  });
  rejected("APPROVAL_REVIEW", () =>
    assertFinancialIntegrity(unauthorizedPending),
  );
  const unauthorizedRejected = structuredClone(unauthorizedPending);
  const rejectedRequest = unauthorizedRejected.approvals.find(
    (request) => request.id === adminId,
  )!;
  rejectedRequest.status = "REJECTED";
  rejectedRequest.decidedBy = actors.manager.username;
  rejectedRequest.decidedAt = rejectedRequest.createdAt;
  rejectedRequest.rejectionReason = "Fictional unauthorized review";
  rejected("APPROVAL_REVIEW", () =>
    assertFinancialIntegrity(unauthorizedRejected),
  );

  fixture.approve(adminId);
  const appendReview = (store: Store, requestId: string) => {
    const request = store.approvals.find(
      (request) => request.id === requestId,
    )!;
    request.votes.push({
      staffId: "extra-manager",
      username: "fixture.extra.manager",
      role: "MANAGER",
      time: request.decidedAt!,
    });
    request.decidedBy = "fixture.extra.manager";
  };
  const unauthorizedFinalizer = structuredClone(fixture.store);
  appendReview(unauthorizedFinalizer, adminId);
  rejected("APPROVAL_REVIEW", () =>
    assertFinancialIntegrity(unauthorizedFinalizer),
  );

  const managerSuffix = structuredClone(fixture.store);
  const managerId = managerSuffix.approvals.find(
    (request) => request.type === "Buy-in",
  )!.id;
  appendReview(managerSuffix, managerId);
  rejected("APPROVAL_REVIEW", () => assertFinancialIntegrity(managerSuffix));

  const dual = cashVisit();
  const dualId = dual.fixture.request("Buy-in", 2_500_000, dual.playerId);
  dual.fixture.approve(dualId, actors.manager);
  dual.fixture.approve(dualId, {
    ...actors.manager,
    id: "manager-two",
    username: "fixture.manager.two",
  });
  dual.fixture.approve(dualId);
  const dualSuffix = structuredClone(dual.fixture.store);
  appendReview(dualSuffix, dualId);
  rejected("APPROVAL_REVIEW", () => assertFinancialIntegrity(dualSuffix));

  const completedEarlier = structuredClone(dual.fixture.store);
  const request = completedEarlier.approvals.find(
    (request) => request.id === dualId,
  )!;
  const [first, second, admin] = request.votes;
  request.votes = [admin, first, { ...second, time: request.decidedAt! }];
  request.decidedBy = second.username;
  rejected("APPROVAL_REVIEW", () => assertFinancialIntegrity(completedEarlier));
});

test("a cash-out reversal reopens its visit before new buy-ins and a later cash-out", () => {
  const { fixture, playerId } = cashVisit();
  fixture.approve(fixture.request("Cash-out", 70_000, playerId));
  const cashOut = fixture.store.transactions[0];
  fixture.run(
    {
      kind: "CORRECT",
      transactionId: cashOut.id,
      reason: "Reopen the fictional visit",
    },
    actors.cashier,
  );
  // A pending cash-out reversal is valid while its original visit is OUT.
  assert.equal(fixture.store.sessions[0].status, "OUT");
  fixture.approve(fixture.store.approvals[0].id);
  fixture.approve(fixture.request("Buy-in", 20_000, playerId));
  fixture.approve(fixture.request("Cash-out", 30_000, playerId));
  assert.equal(fixture.store.sessions[0].status, "OUT");
  assert.doesNotThrow(() => assertFinancialIntegrity(fixture.store));
});

test("posting replay rejects activity while a visit is settled even when final cash-out counts agree", () => {
  const { fixture, playerId, buyIn } = cashVisit();
  fixture.approve(fixture.request("Cash-out", 70_000, playerId));
  const firstCashOut = fixture.store.transactions[0];
  const lateBuyIn = structuredClone(fixture.store);
  swapPostings(lateBuyIn, buyIn.id, firstCashOut.id);
  rejected("SESSION_LIFECYCLE", () => assertFinancialIntegrity(lateBuyIn));

  fixture.run(
    {
      kind: "CORRECT",
      transactionId: firstCashOut.id,
      reason: "Reopen the fictional visit",
    },
    actors.cashier,
  );
  fixture.approve(fixture.store.approvals[0].id);
  const cashOutReversal = fixture.store.transactions[0];
  fixture.approve(fixture.request("Cash-out", 30_000, playerId));
  const secondCashOut = fixture.store.transactions[0];
  const duplicateCashOut = structuredClone(fixture.store);
  swapPostings(duplicateCashOut, cashOutReversal.id, secondCashOut.id);
  rejected("SESSION_LIFECYCLE", () =>
    assertFinancialIntegrity(duplicateCashOut),
  );

  const other = cashVisit();
  other.fixture.approve(
    other.fixture.request("Cash-out", 40_000, other.playerId),
  );
  const settled = other.fixture.store.transactions[0];
  other.fixture.run(
    {
      kind: "CORRECT",
      transactionId: settled.id,
      reason: "Reopen before reversing buy-in",
    },
    actors.cashier,
  );
  other.fixture.approve(other.fixture.store.approvals[0].id);
  const reopened = other.fixture.store.transactions[0];
  other.fixture.run(
    {
      kind: "CORRECT",
      transactionId: other.buyIn.id,
      reason: "Reverse the fictional buy-in",
    },
    actors.cashier,
  );
  other.fixture.approve(other.fixture.store.approvals[0].id);
  const buyInReversal = other.fixture.store.transactions[0];
  const lateReopening = structuredClone(other.fixture.store);
  swapPostings(lateReopening, reopened.id, buyInReversal.id);
  rejected("SESSION_LIFECYCLE", () => assertFinancialIntegrity(lateReopening));
});

test("pending ordinary session requests need the current active visit and table", () => {
  const { fixture, playerId, buyIn } = cashVisit();
  const request = fixture.store.approvals[0];
  const wrongTable = structuredClone(fixture.store);
  wrongTable.approvals.unshift({
    ...request,
    id: "pending-wrong-table",
    status: "PENDING",
    votes: [],
    decidedAt: undefined,
    decidedBy: undefined,
    tableId: wrongTable.tables[1].id,
  });
  rejected("SESSION_LIFECYCLE", () => assertFinancialIntegrity(wrongTable));
  fixture.approve(fixture.request("Cash-out", 70_000, playerId));
  for (const type of ["Buy-in", "Cash-out"] as const) {
    const inactive = structuredClone(fixture.store);
    inactive.approvals.unshift({
      ...request,
      id: `pending-out-${type}`,
      type,
      status: "PENDING",
      votes: [],
      decidedAt: undefined,
      decidedBy: undefined,
    });
    rejected("SESSION_LIFECYCLE", () => assertFinancialIntegrity(inactive));
  }
  const invalidReversal = structuredClone(fixture.store);
  invalidReversal.approvals.unshift({
    ...request,
    id: "pending-out-buy-in-reversal",
    type: "Reversal",
    reversesId: buyIn.id,
    approvalLevel: "ADMIN",
    status: "PENDING",
    votes: [],
    decidedAt: undefined,
    decidedBy: undefined,
  });
  rejected("SESSION_LIFECYCLE", () =>
    assertFinancialIntegrity(invalidReversal),
  );
});

test("corrupt approval, posting, reversal, lifecycle and closing relationships fail with bounded diagnostics", () => {
  const cases: [FinancialIntegrityCode, (store: Store) => void][] = [
    [
      "APPROVAL_POSTING",
      (s) => {
        s.approvals.find((r) => r.id === cashEntry(s).approvalId)!.status =
          "PENDING";
      },
    ],
    [
      "APPROVAL_POSTING",
      (s) => {
        const id = cashEntry(s).id;
        s.transactions = s.transactions.filter((tx) => tx.id !== id);
      },
    ],
    [
      "LEDGER_IMPACT",
      (s) => {
        cashEntry(s).cashReceived++;
      },
    ],
    [
      "LEDGER_IMPACT",
      (s) => {
        cashEntry(s).amount++;
      },
    ],
    [
      "LEDGER_LINK",
      (s) => {
        cashEntry(s).sessionId = s.sessions.find(
          (visit) => visit.playerId !== cashEntry(s).playerId,
        )!.id;
      },
    ],
    [
      "APPROVAL_REVIEW",
      (s) => {
        const r = s.approvals.find((r) => r.id === cashEntry(s).approvalId)!;
        r.votes[0].staffId = r.requestedById;
      },
    ],
    [
      "APPROVAL_REVIEW",
      (s) => {
        const r = s.approvals.find((r) => r.id === cashEntry(s).approvalId)!;
        r.votes.push({ ...r.votes[0] });
      },
    ],
    [
      "APPROVAL_REVIEW",
      (s) => {
        s.approvals.find(
          (r) => r.id === cashEntry(s).approvalId,
        )!.votes[0].role = "CASHIER";
      },
    ],
    [
      "LEDGER_IMPACT",
      (s) => {
        s.transactions.find((tx) => tx.type === "Reversal")!.cashReceived++;
      },
    ],
    [
      "REVERSAL_LINK",
      (s) => {
        const tx = s.transactions.find((tx) => tx.type === "Reversal")!;
        tx.reversesId = tx.id;
        s.approvals.find((r) => r.id === tx.approvalId)!.reversesId = tx.id;
      },
    ],
    [
      "APPROVAL_POSTING",
      (s) => {
        s.transactions.unshift({ ...cashEntry(s), id: "duplicate-posting" });
      },
    ],
    [
      "DAY_LIFECYCLE",
      (s) => {
        s.days[0].status = "OPEN";
      },
    ],
    [
      "DAY_LIFECYCLE",
      (s) => {
        s.currentDayId = s.days[0].id;
      },
    ],
    [
      "SESSION_LIFECYCLE",
      (s) => {
        s.sessions.find((visit) => visit.status === "OUT")!.sessionEnd =
          undefined;
      },
    ],
    [
      "CLOSING_TOTAL",
      (s) => {
        s.days[0].closes[0].variance++;
      },
    ],
    [
      "CLOSING_TOTAL",
      (s) => {
        const close = s.days[0].closes.at(-1)!;
        close.expectedCash++;
        close.variance--;
      },
    ],
    [
      "CREDIT_RESERVATION",
      (s) => {
        s.profiles.find(
          (profile) =>
            profile.type === "CREDIT" &&
            s.transactions
              .filter((tx) => tx.playerId === profile.id)
              .reduce((sum, tx) => sum + tx.creditDelta, 0) > 0,
        )!.creditLimit = 0;
      },
    ],
  ];
  for (const [code, corrupt] of cases) {
    const store = structuredClone(baseline);
    corrupt(store);
    rejected(code, () => assertFinancialIntegrity(store));
  }
});

test("exact replay rejects an otherwise well-formed repayment that makes debt negative", () => {
  const store = structuredClone(baseline);
  const player = store.profiles.find((profile) => profile.type === "CREDIT")!;
  const debt = store.transactions
    .filter((tx) => tx.playerId === player.id)
    .reduce((sum, tx) => sum + tx.creditDelta, 0);
  const amount = debt + 1,
    time = "2026-10-02T15:00:00Z";
  const request: ApprovalRequest = {
    id: "over-repayment",
    dayId: store.currentDayId!,
    type: "Credit Repayment",
    amount,
    playerId: player.id,
    staff: actors.cashier.username,
    note: "Fictional corruption",
    status: "APPROVED",
    approvalLevel: "MANAGER",
    riskReason: "Independent review",
    requestedBy: actors.cashier.username,
    requestedById: actors.cashier.id,
    createdAt: time,
    decidedAt: time,
    decidedBy: actors.admin.username,
    votes: [
      {
        staffId: actors.admin.id,
        username: actors.admin.username,
        role: "ADMIN",
        time,
      },
    ],
  };
  store.approvals.unshift(request);
  store.transactions.unshift({
    id: "over-repayment-ledger",
    dayId: request.dayId,
    type: request.type,
    playerId: player.id,
    amount,
    staff: request.staff,
    staffId: request.requestedById,
    cashReceived: amount,
    cashPayout: 0,
    creditDelta: -amount,
    time,
    note: request.note,
    approvalId: request.id,
  });
  rejected("DEBT_BALANCE", () => assertFinancialIntegrity(store));
});

test("large exact aggregate overflow is rejected in one complete-history pass", () => {
  const store = configuredStore(),
    time = "2026-10-01T01:00:00Z";
  store.days = [
    {
      id: "day",
      date: "2026-10-01",
      openedAt: time,
      openingCash: 0,
      status: "OPEN",
      closes: [],
    },
  ];
  store.currentDayId = "day";
  const count = Math.floor(Number.MAX_SAFE_INTEGER / MAX_MONEY) + 1;
  for (let index = 0; index < count; index++) {
    const request: ApprovalRequest = {
      id: `request-${index}`,
      dayId: "day",
      type: "Cash Received",
      amount: MAX_MONEY,
      staff: actors.cashier.username,
      note: "Fictional aggregate",
      status: "APPROVED",
      approvalLevel: "MANAGER",
      riskReason: "Independent review",
      requestedBy: actors.cashier.username,
      requestedById: actors.cashier.id,
      createdAt: time,
      decidedAt: time,
      decidedBy: actors.admin.username,
      votes: [
        {
          staffId: actors.admin.id,
          username: actors.admin.username,
          role: "ADMIN",
          time,
        },
      ],
    };
    const tx: Transaction = {
      id: `tx-${index}`,
      dayId: "day",
      type: "Cash Received",
      amount: MAX_MONEY,
      staff: request.staff,
      staffId: request.requestedById,
      cashReceived: MAX_MONEY,
      cashPayout: 0,
      creditDelta: 0,
      time,
      note: request.note,
      approvalId: request.id,
    };
    store.approvals.push(request);
    store.transactions.push(tx);
  }
  rejected("UNSAFE_TOTAL", () => assertFinancialIntegrity(store));
});
