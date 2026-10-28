import assert from "node:assert/strict";
import test from "node:test";
import { commandSchema } from "../src/domain/commands";
import { ledgerImpact } from "../src/domain/ledger-impact";
import type { ApprovalRequest, Role, Transaction } from "../src/domain/model";
import { emptyStore } from "../src/domain/selectors";
import {
  reversalEffectRows,
  reversalRequestState,
  validReversalReason,
} from "../src/lib/reversal-presentation";

function original(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: "tx-original",
    dayId: "day-current",
    type: "Rake",
    tableId: "table-main",
    amount: 5000,
    cashReceived: 5000,
    cashPayout: 0,
    creditDelta: 0,
    staff: "cashier",
    staffId: "cashier-id",
    time: "2026-10-28T01:00:00Z",
    note: "Original counter slip",
    approvalId: "apr-original",
    ...overrides,
  };
}
function fixture(transaction = original()) {
  return {
    ...emptyStore(),
    currentDayId: "day-current",
    transactions: [transaction],
  };
}
function request(status: ApprovalRequest["status"]): ApprovalRequest {
  return {
    id: "apr-reversal",
    dayId: "day-current",
    type: "Reversal",
    amount: 5000,
    staff: "cashier",
    note: "Duplicate slip",
    status,
    approvalLevel: "ADMIN",
    riskReason: "Admin review required",
    requestedBy: "cashier",
    requestedById: "cashier-id",
    createdAt: "2026-10-28T01:01:00Z",
    votes: [],
    reversesId: "tx-original",
  };
}

test("receipt and row reversal availability stays scoped to authorized current-day originals", () => {
  const store = fixture();
  for (const role of ["CASHIER", "MANAGER", "ADMIN"] satisfies Role[])
    assert.equal(
      reversalRequestState(store, store.transactions[0], role, false).eligible,
      true,
    );
  for (const role of ["DEALER", undefined] as const)
    assert.equal(
      reversalRequestState(store, store.transactions[0], role, false).eligible,
      false,
    );
  assert.equal(
    reversalRequestState(
      store,
      original({ dayId: "older-day" }),
      "ADMIN",
      false,
    ).eligible,
    false,
  );
  assert.equal(
    reversalRequestState(store, store.transactions[0], "ADMIN", true).blocked,
    true,
  );
});

test("pending or posted reversals prevent duplicate requests while a rejection permits retry", () => {
  const store = fixture();
  store.approvals = [request("PENDING")];
  const pending = reversalRequestState(
    store,
    store.transactions[0],
    "CASHIER",
    false,
  );
  assert.equal(pending.blocked, true);
  assert.equal(pending.pending?.id, "apr-reversal");
  store.approvals = [request("REJECTED")];
  assert.equal(
    reversalRequestState(store, store.transactions[0], "CASHIER", false)
      .blocked,
    false,
  );
  const reversed = original({
    id: "tx-reversal",
    type: "Reversal",
    reversesId: "tx-original",
  });
  store.transactions.push(reversed);
  assert.equal(
    reversalRequestState(store, store.transactions[0], "CASHIER", false)
      .eligible,
    false,
  );
  assert.equal(
    reversalRequestState(store, reversed, "ADMIN", false).eligible,
    false,
  );
});

test("reversal reason button validity follows the authoritative trimmed command schema", () => {
  for (const reason of [
    "",
    " ",
    "  ab  ",
    "  Duplicate slip  ",
    "x".repeat(500),
    "x".repeat(501),
  ])
    assert.equal(
      validReversalReason(reason),
      commandSchema.safeParse({
        kind: "CORRECT",
        transactionId: "tx-original",
        reason,
      }).success,
      reason,
    );
});

test("credit cash-out reversal presents cash undone and restored debt as positive magnitudes", () => {
  const transaction = original({
    type: "Cash-out",
    amount: 70000,
    cashReceived: 0,
    cashPayout: 5000,
    creditDelta: -65000,
  });
  const store = fixture(transaction);
  const impact = ledgerImpact(store, {
    type: "Reversal",
    amount: 70000,
    reversesId: transaction.id,
  });
  assert.deepEqual(reversalEffectRows(impact), [
    { label: "Cash payout reversed", value: 5000, primary: true },
    { label: "Credit debt restored", value: 65000 },
  ]);
});

test("repayment and credit-buy-in reversal labels retain opposite credit directions", () => {
  const repayment = original({
    type: "Credit Repayment",
    amount: 20000,
    cashReceived: 20000,
    creditDelta: -20000,
  });
  const repaymentStore = fixture(repayment);
  assert.deepEqual(
    reversalEffectRows(
      ledgerImpact(repaymentStore, {
        type: "Reversal",
        amount: repayment.amount,
        reversesId: repayment.id,
      }),
    ),
    [
      { label: "Cash received reversed", value: 20000, primary: true },
      { label: "Credit debt restored", value: 20000 },
    ],
  );
  const creditBuyIn = original({
    type: "Buy-in",
    cashReceived: 0,
    creditDelta: 5000,
  });
  const buyInStore = fixture(creditBuyIn);
  assert.deepEqual(
    reversalEffectRows(
      ledgerImpact(buyInStore, {
        type: "Reversal",
        amount: creditBuyIn.amount,
        reversesId: creditBuyIn.id,
      }),
    ),
    [{ label: "Credit debt reduced", value: 5000 }],
  );
});
