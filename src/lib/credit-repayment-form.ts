import { parseMoney } from "../domain/money";

/** Repayments are positive cash amounts bounded by the currently posted debt. */
export function creditRepaymentDraft(text: string, outstandingCredit: number) {
  let amount: number | null = null;
  try {
    amount = parseMoney(text);
  } catch {}
  const exceedsDebt = amount !== null && amount > outstandingCredit;
  const valid = amount !== null && outstandingCredit > 0 && !exceedsDebt;
  return {
    amount,
    exceedsDebt,
    valid,
    remainingDebt: valid ? outstandingCredit - amount! : null,
  };
}
