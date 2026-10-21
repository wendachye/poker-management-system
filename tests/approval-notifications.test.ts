import test from "node:test";
import assert from "node:assert/strict";
import type { ApprovalRequest, Staff } from "../src/domain/model";
import { approvalNotifications } from "../src/domain/approval-notifications";
import { emptyStore } from "../src/domain/selectors";

const manager: Staff = {
  id: "manager",
  username: "manager",
  role: "MANAGER",
  branchId: "local",
};
function request(
  id: string,
  overrides: Partial<ApprovalRequest> = {},
): ApprovalRequest {
  return {
    id,
    dayId: "today",
    type: "Buy-in",
    amount: 20_000,
    staff: "cashier",
    note: "Approval notification fixture",
    status: "PENDING",
    approvalLevel: "MANAGER",
    riskReason: "Independent review required.",
    requestedBy: "cashier",
    requestedById: "cashier",
    createdAt: "2026-10-21T10:00:00Z",
    votes: [],
    ...overrides,
  };
}
function fixture(approvals: ApprovalRequest[]) {
  const store = emptyStore();
  store.currentDayId = "today";
  store.days = [
    {
      id: "older",
      date: "2026-10-20",
      openedAt: "2026-10-20T00:00:00Z",
      openingCash: 0,
      status: "CLOSED",
      closes: [],
    },
    {
      id: "today",
      date: "2026-10-21",
      openedAt: "2026-10-21T00:00:00Z",
      openingCash: 0,
      status: "OPEN",
      closes: [],
    },
  ];
  store.approvals = approvals;
  return store;
}

test("the badge counts all pending requests while the list shows the five newest, including older business days", () => {
  const store = fixture([
    ...Array.from({ length: 7 }, (_, index) =>
      request(`request-${index}`, {
        createdAt: `2026-10-21T10:0${index}:00Z`,
        dayId: index === 6 ? "older" : "today",
      }),
    ),
    request("approved", { status: "APPROVED" }),
    request("rejected", { status: "REJECTED" }),
  ]);
  const before = structuredClone(store);
  const summary = approvalNotifications(store, manager);
  assert.equal(summary.total, 7);
  assert.equal(summary.reviewable, 6);
  assert.deepEqual(
    summary.entries.map(({ request }) => request.id),
    ["request-6", "request-5", "request-4", "request-3", "request-2"],
  );
  assert.equal(summary.entries[0].status, "Different business day");
  assert.equal(summary.entries[0].businessDate, "2026-10-20");
  assert.deepEqual(store, before);
});

test("notification labels preserve independent review, past votes and admin-only policy", () => {
  const store = fixture([
    request("own", { requestedById: manager.id }),
    request("voted", {
      approvalLevel: "DUAL",
      votes: [
        {
          staffId: manager.id,
          username: manager.username,
          role: manager.role,
          time: "2026-10-21T10:01:00Z",
        },
      ],
    }),
    request("cashout", { type: "Cash-out", approvalLevel: "ADMIN" }),
    request("ready"),
    request("dual", { approvalLevel: "DUAL" }),
  ]);
  assert.deepEqual(
    approvalNotifications(store, manager).entries.map(({ status }) => status),
    [
      "Your request",
      "Already reviewed",
      "Admin review required",
      "Ready for your review",
      "Ready for your review",
    ],
  );
  assert.equal(approvalNotifications(store, manager).reviewable, 2);
  const cashier = { ...manager, id: "cashier2", role: "CASHIER" as const };
  assert.equal(approvalNotifications(store, cashier).reviewable, 0);
  assert.equal(
    approvalNotifications(store, cashier).entries[3].status,
    "Awaiting authorized reviewer",
  );
  assert.equal(
    approvalNotifications(store, { ...manager, id: "admin", role: "ADMIN" })
      .reviewable,
    5,
  );
});

test("closed-day requests stay visible without being described as reviewable, and subjects resolve real records", () => {
  const store = fixture([
    request("linked", { playerId: "player", tableId: "table" }),
  ]);
  store.days[1].status = "CLOSED";
  store.profiles = [
    {
      id: "player",
      name: "Alex",
      phone: "+12025550101",
      type: "CASH",
      creditLimit: 0,
      tags: [],
    },
  ];
  store.tables = [
    { id: "table", name: "Main floor", dealer: "Dealer", status: "OPEN" },
  ];
  const summary = approvalNotifications(store, manager);
  assert.equal(summary.total, 1);
  assert.equal(summary.reviewable, 0);
  assert.equal(summary.entries[0].status, "Day closed");
  assert.equal(summary.entries[0].subject, "Alex · Main floor");
});

test("counts follow real request status changes and do not depend on a fabricated unread flag", () => {
  const store = fixture([request("one")]);
  assert.equal(approvalNotifications(store, manager).total, 1);
  store.approvals[0].status = "APPROVED";
  assert.deepEqual(approvalNotifications(store, manager), {
    total: 0,
    reviewable: 0,
    entries: [],
  });
  assert.deepEqual(approvalNotifications(emptyStore()), {
    total: 0,
    reviewable: 0,
    entries: [],
  });
});
