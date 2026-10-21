import type { ApprovalRequest, Store, Transaction } from "./model";
import { debt } from "./selectors";

/** The same calculation powers approval previews and the posted ledger entry. */
export function ledgerImpact(
  store: Store,
  request: Pick<ApprovalRequest, "type" | "amount" | "playerId" | "reversesId">,
): Pick<Transaction, "amount" | "cashReceived" | "cashPayout" | "creditDelta"> {
  const impact = {
    amount: request.amount,
    cashReceived: 0,
    cashPayout: 0,
    creditDelta: 0,
  };
  const profile = store.profiles.find((p) => p.id === request.playerId);
  if (request.type === "Reversal") {
    const original = store.transactions.find(
      (tx) => tx.id === request.reversesId,
    );
    if (!original) throw new Error("Original transaction not found.");
    return {
      amount: original.amount === 0 ? 0 : -original.amount,
      cashReceived: original.cashReceived === 0 ? 0 : -original.cashReceived,
      cashPayout: original.cashPayout === 0 ? 0 : -original.cashPayout,
      creditDelta: original.creditDelta === 0 ? 0 : -original.creditDelta,
    };
  }
  if (request.type === "Buy-in" && profile?.type === "CREDIT")
    impact.creditDelta = request.amount;
  else if (request.type === "Cash-out") {
    const settled =
      profile?.type === "CREDIT"
        ? Math.min(debt(store, profile.id), request.amount)
        : 0;
    impact.creditDelta = settled === 0 ? 0 : -settled;
    impact.cashPayout = request.amount - settled;
  } else if (request.type === "Credit Repayment") {
    impact.creditDelta = -request.amount;
    impact.cashReceived = request.amount;
  } else if (
    ["Insurance Payout", "Jackpot Payout", "Cash Payout"].includes(request.type)
  )
    impact.cashPayout = request.amount;
  else impact.cashReceived = request.amount;
  return impact;
}
