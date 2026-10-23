import type { Snapshot } from "@/domain/model";
import { currentDay } from "@/domain/selectors";

export type CheckInContinuation = {
  branchId: string;
  dayId: string;
  playerId?: string;
  phone: string;
  tableId: string;
  seat: number;
};

/** Resolve the committed visit, never a profile from the form's old snapshot. */
export function checkedInVisit(
  snapshot: Snapshot | null,
  expected: CheckInContinuation,
) {
  if (
    !snapshot ||
    snapshot.branch.id !== expected.branchId ||
    currentDay(snapshot.store)?.id !== expected.dayId ||
    currentDay(snapshot.store)?.status !== "OPEN"
  )
    return null;
  const phone = expected.phone.replace(/[\s()-]/g, "");
  const profile = snapshot.store.profiles.find(
    (player) =>
      player.phone === phone &&
      (!expected.playerId || player.id === expected.playerId),
  );
  if (!profile) return null;
  const session = snapshot.store.sessions.find(
    (visit) =>
      visit.playerId === profile.id &&
      visit.dayId === expected.dayId &&
      visit.status === "ACTIVE" &&
      visit.tableId === expected.tableId &&
      visit.seat === expected.seat,
  );
  return session
    ? { playerId: profile.id, phone, tableId: session.tableId }
    : null;
}
