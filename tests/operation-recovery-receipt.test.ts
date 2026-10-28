import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyStore } from "../src/domain/selectors";
import {
  operationRecoveryReceipt,
  operationSnapshotReceipt,
} from "../src/lib/operation-recovery";
import { ManagementResponseError } from "../src/lib/management-response";

const expected = {
  operationId: "3e070695-5ec5-4d82-bc44-6c73b0e5f3cd",
  actorId: "fictional-admin",
  branchId: "fictional-venue",
};
const snapshot = {
  revision: 4,
  user: {
    id: expected.actorId,
    username: "fictional.admin",
    branchId: expected.branchId,
    role: "ADMIN",
  },
  branch: {
    id: expected.branchId,
    name: "Fictional venue",
    timezone: "Asia/Kuala_Lumpur",
    role: "ADMIN",
  },
  store: emptyStore(),
};
const receipt = { ...expected, status: "saved", snapshot };
function uncertain(error: unknown) {
  assert.ok(error instanceof ManagementResponseError);
  assert.equal(error.uncertain, true);
  return true;
}

test("recovery only accepts saved or cancelled receipts for the exact pending operation", () => {
  for (const status of ["saved", "cancelled"] as const) {
    const result = operationRecoveryReceipt({ ...receipt, status }, expected);
    assert.equal(result.status, status);
    assert.equal(result.snapshot, snapshot);
  }
  for (const invalid of [
    null,
    [],
    {},
    { ...receipt, status: "not-found" },
    { ...receipt, status: "pending" },
    { ...receipt, operationId: "other-id" },
    { ...receipt, branchId: "other-venue" },
    { ...receipt, actorId: "other-staff" },
    { ...receipt, snapshot: null },
  ])
    assert.throws(() => operationRecoveryReceipt(invalid, expected), uncertain);
});

test("a recovery receipt cannot clear a checkpoint with a snapshot from a different staff or venue", () => {
  const otherStaff = {
    ...snapshot,
    user: { ...snapshot.user, id: "other-staff" },
  };
  const otherVenue = {
    ...snapshot,
    user: { ...snapshot.user, branchId: "other-venue" },
    branch: { ...snapshot.branch, id: "other-venue" },
  };
  for (const next of [otherStaff, otherVenue]) {
    assert.throws(() => operationSnapshotReceipt(next, expected), uncertain);
    assert.throws(
      () => operationRecoveryReceipt({ ...receipt, snapshot: next }, expected),
      uncertain,
    );
  }
  assert.equal(operationSnapshotReceipt(snapshot, expected), snapshot);
});
