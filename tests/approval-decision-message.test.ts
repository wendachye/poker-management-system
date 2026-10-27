import test from "node:test";
import assert from "node:assert/strict";
import { approvalDecisionMessage } from "../src/lib/approval-decision-message";
import { applyCommand } from "../src/domain/operations";
import type { Staff, Store } from "../src/domain/model";
import { configuredStore } from "./helpers/store";

const admin: Staff = {
  id: "admin",
  username: "admin",
  role: "ADMIN",
  branchId: "local",
};
const cashier: Staff = {
  ...admin,
  id: "cashier",
  username: "cashier",
  role: "CASHIER",
};
const manager: Staff = {
  ...admin,
  id: "manager",
  username: "manager",
  role: "MANAGER",
};

function requestedCash(amount: number) {
  const opened = applyCommand(
    configuredStore(),
    { kind: "OPEN_DAY", date: "2026-10-28", openingCash: 0 },
    admin,
  );
  const store = applyCommand(
    opened,
    {
      kind: "REQUEST",
      type: "Cash Received",
      amount,
      note: "Sample cash approval feedback",
    },
    cashier,
  );
  return { store, requestId: store.approvals[0].id };
}

function approve(store: Store, requestId: string, actor: Staff) {
  return applyCommand(
    store,
    { kind: "DECIDE", approvalId: requestId, decision: "APPROVED" },
    actor,
  );
}

test("feedback confirms posting only after an approved request has a ledger entry", () => {
  const { store: requested, requestId } = requestedCash(50_000);
  const store = approve(requested, requestId, manager);
  assert.equal(store.approvals[0].status, "APPROVED");
  assert.equal(store.transactions.length, 1);
  assert.equal(store.transactions[0].cashReceived, 50_000);
  const before = structuredClone(store);
  assert.equal(
    approvalDecisionMessage(store, requestId),
    "Approved and posted.",
  );
  assert.deepEqual(store, before);
});

test("rejected feedback follows the committed rejection without posting cash", () => {
  const { store: requested, requestId } = requestedCash(50_000);
  const store = applyCommand(
    requested,
    {
      kind: "DECIDE",
      approvalId: requestId,
      decision: "REJECTED",
      reason: "Duplicate sample request",
    },
    manager,
  );
  assert.equal(store.approvals[0].status, "REJECTED");
  assert.equal(store.transactions.length, 0);
  assert.equal(approvalDecisionMessage(store, requestId), "Request rejected.");
});

test("dual review feedback stays pending until the second independent reviewer completes it", () => {
  const { store: requested, requestId } = requestedCash(2_500_000);
  const partial = approve(requested, requestId, admin);
  assert.equal(partial.approvals[0].approvalLevel, "DUAL");
  assert.equal(partial.approvals[0].status, "PENDING");
  assert.equal(partial.transactions.length, 0);
  assert.equal(
    approvalDecisionMessage(partial, requestId),
    "Approval recorded. Another reviewer is required.",
  );
  const posted = approve(partial, requestId, manager);
  assert.equal(posted.approvals[0].status, "APPROVED");
  assert.equal(posted.transactions.length, 1);
  assert.equal(
    approvalDecisionMessage(posted, requestId),
    "Approved and posted.",
  );
});

test("two manager approvals still report the required admin review instead of a posted entry", () => {
  const { store: requested, requestId } = requestedCash(2_500_000);
  const first = approve(requested, requestId, manager);
  const partial = approve(first, requestId, {
    ...manager,
    id: "manager2",
    username: "manager2",
  });
  assert.equal(partial.approvals[0].votes.length, 2);
  assert.equal(partial.approvals[0].status, "PENDING");
  assert.equal(partial.transactions.length, 0);
  assert.equal(
    approvalDecisionMessage(partial, requestId),
    "Approval recorded. Another reviewer is required.",
  );
  const posted = approve(partial, requestId, admin);
  assert.equal(posted.transactions.length, 1);
  assert.equal(
    approvalDecisionMessage(posted, requestId),
    "Approved and posted.",
  );
});

test("missing or incomplete committed records never claim a posted approval", () => {
  const { store: requested, requestId } = requestedCash(50_000);
  assert.equal(
    approvalDecisionMessage(requested, "missing-request"),
    "Saved successfully.",
  );
  const posted = approve(requested, requestId, manager);
  assert.equal(
    approvalDecisionMessage({ ...posted, transactions: [] }, requestId),
    "Saved successfully.",
  );
});
