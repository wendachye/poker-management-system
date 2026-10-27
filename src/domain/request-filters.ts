import type { ApprovalRequest, Store } from "./model";
import { displayName } from "../lib/display-name";
import { matchesListSearch } from "../lib/list-search";
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
  const players = new Map(store.profiles.map((p) => [p.id, p]));
  const tables = new Map(store.tables.map((t) => [t.id, t.name]));
  const receipts = new Map(
    store.transactions.map((tx) => [tx.approvalId, tx.id]),
  );
  return store.approvals.filter((r) => {
    const player = players.get(r.playerId ?? "");
    return (
      (filters.view === "MINE"
        ? r.requestedById === filters.userId
        : r.status === filters.view) &&
      (!filters.dayId || r.dayId === filters.dayId) &&
      (!filters.type || r.type === filters.type) &&
      matchesListSearch(
        filters.query ?? "",
        [
          r.id,
          r.type,
          r.staff,
          r.requestedBy,
          r.decidedBy ?? "",
          ...r.votes.map((vote) => vote.username),
          r.note,
          r.rejectionReason ?? "",
          displayName(player?.name ?? ""),
          displayName(tables.get(r.tableId ?? "") ?? ""),
          receipts.get(r.id) ?? "",
        ],
        player ? [player.phone] : [],
      )
    );
  });
}
