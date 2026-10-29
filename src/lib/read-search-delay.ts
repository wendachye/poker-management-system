import type { ReadQuery } from "../domain/read-model";

export type ReadSearchRequest = Readonly<{
  query: ReadQuery;
  branchId: string | undefined;
  revision: number | undefined;
  attempt: number;
  readGeneration: number;
  enabled: boolean;
  readIdentity: unknown;
  registerReadIdentity?: unknown;
}>;

function criteria(query: ReadQuery) {
  return Object.entries(query)
    .filter(
      ([key, value]) =>
        !["query", "page", "pageSize"].includes(key) &&
        value !== undefined &&
        value !== "",
    )
    .concat([["pageSize", query.pageSize ?? 20]])
    .sort(([left], [right]) => left.localeCompare(right));
}

/** Delay text edits only. Raw query keys still control which results are usable. */
export function readSearchDelay(
  previous: ReadSearchRequest | null | undefined,
  next: ReadSearchRequest,
): 0 | 200 {
  if (
    !previous ||
    !previous.enabled ||
    !next.enabled ||
    !next.branchId ||
    previous.branchId !== next.branchId ||
    previous.revision !== next.revision ||
    previous.attempt !== next.attempt ||
    previous.readGeneration !== next.readGeneration ||
    previous.readIdentity !== next.readIdentity ||
    previous.registerReadIdentity !== next.registerReadIdentity
  )
    return 0;

  const text = next.query.query ?? "";
  if (!text.trim() || text === (previous.query.query ?? "")) return 0;
  const page = next.query.page ?? 0;
  if (page !== (previous.query.page ?? 0) && page !== 0) return 0;

  const before = criteria(previous.query);
  const after = criteria(next.query);
  if (
    before.length !== after.length ||
    before.some(
      ([key, value], index) =>
        key !== after[index][0] || value !== after[index][1],
    )
  )
    return 0;
  return 200;
}
