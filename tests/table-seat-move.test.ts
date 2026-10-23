import assert from "node:assert/strict";
import test from "node:test";
import { applyCommand } from "../src/domain/operations";
import type { Command } from "../src/domain/commands";
import type { Staff, Store } from "../src/domain/model";
import { totalsForDay } from "../src/domain/selectors";
import {
  playerMoveBlockedReason,
  seatMoveBlockedReason,
} from "../src/components/page/PokerManagementPage/components/table-seat-move";
import { configuredStore } from "./helpers/store";

const admin: Staff = {
  id: "admin",
  username: "admin",
  role: "ADMIN",
  branchId: "venue",
};
const cashier: Staff = {
  ...admin,
  id: "cashier",
  username: "cashier",
  role: "CASHIER",
};
const act = (store: Store, command: Command, actor = admin) =>
  applyCommand(store, command, actor, "2026-10-23T10:00:00.000Z");

function fixture() {
  let store = act(configuredStore(), {
    kind: "OPEN_DAY",
    date: "2026-10-23",
    openingCash: 2_000_000,
  });
  for (const name of ["Main floor", "Lounge", "Closed room"])
    store = act(store, {
      kind: "TABLE",
      name,
      dealer: "",
      status: name === "Closed room" ? "CLOSED" : "OPEN",
    });
  store = act(store, {
    kind: "CHECK_IN",
    name: "Alex",
    phone: "+12025550100",
    type: "CASH",
    creditLimit: 0,
    tags: [],
    tableId: store.tables[0].id,
    seat: 1,
  });
  return store;
}

test("same-table and cross-table seat previews allow moves without changing balances or ending a visit", () => {
  const before = fixture();
  const unchanged = structuredClone(before);
  const playerId = before.profiles[0].id;
  for (const destination of [
    { tableId: before.tables[0].id, seat: 2 },
    { tableId: before.tables[1].id, seat: 9 },
  ]) {
    assert.equal(seatMoveBlockedReason(before, playerId, destination), null);
    assert.deepEqual(before, unchanged);
    const after = act(
      before,
      { kind: "MOVE", playerId, ...destination },
      cashier,
    );
    assert.equal(after.sessions[0].id, before.sessions[0].id);
    assert.equal(after.sessions[0].status, "ACTIVE");
    assert.equal(after.sessions[0].tableId, destination.tableId);
    assert.equal(after.sessions[0].seat, destination.seat);
    assert.deepEqual(totalsForDay(after), totalsForDay(before));
    assert.equal(after.transactions.length, before.transactions.length);
    assert.equal(after.auditLogs[0].action, "Moved player");
  }
});

test("seat previews reject occupied, closed, missing, current and invalid destinations", () => {
  let store = fixture();
  const playerId = store.profiles[0].id;
  store = act(store, {
    kind: "CHECK_IN",
    name: "Sara",
    phone: "+12025550103",
    type: "CASH",
    creditLimit: 0,
    tags: [],
    tableId: store.tables[1].id,
    seat: 2,
  });
  const blocked = (tableId: string, seat: number) =>
    seatMoveBlockedReason(store, playerId, { tableId, seat });
  assert.equal(blocked(store.tables[1].id, 2), "That seat is occupied.");
  assert.equal(blocked(store.tables[2].id, 2), "Select an open table.");
  assert.equal(blocked("missing", 2), "Select an open table.");
  assert.equal(blocked(store.tables[0].id, 1), "Choose a different seat.");
  for (const seat of [0, 10, 1.5, Number.NaN])
    assert.equal(
      blocked(store.tables[0].id, seat),
      "Select a seat from 1 to 9.",
    );
});

test("a request arriving during a drag blocks the drop until it is resolved", () => {
  let store = fixture();
  const playerId = store.profiles[0].id;
  const destination = { tableId: store.tables[1].id, seat: 2 };
  assert.equal(seatMoveBlockedReason(store, playerId, destination), null);
  store = act(
    store,
    { kind: "REQUEST", type: "Buy-in", playerId, amount: 50_000, note: "QA" },
    cashier,
  );
  assert.equal(
    playerMoveBlockedReason(store, playerId),
    "Resolve pending request first",
  );
  assert.equal(
    seatMoveBlockedReason(store, playerId, destination),
    "Resolve pending request first",
  );
  assert.throws(
    () => act(store, { kind: "MOVE", playerId, ...destination }, cashier),
    /pending/,
  );
  store = act(store, {
    kind: "DECIDE",
    approvalId: store.approvals[0].id,
    decision: "REJECTED",
    reason: "Duplicate test request",
  });
  assert.equal(seatMoveBlockedReason(store, playerId, destination), null);
});

test("pending session-only and player-only entries cannot be skipped by dragging", () => {
  const original = fixture();
  const playerId = original.profiles[0].id;
  const requested = act(
    original,
    { kind: "REQUEST", type: "Buy-in", playerId, amount: 50_000, note: "QA" },
    cashier,
  );
  for (const linkage of ["session", "player"] as const) {
    const store = structuredClone(requested);
    if (linkage === "session") store.approvals[0].playerId = undefined;
    else store.approvals[0].sessionId = undefined;
    assert.equal(
      playerMoveBlockedReason(store, playerId),
      "Resolve pending request first",
    );
  }
  const unrelated = structuredClone(requested);
  unrelated.approvals[0].playerId = "another-player";
  unrelated.approvals[0].sessionId = "another-session";
  assert.equal(playerMoveBlockedReason(unrelated, playerId), null);
});

test("stale checked-out players, previous-day sessions and closed or missing days cannot start moves", () => {
  const store = fixture();
  const playerId = store.profiles[0].id;
  const checkedOut = structuredClone(store);
  checkedOut.sessions[0].status = "OUT";
  assert.equal(
    playerMoveBlockedReason(checkedOut, playerId),
    "Player has no active session.",
  );
  const previousDay = structuredClone(store);
  previousDay.sessions[0].dayId = "yesterday";
  assert.equal(
    playerMoveBlockedReason(previousDay, playerId),
    "Player has no active session.",
  );
  const closed = structuredClone(store);
  closed.days[0].status = "CLOSED";
  assert.equal(
    playerMoveBlockedReason(closed, playerId),
    "The business day is closed.",
  );
  assert.equal(
    playerMoveBlockedReason(configuredStore(), playerId),
    "Open a business day before starting operations.",
  );
});
