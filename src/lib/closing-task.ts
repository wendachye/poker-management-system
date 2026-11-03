import type { Snapshot, Staff } from "../domain/model";
import { matchesOperationalAccess } from "./operational-access";

export type ClosingTaskScope = {
  key: string;
  actor: Pick<Staff, "id" | "role" | "branchId">;
  dayId: string;
  date: string;
};

/** A closing task is temporary UI intent for one authenticated open business day. */
export function closingTaskScope(
  snapshot: Snapshot | null,
  authenticated: Pick<Staff, "id" | "role" | "branchId"> | null,
): ClosingTaskScope | null {
  if (
    !snapshot ||
    !authenticated ||
    !["MANAGER", "ADMIN"].includes(authenticated.role) ||
    !matchesOperationalAccess({ ...authenticated, username: "" }, snapshot)
  )
    return null;
  const day = snapshot.store.days.find(
    (entry) => entry.id === snapshot.store.currentDayId,
  );
  if (!day || day.status !== "OPEN") return null;
  const actor = {
    id: authenticated.id,
    role: authenticated.role,
    branchId: authenticated.branchId,
  };
  return {
    key: JSON.stringify([
      actor.id,
      actor.role,
      actor.branchId,
      day.id,
      day.date,
    ]),
    actor,
    dayId: day.id,
    date: day.date,
  };
}

export function matchesClosingTaskScope(
  expected: ClosingTaskScope,
  snapshot: Snapshot,
) {
  return closingTaskScope(snapshot, expected.actor)?.key === expected.key;
}
