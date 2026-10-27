function normalizeText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Match staff-entered terms without changing the punctuation in references. */
export function matchesListSearch(
  query: string,
  values: readonly string[],
  phoneNumbers: readonly string[] = [],
): boolean {
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) return true;

  const fields = [...values, ...phoneNumbers].map(normalizeText);
  const digits = query.replace(/\D/g, "");
  if (/^[+\d\s().-]+$/.test(query) && digits.length >= 3) {
    // Only phone fields lose separators. Numeric references must still match
    // literally, rather than joining separate fragments into a different ID.
    return (
      phoneNumbers.some((phone) => phone.replace(/\D/g, "").includes(digits)) ||
      fields.some((field) => field.includes(normalizedQuery))
    );
  }

  return normalizedQuery
    .split(" ")
    .every((term) => fields.some((field) => field.includes(term)));
}
