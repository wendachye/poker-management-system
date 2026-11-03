import type { ReadQuery, ReadResource } from "./read-model";
import { displayName } from "../lib/display-name";

export type ListSortResource = ReadResource | "staff";
export type ListSortOption = { value: string; label: string };
const options: Partial<Record<ListSortResource, readonly ListSortOption[]>> = {
  players: [
    { value: "name", label: "Player name" },
    { value: "type", label: "Player type" },
    { value: "status", label: "Status" },
    { value: "creditUsed", label: "Outstanding credit" },
    { value: "sessionStart", label: "Check-in time" },
  ],
  report: [
    { value: "name", label: "Player name" },
    { value: "type", label: "Player type" },
    { value: "status", label: "Status" },
    { value: "buyIn", label: "Buy-in" },
    { value: "cashOut", label: "Cash-out" },
    { value: "creditUsed", label: "Outstanding credit" },
  ],
  requests: [
    { value: "createdAt", label: "Date" },
    { value: "amount", label: "Entry amount" },
    { value: "type", label: "Transaction type" },
    { value: "requestedBy", label: "Requested by" },
  ],
  transactions: [
    { value: "time", label: "Date" },
    { value: "amount", label: "Entry amount" },
    { value: "type", label: "Transaction type" },
    { value: "staff", label: "Staff" },
  ],
  audit: [
    { value: "time", label: "Date" },
    { value: "actor", label: "Staff" },
    { value: "action", label: "Action" },
    { value: "entity", label: "Entity" },
  ],
  sessions: [
    { value: "sessionStart", label: "Check-in time" },
    { value: "status", label: "Status" },
  ],
  range: [
    { value: "date", label: "Business day" },
    { value: "cashReceived", label: "Cash Received" },
    { value: "cashPayout", label: "Cash Payout" },
    { value: "expectedCash", label: "Expected cash" },
  ],
  staff: [
    { value: "username", label: "Username" },
    { value: "role", label: "Role" },
    { value: "active", label: "Status" },
  ],
};

export function listSortOptions(resource: ListSortResource): ListSortOption[] {
  return [{ value: "", label: "Default order" }, ...(options[resource] ?? [])];
}

export function validListSort(resource: ListSortResource, sort: string) {
  return (options[resource] ?? []).some((option) => option.value === sort);
}

/** Empty UI controls omit both fields, retaining the established default order. */
export function readSortQuery(
  sort?: string,
  direction?: string,
): Pick<ReadQuery, "sort" | "direction"> {
  return sort?.trim()
    ? { sort: sort.trim(), direction: direction === "desc" ? "desc" : "asc" }
    : {};
}

function compareText(first: string, second: string) {
  // Code-point order matches PostgreSQL's explicit C collation, including emoji.
  const a = Array.from(first),
    b = Array.from(second);
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    const difference = a[index].codePointAt(0)! - b[index].codePointAt(0)!;
    if (difference) return difference;
  }
  return a.length - b.length;
}

/** Prototype/client-only lists sort the complete filtered set before slicing.
 * Null values stay last in both directions; equal values always use ascending ID.
 */
export function sortLocalRecords<T>(
  resource: ListSortResource,
  rows: readonly T[],
  sort?: string,
  direction?: string,
): T[] {
  if (!sort || !validListSort(resource, sort)) return [...rows];
  const value = (row: T): string | number | boolean | null => {
    const record = row as Record<string, unknown>;
    const raw =
      resource === "range" && sort !== "date"
        ? (record.totals as Record<string, unknown> | undefined)?.[sort]
        : record[sort];
    if (raw === undefined || raw === null || raw === "") return null;
    if (["time", "createdAt", "sessionStart"].includes(sort))
      return Date.parse(String(raw));
    if (typeof raw === "number" || typeof raw === "boolean") return raw;
    return (
      sort === "name" ? displayName(String(raw)) : String(raw)
    ).toLowerCase();
  };
  return [...rows].sort((first, second) => {
    const a = value(first),
      b = value(second);
    const result =
      a === null
        ? b === null
          ? 0
          : 1
        : b === null
          ? -1
          : typeof a === "string" && typeof b === "string"
            ? compareText(a, b) * (direction === "desc" ? -1 : 1)
            : (Number(a) - Number(b)) * (direction === "desc" ? -1 : 1);
    return (
      result ||
      compareText(
        String((first as Record<string, unknown>).id ?? ""),
        String((second as Record<string, unknown>).id ?? ""),
      )
    );
  });
}
