import type { Staff } from "../domain/model";
import { ManagementResponseError } from "./management-response";

export type StaffSessionCheck =
  | { status: "authenticated"; user: Staff }
  | { status: "different-account" }
  | { status: "signed-out" }
  | { status: "unavailable"; message: string };

const fallback = "Cannot check staff access right now. Please try again.";

function checkedStaff(input: unknown): Staff | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return;
  const { id, username, branchId, role } = input as Staff;
  const text = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0 && value.length <= 100;
  if (
    !text(id) ||
    !text(username) ||
    !text(branchId) ||
    !["ADMIN", "MANAGER", "CASHIER", "DEALER"].includes(role)
  )
    return;
  return { id, username, branchId, role };
}

/** Recheck the current cookie through the supplied read capability only.
 * Unavailable or malformed responses cannot establish that a session expired.
 */
export async function checkStaffSession(
  refresh: () => Promise<Staff | null>,
  expectedUsername?: string,
): Promise<StaffSessionCheck> {
  try {
    const current = await refresh();
    if (current === null) return { status: "signed-out" };
    const user = checkedStaff(current);
    if (
      user &&
      expectedUsername !== undefined &&
      user.username.trim().toLowerCase() !==
        expectedUsername.trim().toLowerCase()
    )
      return { status: "different-account" };
    return user
      ? { status: "authenticated", user }
      : { status: "unavailable", message: fallback };
  } catch (error) {
    try {
      if (error instanceof ManagementResponseError) {
        const status = error.status;
        const uncertain = error.uncertain;
        if (status === 401 && uncertain === false)
          return { status: "signed-out" };
        const message = error.message;
        return {
          status: "unavailable",
          message:
            typeof message === "string" &&
            message.trim() &&
            message.length <= 1000
              ? message
              : fallback,
        };
      }
    } catch {}
    return { status: "unavailable", message: fallback };
  }
}
