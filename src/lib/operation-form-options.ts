import { matchesListSearch } from "./list-search";

export type SearchChoiceOption = {
  value: string;
  label: string;
  disabled?: boolean;
  searchTerms?: readonly string[];
  /** Explicit phone fields only; numeric references must retain punctuation. */
  phoneNumbers?: readonly string[];
};

export function matchesSearchChoice(
  option: SearchChoiceOption,
  query: string,
): boolean {
  return matchesListSearch(
    query,
    [option.value, option.label, ...(option.searchTerms ?? [])],
    option.phoneNumbers ?? [],
  );
}

export function validBuyInDraftAmount(
  amount: number,
  minimum: number,
  maximum: number,
  step: number,
): boolean {
  return (
    Number.isSafeInteger(amount) &&
    amount > 0 &&
    amount >= minimum &&
    amount <= maximum &&
    (step <= 0 || amount % step === 0)
  );
}

/** Common amounts are draft shortcuts, bounded by table rules and credit room. */
export function buyInQuickAmounts(
  minimum: number,
  maximum: number,
  step: number,
): number[] {
  return [50_000, 100_000].filter(
    (amount) =>
      amount !== minimum &&
      amount !== maximum &&
      validBuyInDraftAmount(amount, minimum, maximum, step),
  );
}
