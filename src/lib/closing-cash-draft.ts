import { parseMoney } from "../domain/money";

/** A count is entered by staff; an empty or invalid draft is never a zero count. */
export function closingCashDraft(
  count: string,
  expectedCash: number,
  explanation: string,
) {
  let countedCash: number | null = null;
  try {
    countedCash = parseMoney(count, true);
  } catch {}
  const variance = countedCash === null ? null : countedCash - expectedCash;
  const requiresExplanation = variance !== null && variance !== 0;
  const explanationLength = explanation.trim().length;
  return {
    countedCash,
    variance,
    requiresExplanation,
    valid:
      countedCash !== null &&
      (!requiresExplanation || explanationLength >= 3) &&
      explanationLength <= 500,
  };
}
