import type { Staff } from "../domain/model";
import { validListSort, type ListSortResource } from "../domain/list-sort";

export const LIST_VENUE_PARAM = "listVenue";
const MAX_STATE_CHARS = 16_384;
const MAX_PAGE = 1_000_000;
export type ListDraftValues = Record<string, string>;
export type ListAccess = Pick<Staff, "id" | "branchId" | "role">;

const routePrefixes: Record<string, readonly string[]> = {
  "/players": ["player", "history"],
  "/tables": ["table", "history"],
  "/transactions": ["tx", "history"],
  "/reports": ["report", "range", "history"],
  "/admin/audit": ["audit"],
  "/settings/staff": ["staff"],
};
export const listDraftRoutes = Object.keys(routePrefixes);
const fields: Record<string, readonly string[]> = {
  player: [
    "search",
    "status",
    "type",
    "tag",
    "page",
    "pageSize",
    "sort",
    "direction",
  ],
  tx: [
    "search",
    "status",
    "day",
    "filter",
    "page",
    "pageSize",
    "sort",
    "direction",
  ],
  audit: [
    "search",
    "staff",
    "action",
    "from",
    "to",
    "page",
    "pageSize",
    "sort",
    "direction",
  ],
  table: ["search", "filter", "page", "pageSize", "sort", "direction"],
  report: [
    "mode",
    "day",
    "selectedDate",
    "playerSearch",
    "playerStatus",
    "playerPage",
    "pageSize",
    "sort",
    "direction",
    "playerPageSize",
    "playerSort",
    "playerDirection",
    "closeSearch",
    "closePage",
    "closePageSize",
    "closeSort",
    "closeDirection",
  ],
  range: [
    "preset",
    "from",
    "to",
    "search",
    "status",
    "page",
    "pageSize",
    "sort",
    "direction",
  ],
  staff: [
    "search",
    "status",
    "filter",
    "role",
    "page",
    "pageSize",
    "sort",
    "direction",
  ],
  history: [
    "playerId",
    "search",
    "status",
    "page",
    "pageSize",
    "sort",
    "direction",
  ],
};
const enumValues: Record<string, readonly string[]> = {
  "player.status": ["", "ACTIVE", "OUT"],
  "player.type": ["", "CASH", "CREDIT"],
  "player.tag": ["", "VIP", "Risk", "Banned"],
  "tx.status": ["PENDING", "APPROVED", "REJECTED", "MINE"],
  "tx.filter": [
    "",
    "Buy-in",
    "Cash-out",
    "Rake",
    "Tips",
    "Insurance Premium",
    "Insurance Payout",
    "Jackpot Contribution",
    "Jackpot Payout",
    "Cash Received",
    "Cash Payout",
    "Credit Repayment",
    "Reversal",
  ],
  "table.filter": ["ALL", "OPEN", "CLOSED", "FULL", "AVAILABLE"],
  "report.mode": ["day", "range"],
  "report.playerStatus": ["", "ACTIVE", "OUT"],
  "range.preset": ["week", "month", "last-month", "custom"],
  "range.status": ["", "OPEN", "CLOSED"],
  "staff.status": ["all", "active", "disabled"],
  "staff.filter": ["all", "active", "disabled"],
  "staff.role": ["", "ADMIN", "MANAGER", "CASHIER", "DEALER"],
  "history.status": ["", "ACTIVE", "OUT"],
};

export function listDraftRoute(pathname: string) {
  const normalized =
    pathname.replace(/^\/(en|zh)(?=\/|$)/, "").replace(/\/$/, "") || "/";
  return Object.hasOwn(routePrefixes, normalized) ? normalized : null;
}

export function isListDraftKey(key: string) {
  const parts = key.split(".");
  const [prefix, field] = parts;
  return (
    parts.length === 2 &&
    !!prefix &&
    !!field &&
    Object.hasOwn(fields, prefix) &&
    fields[prefix].includes(field)
  );
}

function keyAllowedOnRoute(key: string, route?: string | null) {
  return (
    isListDraftKey(key) &&
    (route === undefined ||
      (!!route && !!routePrefixes[route]?.includes(key.split(".")[0])))
  );
}

function isPage(key: string) {
  return /\.(?:page|playerPage|closePage)$/.test(key);
}

function validDate(value: string) {
  if (!value) return true;
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !value.startsWith("0000") &&
    Number.isFinite(Date.parse(value + "T00:00:00Z")) &&
    new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value
  );
}

function valueForKey(key: string, value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    value.length > 200 ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    return;
  if (isPage(key)) {
    if (value === "") return "0";
    return /^\d+$/.test(value) && Number(value) <= MAX_PAGE
      ? String(Number(value))
      : undefined;
  }
  if (/\.(?:pageSize|playerPageSize|closePageSize)$/.test(key))
    return ["20", "50"].includes(value) ? value : undefined;
  if (/\.(?:direction|playerDirection|closeDirection)$/.test(key))
    return ["asc", "desc"].includes(value) ? value : undefined;
  if (enumValues[key] && !enumValues[key].includes(value)) return;
  if (
    [
      "audit.from",
      "audit.to",
      "range.from",
      "range.to",
      "report.selectedDate",
    ].includes(key) &&
    !validDate(value)
  )
    return;
  if (
    ["tx.day", "report.day", "history.playerId"].includes(key) &&
    value.length > 100
  )
    return;
  return value;
}

