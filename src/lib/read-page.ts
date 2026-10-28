import type { ReadPage, ReadQuery } from "../domain/read-model";
import { snapshotReceipt } from "./management-contracts";
import { ManagementResponseError } from "./management-response";

/** Empty controls mean an omitted filter, not an invalid empty record ID. */
export function readQueryParams(query: ReadQuery) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query))
    if (value !== undefined && value !== "") params.set(key, String(value));
  return params;
}
function integer(value: unknown) {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
export function readPageReceipt<T>(value: unknown): ReadPage<T> {
  const invalid = () =>
    new ManagementResponseError(
      "The server response could not be confirmed. Refresh records and retry the last request.",
      200,
      null,
      true,
    );
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw invalid();
  const page = value as ReadPage<T>;
  const context = snapshotReceipt(page.context);
  if (
    page.branchId !== context.branch.id ||
    page.revision !== context.revision ||
    !Array.isArray(page.items) ||
    !integer(page.total) ||
    !integer(page.page) ||
    !integer(page.pageSize) ||
    page.pageSize < 1 ||
    page.pageSize > 50 ||
    page.items.length > page.pageSize ||
    !page.counts ||
    typeof page.counts !== "object" ||
    Array.isArray(page.counts) ||
    Object.values(page.counts).some((count) => !integer(count))
  )
    throw invalid();
  return page;
}
