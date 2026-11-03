import type { Branch, Snapshot, Staff } from "../domain/model";
import type { StaffListResult } from "../domain/staff";
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

/** A credential response must establish a complete, bounded staff identity. */
export function loginReceipt(value: unknown): { user: Staff } {
  if (!record(value) || !staff(value.user)) invalidReceipt();
  const user = value.user as Staff;
  if (
    [user.id, user.username, user.branchId].some(
      (part) => !part.trim() || part.length > 100,
    )
  )
    invalidReceipt();
  return {
    user: {
      id: user.id,
      username: user.username,
      branchId: user.branchId,
      role: user.role,
    },
  };
}

export function staffReceipt(value: unknown): StaffListResult {
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
  if (["total", "page", "pageSize", "counts"].some((key) => key in value)) {
    if (
      !["total", "page", "pageSize"].every(
        (key) =>
          Number.isSafeInteger(value[key]) &&
          (value[key] as number) >= (key === "pageSize" ? 1 : 0),
      ) ||
      (value.pageSize as number) > 50 ||
      value.accounts.length > (value.pageSize as number) ||
      !record(value.counts) ||
      !["ALL", "ACTIVE", "DISABLED"].every(
        (key) =>
          Number.isSafeInteger(
            (value.counts as Record<string, unknown>)[key],
          ) && ((value.counts as Record<string, unknown>)[key] as number) >= 0,
      )
    )
      invalidReceipt();
  }
  return value as unknown as StaffListResult;
}

export function okReceipt(value: unknown) {
  if (!record(value) || value.ok !== true) invalidReceipt();
}
