import { parseMoney } from "../domain/money";

/** An empty or invalid draft is not an intentional zero-chip cash-out. */
export function parseCashOutDraftAmount(text: string): number | null {
  try {
    return parseMoney(text, true);
  } catch {
    return null;
  }
}
