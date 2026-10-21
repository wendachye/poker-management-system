import type { ApprovalRequest, Store } from "./model";
export type RequestView = "PENDING" | "APPROVED" | "REJECTED" | "MINE";
export function filterRequests(
  store: Store,
  filters: {
    view: RequestView;
    userId?: string;
    dayId?: string;
    type?: string;
    query?: string;
  },
): ApprovalRequest[] {
  const query = (filters.query ?? "").trim().toLowerCase();
  const players = new Map(store.profiles.map((p) => [p.id, p.name]));
  const tables = new Map(store.tables.map((t) => [t.id, t.name]));
  const receipts = new Map(
    store.transactions.map((tx) => [tx.approvalId, tx.id]),
  );
  return store.approvals.filter(
    (r) =>
      (filters.view === "MINE"
        ? r.requestedById === filters.userId
        : r.status === filters.view) &&
      (!filters.dayId || r.dayId === filters.dayId) &&
      (!filters.type || r.type === filters.type) &&
      [
        r.id,
        r.requestedBy,
        r.note,
        r.rejectionReason ?? "",
        players.get(r.playerId ?? "") ?? "",
        tables.get(r.tableId ?? "") ?? "",
        receipts.get(r.id) ?? "",
      ].some((text) => text.toLowerCase().includes(query)),
  );
}
