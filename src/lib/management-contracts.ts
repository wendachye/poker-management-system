import type { Branch, Snapshot, Staff } from "../domain/model";
import type { StaffAccount } from "../domain/staff";
import { ManagementResponseError } from "./management-response";

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
function role(value: unknown) {
  return ["ADMIN", "MANAGER", "CASHIER", "DEALER"].includes(value as string);
}
function staff(value: unknown): value is Staff {
  return (
    record(value) &&
    text(value.id) &&
    text(value.username) &&
    role(value.role) &&
    text(value.branchId)
  );
}
function branch(value: unknown): value is Branch {
  return (
    record(value) &&
    text(value.id) &&
    text(value.name) &&
    text(value.timezone) &&
    role(value.role)
  );
}
function invalidReceipt(): never {
  throw new ManagementResponseError(
    "The server response could not be confirmed. Refresh records and retry the last request.",
    200,
    null,
    true,
  );
}

/** Verify the receipt envelope before replacing state or clearing a save ID.
 * Domain/restore validation owns record invariants; avoid rescanning history here.
 */
export function snapshotReceipt(value: unknown): Snapshot {
  if (
    !record(value) ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    !branch(value.branch) ||
    !staff(value.user) ||
    value.branch.id !== value.user.branchId ||
    value.branch.role !== value.user.role ||
    !record(value.store)
  )
    invalidReceipt();
  const store = value.store as Record<string, unknown>;
  if (
    store.schemaVersion !== 1 ||
    !(store.currentDayId === null || text(store.currentDayId)) ||
    ![
      "profiles",
      "sessions",
      "tables",
      "transactions",
      "approvals",
      "auditLogs",
      "days",
    ].every((key) => Array.isArray(store[key]))
  )
    invalidReceipt();
  return value as unknown as Snapshot;
}

export function authReceipt(value: unknown): {
  user: Staff;
  branches: Branch[];
} {
  if (
    !record(value) ||
    !staff(value.user) ||
    !Array.isArray(value.branches) ||
    !value.branches.every(branch) ||
    !value.branches.some(
      (item) =>
        item.id === (value.user as Staff).branchId &&
        item.role === (value.user as Staff).role,
    )
  )
    invalidReceipt();
  return value as { user: Staff; branches: Branch[] };
}

export function staffReceipt(value: unknown): {
  branchId: string;
  accounts: StaffAccount[];
} {
  if (
    !record(value) ||
    !text(value.branchId) ||
    !Array.isArray(value.accounts) ||
    !value.accounts.every(
      (item) =>
        record(item) &&
        text(item.id) &&
        text(item.username) &&
        role(item.role) &&
        typeof item.active === "boolean" &&
        typeof item.sharedAccount === "boolean",
    )
  )
    invalidReceipt();
  return value as { branchId: string; accounts: StaffAccount[] };
}

export function okReceipt(value: unknown) {
  if (!record(value) || value.ok !== true) invalidReceipt();
}
