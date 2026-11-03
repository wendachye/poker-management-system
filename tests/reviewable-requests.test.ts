import test from "node:test";
import assert from "node:assert/strict";
import type { ApprovalRequest, Staff } from "../src/domain/model";
import { filterRequests } from "../src/domain/request-filters";
import { configuredStore } from "./helpers/store";
import { exerciseReviewableRequests } from "./helpers/reviewable-requests";
import { testDatabase } from "./helpers/database";

test("local review eligibility requires a real reviewer and the current open day", () => {
  const actor: Staff = {
    id: "review-admin",
    username: "Review admin",
    role: "ADMIN",
    branchId: "fictional",
  };
  const store = configuredStore();
  store.currentDayId = "today";
  store.days = [
    {
      id: "today",
      date: "2026-11-05",
      openedAt: "2026-11-05T02:00:00Z",
      status: "OPEN",
      openingCash: 0,
      closes: [],
    },
  ];
  const request: ApprovalRequest = {
    id: "review-request",
    dayId: "today",
    type: "Rake",
    amount: 5000,
    staff: "Fictional cashier",
    note: "Fictional request",
    status: "PENDING",
    approvalLevel: "MANAGER",
    riskReason: "Independent review",
    requestedBy: "Fictional cashier",
    requestedById: "review-cashier",
    createdAt: "2026-11-05T02:00:00Z",
    votes: [],
  };
  store.approvals = [request];
  assert.equal(
    filterRequests(store, { view: "REVIEWABLE", user: actor }).length,
    1,
  );
  assert.deepEqual(
    filterRequests(store, { view: "REVIEWABLE", userId: actor.id }),
    [],
  );
  request.dayId = "yesterday";
  assert.deepEqual(
    filterRequests(store, { view: "REVIEWABLE", user: actor }),
    [],
  );
  request.dayId = "today";
  store.days[0].status = "CLOSED";
  assert.deepEqual(
    filterRequests(store, { view: "REVIEWABLE", user: actor }),
    [],
  );
  store.days[0].status = "OPEN";
  store.currentDayId = null;
  assert.deepEqual(
    filterRequests(store, { view: "REVIEWABLE", user: actor }),
    [],
  );
});

test("Needs my review matches independent-review policy before search, counts, sorting and pagination", async () => {
  const { db, engine } = await testDatabase();
  try {
    await exerciseReviewableRequests(db);
  } finally {
    await engine.close();
  }
});
