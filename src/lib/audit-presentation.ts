import type { AuditLog, Store } from "@/domain/model";
import { formatMoney } from "@/domain/money";
import { displayName } from "@/lib/display-name";
const labels: Record<string, string> = {
  username: "Username",
  active: "Account enabled",
  role: "Role",
  venueName: "Venue name",
  timezone: "Time zone",
  gameType: "Game",
  gameName: "Game name",
  smallBlind: "Small blind",
  bigBlind: "Big blind",
  minBuyIn: "Minimum buy-in",
  maxBuyIn: "Maximum buy-in",
  buyInStep: "Buy-in increment",
  rakePercent: "Rake percentage",
  rakeCap: "Rake cap",
  tipsEnabled: "Tips enabled",
  rakeEnabled: "Rake enabled",
  creditEnabled: "Credit enabled",
  insuranceEnabled: "Insurance enabled",
  jackpotEnabled: "Jackpot enabled",
  setupCompleted: "Setup complete",
  tipsPolicy: "Tips policy",
  houseRules: "House rules",
  name: "Name",
  phone: "Phone",
  type: "Player type",
  creditLimit: "Credit limit",
  tags: "Tags",
  dealer: "Dealer",
  status: "Status",
  tableId: "Table",
  seat: "Seat",
  countedCash: "Counted cash",
  expectedCash: "Expected cash",
  variance: "Variance",
  reason: "Reason",
  actor: "Staff",
  time: "Date",
};
function parse(value?: string): Record<string, unknown> {
  if (value === undefined) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      return parsed as Record<string, unknown>;
  } catch {}
  return { value };
}
export function auditChanges(log: AuditLog, store: Store) {
  const before = parse(log.before),
    after = parse(log.after);
  function display(key: string, value: unknown): string {
    if (value === undefined || value === null || value === "") return "—";
    if (typeof value === "boolean") return value ? "Yes" : "No";
    if (key === "gameType")
      return value === "TEXAS_HOLDEM"
        ? "Texas Hold’em"
        : value === "POT_LIMIT_OMAHA"
          ? "Pot-limit Omaha"
          : "Other game";
    if (key === "rakePercent" && typeof value === "number") return value + "%";
    if (
      [
        "creditLimit",
        "countedCash",
        "expectedCash",
        "variance",
        "smallBlind",
        "bigBlind",
        "minBuyIn",
        "maxBuyIn",
        "buyInStep",
        "rakeCap",
      ].includes(key) &&
      typeof value === "number"
    )
      return formatMoney(value);
    if (
      log.action === "Opened day" &&
      key === "value" &&
      Number.isFinite(Number(value))
    )
      return formatMoney(Number(value));
    if (Array.isArray(value)) return value.join(", ") || "—";
    if (
      ["name", "venueName", "gameName", "dealer"].includes(key) &&
      typeof value === "string"
    )
      return displayName(value);
    if (key === "tableId") return resolvedTableName(value, store);
    const seat = String(value).match(/^(.*), seat (\d+)$/);
    if (seat)
      return resolvedTableName(seat[1], store) + " · " + seat[2];
    return typeof value === "object" ? JSON.stringify(value) : String(value);
  }
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter(
      (key) =>
        key !== "id" &&
        JSON.stringify(before[key]) !== JSON.stringify(after[key]),
    )
    .map((key) => ({
      label:
        labels[key] ??
        (key === "value"
          ? log.action === "Opened day"
            ? "Opening cash"
            : "Value"
          : key),
      before: display(key, before[key]),
      after: display(key, after[key]),
    }));
}
export function auditReason(log: AuditLog, store: Store) {
  if (log.action === "Created location") return displayName(log.reason);
  if (log.action === "Requested approval") {
    const r = store.approvals.find((r) => r.id === log.entity);
    if (r) return r.type + " · " + formatMoney(r.amount);
  }
  if (log.action === "Checked in player") {
    const seat = log.reason.match(/^(.*), seat (\d+)$/);
    if (seat)
      return resolvedTableName(seat[1], store) + " · " + seat[2];
  }
  return log.reason;
}

function resolvedTableName(id: unknown, store: Store) {
  const table = store.tables.find((table) => table.id === id);
  return table ? displayName(table.name) : String(id);
}
