import type { Snapshot, Staff } from "../domain/model";

/** Keep operational records bound to the staff access shown by authentication. */
export function matchesOperationalAccess(
  authenticated: Staff | null,
  context: Pick<Snapshot, "user" | "branch">,
): boolean {
  return (
    authenticated !== null &&
    authenticated.id === context.user.id &&
    authenticated.role === context.user.role &&
    authenticated.role === context.branch.role &&
    authenticated.branchId === context.user.branchId &&
    authenticated.branchId === context.branch.id
  );
}
