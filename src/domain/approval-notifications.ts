import type { ApprovalRequest, Staff, Store } from "./model";
import { canApprove } from "./operations";

export type ApprovalNotificationStatus =
  | "Ready for your review"
  | "Your request"
  | "Already reviewed"
  | "Admin review required"
  | "Awaiting authorized reviewer"
  | "Different business day"
  | "Day closed";

function reviewStatus(
  store: Store,
  request: ApprovalRequest,
  user?: Staff,
): ApprovalNotificationStatus {
  if (request.requestedById === user?.id) return "Your request";
  if (request.votes.some((vote) => vote.staffId === user?.id))
    return "Already reviewed";
  if (request.dayId !== store.currentDayId) return "Different business day";
  if (
    store.days.find((day) => day.id === store.currentDayId)?.status !== "OPEN"
  )
    return "Day closed";
  if (request.approvalLevel === "ADMIN" && user?.role !== "ADMIN")
    return "Admin review required";
  return user && canApprove(user, request)
    ? "Ready for your review"
    : "Awaiting authorized reviewer";
}

/** Pending records stay visible regardless of reviewer permissions or business date. */
export function approvalNotifications(store: Store, user?: Staff) {
  const players = new Map(
    store.profiles.map((player) => [player.id, player.name]),
  );
  const tables = new Map(store.tables.map((table) => [table.id, table.name]));
  const days = new Map(store.days.map((day) => [day.id, day.date]));
  const pending = store.approvals
    .filter((request) => request.status === "PENDING")
    .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));
  const entries = pending.map((request) => ({
    request,
    status: reviewStatus(store, request, user),
    subject: [
      players.get(request.playerId ?? ""),
      tables.get(request.tableId ?? ""),
    ]
      .filter(Boolean)
      .join(" · "),
    businessDate: days.get(request.dayId),
  }));
  return {
    total: store.readModel?.pendingTotal ?? entries.length,
    reviewable:
      store.readModel?.reviewable ??
      entries.filter((entry) => entry.status === "Ready for your review")
        .length,
    entries: entries.slice(0, 5),
  };
}
