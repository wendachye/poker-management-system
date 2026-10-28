import type { Store } from "@/domain/model";
import type { SeatSwapParticipant } from "@/domain/commands";
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
  if (store.readModel?.pendingPlayers[playerId])
    return "Resolve pending request first";
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

/** Capture the exact visit and seat that staff are being asked to exchange. */
export function seatSwapParticipant(
  store: Store,
  playerId: string,
): SeatSwapParticipant | null {
  const session = activeSession(store, playerId);
  return session
    ? {
        playerId,
        sessionId: session.id,
        tableId: session.tableId,
        seat: session.seat,
      }
    : null;
}

export function seatSwapBlockedReason(
  store: Store,
  first: SeatSwapParticipant,
  second: SeatSwapParticipant,
) {
  if (
    first.playerId === second.playerId ||
    first.sessionId === second.sessionId
  )
    return "Choose two different players.";
  for (const participant of [first, second]) {
    const blocked = playerMoveBlockedReason(store, participant.playerId);
    if (blocked) return blocked;
    const current = activeSession(store, participant.playerId)!;
    if (
      current.id !== participant.sessionId ||
      current.tableId !== participant.tableId ||
      current.seat !== participant.seat ||
      !Number.isInteger(participant.seat) ||
      participant.seat < 1 ||
      participant.seat > 9 ||
      !store.profiles.some((profile) => profile.id === participant.playerId) ||
      store.sessions.some(
        (session) =>
          session.playerId === participant.playerId &&
          session.status === "ACTIVE" &&
          session.id !== participant.sessionId,
      ) ||
      store.sessions.some(
        (session) =>
          session.status === "ACTIVE" &&
          session.tableId === participant.tableId &&
          session.seat === participant.seat &&
          session.id !== participant.sessionId,
      )
    )
      return "The seating changed. Close this dialog and try the swap again.";
    if (
      !store.tables.some(
        (table) => table.id === participant.tableId && table.status === "OPEN",
      )
    )
      return "Both tables must be open to swap players.";
  }
  return null;
}
