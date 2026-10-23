import type { Store } from "@/domain/model";
import { currentDay } from "@/domain/selectors";

export type SeatMoveDestination = { tableId: string; seat: number };

function activeSession(store: Store, playerId: string) {
  return store.sessions.find(
    (session) =>
      session.playerId === playerId &&
      session.dayId === store.currentDayId &&
      session.status === "ACTIVE",
  );
}

/** UI eligibility only. The validated MOVE command remains authoritative on save. */
export function playerMoveBlockedReason(store: Store, playerId: string) {
  const day = currentDay(store);
  if (!day) return "Open a business day before starting operations.";
  if (day.status !== "OPEN") return "The business day is closed.";
  const session = activeSession(store, playerId);
  if (!session) return "Player has no active session.";
  if (
    store.approvals.some(
      (request) =>
        request.status === "PENDING" &&
        (request.playerId === playerId || request.sessionId === session.id),
    )
  )
    return "Resolve pending request first";
  return null;
}

export function seatMoveBlockedReason(
  store: Store,
  playerId: string,
  destination: SeatMoveDestination,
) {
  const blocked = playerMoveBlockedReason(store, playerId);
  if (blocked) return blocked;
  const session = activeSession(store, playerId)!;
  if (
    !store.tables.some(
      (table) => table.id === destination.tableId && table.status === "OPEN",
    )
  )
    return "Select an open table.";
  if (
    !Number.isInteger(destination.seat) ||
    destination.seat < 1 ||
    destination.seat > 9
  )
    return "Select a seat from 1 to 9.";
  if (
    session.tableId === destination.tableId &&
    session.seat === destination.seat
  )
    return "Choose a different seat.";
  if (
    store.sessions.some(
      (occupant) =>
        occupant.status === "ACTIVE" &&
        occupant.tableId === destination.tableId &&
        occupant.seat === destination.seat &&
        occupant.id !== session.id,
    )
  )
    return "That seat is occupied.";
  return null;
}
