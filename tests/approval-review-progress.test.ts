import test from "node:test";
import assert from "node:assert/strict";
import { applyCommand } from "../src/domain/operations";
import { approvalReviewProgress } from "../src/domain/approval-review-progress";
import type { ApprovalRequest, Staff } from "../src/domain/model";
import { configuredStore } from "./helpers/store";

const admin: Staff = {
  id: "admin",
  username: "admin",
  role: "ADMIN",
  branchId: "local",
};
const manager: Staff = {
  ...admin,
  id: "manager",
  username: "manager",
  role: "MANAGER",
};

function dualRequestAfterTwoManagers() {
  let store = applyCommand(
    configuredStore(),
    { kind: "OPEN_DAY", date: "2026-10-21", openingCash: 0 },
    admin,
  );
  store = applyCommand(
    store,
    {
      kind: "REQUEST",
      type: "Cash Received",
      amount: 2_500_000,
      note: "Dual review progress regression",
    },
    { ...admin, id: "cashier", username: "cashier", role: "CASHIER" },
  );
  for (const reviewer of [
    manager,
    { ...manager, id: "manager2", username: "manager2" },
  ])
    store = applyCommand(
      store,
      {
        kind: "DECIDE",
        approvalId: store.approvals[0].id,
        decision: "APPROVED",
      },
      reviewer,
    );
  return store;
}

test("two manager votes still show the missing admin instead of completed dual review", () => {
  const store = dualRequestAfterTwoManagers();
  const request = store.approvals[0];
  assert.equal(request.status, "PENDING");
  assert.equal(store.transactions.length, 0);
  const before = structuredClone(request);
  const progress = approvalReviewProgress(request);
  assert.equal(progress.count, 2);
  assert.equal(progress.minimum, 2);
  assert.equal(progress.requirement, "Admin review required");
  assert.equal(
    progress.label,
    "Reviewers: 2 · Minimum required: 2 · Admin review required",
  );
  assert.deepEqual(request, before);
});

test("an admin completing the pending dual review shows all three distinct reviewers", () => {
  let store = dualRequestAfterTwoManagers();
  store = applyCommand(
    store,
    {
      kind: "DECIDE",
      approvalId: store.approvals[0].id,
      decision: "APPROVED",
    },
    admin,
  );
  const request = store.approvals[0];
  assert.equal(request.status, "APPROVED");
  assert.equal(store.transactions.length, 1);
  const progress = approvalReviewProgress(request);
  assert.equal(progress.count, 3);
  assert.equal(progress.minimum, 2);
  assert.equal(progress.requirement, null);
  assert.equal(progress.label, "Reviewers: 3 · Minimum required: 2");
});

test("review progress counts distinct staff and still needs a second reviewer after an admin votes", () => {
  const vote: ApprovalRequest["votes"][number] = {
    staffId: admin.id,
    username: admin.username,
    role: "ADMIN",
    time: "2026-10-21T10:00:00Z",
  };
  const progress = approvalReviewProgress({
    approvalLevel: "DUAL",
    status: "PENDING",
    votes: [vote, { ...vote }],
  });
  assert.equal(progress.count, 1);
  assert.equal(progress.requirement, "Awaiting independent review");
});
