import test from "node:test";
import assert from "node:assert/strict";
import { applyCommand } from "../src/domain/operations";
import type { Snapshot, Staff } from "../src/domain/model";
import { configuredStore } from "./helpers/store";
import {
  checkedInVisit,
  type CheckInContinuation,
} from "../src/components/page/PokerManagementPage/components/check-in-continuation";

const actor: Staff = {
  id: "admin",
  username: "admin",
  role: "ADMIN",
  branchId: "practice",
};
function fixture() {
  const now = "2026-10-24T10:00:00Z";
  let store = applyCommand(
    configuredStore(),
    {
      kind: "OPEN_DAY",
      date: "2026-10-24",
      openingCash: 0,
    },
    actor,
    now,
  );
  store = applyCommand(
    store,
    {
      kind: "TABLE",
      name: "Main floor",
      dealer: "",
      status: "OPEN",
    },
    actor,
    now,
  );
  const expected: CheckInContinuation = {
    branchId: actor.branchId,
    dayId: store.currentDayId!,
    phone: "+1 (202) 555-0199",
    tableId: store.tables[0].id,
    seat: 6,
  };
  const before: Snapshot = {
    revision: 2,
    branch: {
      id: actor.branchId,
      name: "Practice",
      timezone: "Asia/Kuala_Lumpur",
      role: "ADMIN",
    },
    user: actor,
    store,
  };
  const after: Snapshot = {
    ...before,
    revision: 3,
    store: applyCommand(
      store,
      {
        kind: "CHECK_IN",
        name: "New cash player",
        phone: expected.phone,
        type: "CASH",
        creditLimit: 0,
        tags: [],
        tableId: expected.tableId,
        seat: expected.seat,
      },
      actor,
      now,
    ),
  };
  return { before, after, expected };
}

test("buy-in handoff resolves the newly committed visit, with no financial request posted", () => {
  const { before, after, expected } = fixture();
  assert.equal(checkedInVisit(before, expected), null);
  assert.deepEqual(checkedInVisit(after, expected), {
    playerId: after.store.profiles[0].id,
    phone: "+12025550199",
    tableId: expected.tableId,
  });
  assert.equal(after.store.approvals.length, 0);
  assert.equal(after.store.transactions.length, 0);
});

test("handoff never redirects to another profile, seat, day, or venue", () => {
  const { after, expected } = fixture();
  for (const changed of [
    { playerId: "another-profile" },
    { phone: "+12025550198" },
    { tableId: "another-table" },
    { seat: 7 },
    { dayId: "another-day" },
    { branchId: "operations" },
  ])
    assert.equal(checkedInVisit(after, { ...expected, ...changed }), null);
  assert.equal(checkedInVisit(null, expected), null);
});

test("handoff stops when the visit or day is no longer active", () => {
  const { after, expected } = fixture();
  after.store.sessions[0].status = "OUT";
  assert.equal(checkedInVisit(after, expected), null);
  after.store.sessions[0].status = "ACTIVE";
  after.store.days[0].status = "CLOSED";
  assert.equal(checkedInVisit(after, expected), null);
});