function sortResource(
  prefix: string,
  values: ListDraftValues,
): ListSortResource | undefined {
  return (
    {
      player: "players",
      tx: values["tx.status"] === "APPROVED" ? "transactions" : "requests",
      audit: "audit",
      report: "report",
      range: "range",
      staff: "staff",
      history: "sessions",
    } as Record<string, ListSortResource>
  )[prefix];
}

export function sanitizeListDrafts(
  input: unknown,
  route?: string | null,
): ListDraftValues {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const values: ListDraftValues = {};
  for (const [key, raw] of Object.entries(input)) {
    if (!keyAllowedOnRoute(key, route)) continue;
    const value = valueForKey(key, raw);
    if (value !== undefined) values[key] = value;
  }
  for (const [key, value] of Object.entries(values)) {
    if (!/\.(?:sort|playerSort|closeSort)$/.test(key) || value === "") continue;
    const prefix = key.split(".")[0];
    const valid =
      key === "report.closeSort"
        ? ["time", "actor", "countedCash", "variance"].includes(value)
        : prefix === "table"
          ? ["name", "status", "dealer"].includes(value)
          : !!sortResource(prefix, values) &&
            validListSort(sortResource(prefix, values)!, value);
    if (!valid) delete values[key];
  }
  return values;
}

export function listStateKey(
  access: ListAccess | null | undefined,
  pathname: string,
) {
  const route = listDraftRoute(pathname);
  if (!route || !access?.id || !access.branchId || !access.role) return null;
  return (
    "poker:list-state:v1:" +
    encodeURIComponent(
      JSON.stringify([access.id, access.branchId, access.role, route]),
    )
  );
}

export function listDraftOwner(access: ListAccess | null | undefined) {
  return access?.id && access.branchId && access.role
    ? JSON.stringify([access.id, access.branchId, access.role])
    : "";
}

export function routeForListDraft(key: string, currentRoute: string | null) {
  if (!isListDraftKey(key)) return null;
  const prefix = key.split(".")[0];
  if (prefix === "history") return currentRoute ?? "/players";
  return (
    Object.keys(routePrefixes).find((route) =>
      routePrefixes[route].includes(prefix),
    ) ?? null
  );
}

export function decodeListState(raw: string | null, pathname: string) {
  if (!raw || raw.length > MAX_STATE_CHARS) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !("version" in parsed) ||
      parsed.version !== 1 ||
      !("values" in parsed)
    )
      return {};
    return sanitizeListDrafts(parsed.values, listDraftRoute(pathname));
  } catch {
    return {};
  }
}

export function encodeListState(values: ListDraftValues, pathname: string) {
  return JSON.stringify({
    version: 1,
    values: sanitizeListDrafts(values, listDraftRoute(pathname)),
  });
}

export function readListLocation(
  search: string,
  pathname: string,
  branchId: string,
) {
  const route = listDraftRoute(pathname);
  const params = new URLSearchParams(search);
  const markers = params.getAll(LIST_VENUE_PARAM);
  const present =
    markers.length > 0 ||
    [...params.keys()].some((key) => keyAllowedOnRoute(key, route));
  if (
    !route ||
    search.length > MAX_STATE_CHARS ||
    markers.length > 1 ||
    (markers.length === 1 && markers[0] !== branchId)
  )
    return { present, foreignVenue: true, values: {} };
  const raw: ListDraftValues = {};
  for (const [key, value] of params) {
    if (!keyAllowedOnRoute(key, route) || params.getAll(key).length !== 1)
      continue;
    raw[key] = isPage(key)
      ? /^\d+$/.test(value) &&
        Number(value) >= 1 &&
        Number(value) <= MAX_PAGE + 1
        ? String(Number(value) - 1)
        : "invalid"
      : value;
  }
  return {
    present,
    foreignVenue: false,
    values: sanitizeListDrafts(raw, route),
  };
}

export function writeListLocation(
  href: string,
  pathname: string,
  branchId: string,
  values: ListDraftValues,
) {
  const url = new URL(href);
  for (const key of [...url.searchParams.keys()]) {
    if (key === LIST_VENUE_PARAM || Object.hasOwn(fields, key.split(".")[0]))
      url.searchParams.delete(key);
  }
  const route = listDraftRoute(pathname);
  if (route) {
    url.searchParams.set(LIST_VENUE_PARAM, branchId);
    for (const [key, value] of Object.entries(
      sanitizeListDrafts(values, route),
    ))
      url.searchParams.set(
        key,
        isPage(key) ? String(Number(value) + 1) : value,
      );
  }
  return url.href;
}
