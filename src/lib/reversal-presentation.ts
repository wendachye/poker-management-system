import type { Role, Store, Transaction } from "../domain/model";

/** Keep the receipt and row action aligned; authoritative checks still run on save. */
export function reversalRequestState(
  store: Pick<Store, "currentDayId" | "approvals" | "transactions">,
  transaction: Transaction,
  role: Role | undefined,
  locked: boolean,
) {
  const posted = store.transactions.find(
    (entry) => entry.reversesId === transaction.id,
  );
  const pending = store.approvals.find(
    (request) =>
      request.reversesId === transaction.id && request.status === "PENDING",
  );
  return {
    eligible:
      !!role &&
      role !== "DEALER" &&
      transaction.type !== "Reversal" &&
      !transaction.reversesId &&
      transaction.dayId === store.currentDayId &&
      !posted,
    blocked: locked || !!pending,
    pending,
  };
}

export function validReversalReason(reason: string): boolean {
  const length = reason.trim().length;
  return length >= 3 && length <= 500;
}

/** Describe which recorded cash movement is undone, using positive magnitudes. */
export function reversalEffectRows(
  impact: Pick<Transaction, "cashReceived" | "cashPayout" | "creditDelta">,
) {
  const rows: { label: string; value: number; primary?: boolean }[] = [];
  if (impact.cashReceived !== 0)
    rows.push({
      label: "Cash received reversed",
      value: Math.abs(impact.cashReceived),
      primary: true,
    });
  if (impact.cashPayout !== 0)
    rows.push({
      label: "Cash payout reversed",
      value: Math.abs(impact.cashPayout),
      primary: true,
    });
  if (impact.creditDelta !== 0)
    rows.push({
      label:
        impact.creditDelta > 0 ? "Credit debt restored" : "Credit debt reduced",
      value: Math.abs(impact.creditDelta),
    });
  return rows;
}
