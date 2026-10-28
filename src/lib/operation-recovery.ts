import type { Snapshot } from "../domain/model";
import { snapshotReceipt } from "./management-contracts";
import { ManagementResponseError } from "./management-response";
import type { PendingOperation } from "./pending-operation";

type OperationIdentity = Pick<PendingOperation, "actorId" | "branchId">;

function unconfirmed(): never {
  throw new ManagementResponseError(
    "The request result could not be confirmed. Check the previous request before continuing.",
    200,
    null,
    true,
  );
}

/** A valid snapshot for another account or venue cannot confirm this save. */
export function operationSnapshotReceipt(
  value: unknown,
  expected: OperationIdentity,
): Snapshot {
  const snapshot = snapshotReceipt(value);
  if (
    snapshot.user.id !== expected.actorId ||
    snapshot.branch.id !== expected.branchId
  )
    unconfirmed();
  return snapshot;
}

/** Do not release the browser checkpoint on an incomplete or unrelated receipt. */
export function operationRecoveryReceipt(
  value: unknown,
  expected: Pick<PendingOperation, "actorId" | "branchId" | "operationId">,
): {
  status: "saved" | "cancelled";
  snapshot: Snapshot;
} {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("status" in value) ||
    (value.status !== "saved" && value.status !== "cancelled") ||
    !("operationId" in value) ||
    value.operationId !== expected.operationId ||
    !("actorId" in value) ||
    value.actorId !== expected.actorId ||
    !("branchId" in value) ||
    value.branchId !== expected.branchId ||
    !("snapshot" in value)
  )
    unconfirmed();
  return {
    status: value.status,
    snapshot: operationSnapshotReceipt(value.snapshot, expected),
  };
}
