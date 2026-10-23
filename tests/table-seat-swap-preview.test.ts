import assert from "node:assert/strict";
import test from "node:test";
import {
  seatSwapBlockedReason,
  seatSwapParticipant,
} from "../src/components/page/PokerManagementPage/components/table-seat-move";
import type { SeatSwapParticipant } from "../src/domain/commands";
import type { Store } from "../src/domain/model";
import { applyCommand } from "../src/domain/operations";
import { auditChanges, auditReason } from "../src/lib/audit-presentation";
import { createPrototypeSample } from "../src/prototype/sample-data";

function fixture() {
  const store = createPrototypeSample(
    "preview",
    "Practice",
    "busy",
    new Date("2026-10-23T10:00:00Z"),
  ).store;
  const participant = (name: string) => {
    const player = store.profiles.find((profile) => profile.name === name)!;
    assert.ok(player);
    const result = seatSwapParticipant(store, player.id);
    assert.ok(result);
    return result;
  };
  return {
    store,
    first: participant("Daniel Wong"),
    second: participant("Aina Yusuf"),
    sameTable: participant("Mei Lim"),
  };
}

const sessionFor = (store: Store, participant: SeatSwapParticipant) => {
  const session = store.sessions.find(
    (entry) => entry.id === participant.sessionId,
  );
  assert.ok(session);
  return session;
};

test("swap previews capture visit identity without changing same-table or cross-table seating", () => {
  const { store, first, second, sameTable } = fixture();
  const before = structuredClone(store);
  assert.equal(first.tableId, sameTable.tableId);
  assert.notEqual(first.tableId, second.tableId);
  assert.equal(first.seat, 5);
  assert.equal(sessionFor(store, first).playerId, first.playerId);
  assert.equal(seatSwapParticipant(store, "missing-player"), null);
  assert.equal(seatSwapBlockedReason(store, first, sameTable), null);
  assert.equal(seatSwapBlockedReason(store, first, second), null);
  assert.deepEqual(store, before, "A preview never saves either assignment");
});

test("a captured swap cannot silently follow either player's moved seat or new visit", () => {
  const { store, first, second } = fixture();
  for (const participant of [first, second]) {
    const moved = structuredClone(store);
    sessionFor(moved, participant).seat = 9;
    assert.match(
      seatSwapBlockedReason(moved, first, second)!,
      /seating changed/i,
    );
    assert.notEqual(
      seatSwapParticipant(moved, participant.playerId)!.seat,
      participant.seat,
    );
    const returned = structuredClone(store);
    const original = sessionFor(returned, participant);
    original.status = "OUT";
    returned.sessions.push({
      ...original,
      id: original.id + "-new-visit",
      status: "ACTIVE",
    });
    assert.match(
      seatSwapBlockedReason(returned, first, second)!,
      /seating changed/i,
    );
    assert.notEqual(
      seatSwapParticipant(returned, participant.playerId)!.sessionId,
      participant.sessionId,
    );
  }
});

test("either player's pending request blocks a preview until resolved, using either linkage", () => {
  const { store, first, second } = fixture();
  for (const participant of [first, second]) {
    for (const linkage of ["player", "session"]) {
      const pending = structuredClone(store);
      const request = pending.approvals.find(
        (entry) => entry.status === "PENDING",
      )!;
      request.playerId =
        linkage === "player" ? participant.playerId : undefined;
      request.sessionId =
        linkage === "session" ? participant.sessionId : undefined;
      assert.equal(
        seatSwapBlockedReason(pending, first, second),
        "Resolve pending request first",
      );
      request.status = "REJECTED";
      assert.equal(seatSwapBlockedReason(pending, first, second), null);
    }
  }
});

test("swap previews reject a self-drop, a closed destination and an unexpected occupant", () => {
  const { store, first, second } = fixture();
  assert.equal(
    seatSwapBlockedReason(store, first, first),
    "Choose two different players.",
  );
  const closed = structuredClone(store);
  closed.tables.find((table) => table.id === second.tableId)!.status = "CLOSED";
  assert.equal(
    seatSwapBlockedReason(closed, first, second),
    "Both tables must be open to swap players.",
  );
  const occupied = structuredClone(store);
  occupied.sessions.push({
    ...sessionFor(occupied, second),
    id: "unexpected-session",
    playerId: "unexpected-player",
  });
  assert.match(
    seatSwapBlockedReason(occupied, first, second)!,
    /seating changed/i,
  );
});

test("paired swap audit entries show clean player names and both seat changes", () => {
  const { store, first, second } = fixture();
  for (const profile of store.profiles)
    profile.name = "Sample · " + profile.name;
  for (const table of store.tables) table.name = "Sample · " + table.name;
  const swapped = applyCommand(
    store,
    { kind: "SWAP_SEATS", first, second },
    {
      id: "operator",
      username: "cashier",
      role: "CASHIER",
      branchId: "preview",
    },
  );
  const logs = swapped.auditLogs.slice(0, 2);
  assert.equal(logs[0].reason, logs[1].reason);
  const reason = JSON.parse(logs[0].reason);
  assert.equal(typeof reason.swapId, "string");
  assert.deepEqual(reason.players, [first.playerId, second.playerId]);
  for (const log of logs)
    assert.equal(auditReason(log, swapped), "Daniel Wong ↔ Aina Yusuf");
  const firstLog = logs.find((log) => log.entity === first.playerId)!;
  const secondLog = logs.find((log) => log.entity === second.playerId)!;
  assert.deepEqual(auditChanges(firstLog, swapped), [
    { label: "Value", before: "Main floor · 5", after: "Lounge · 1" },
  ]);
  assert.deepEqual(auditChanges(secondLog, swapped), [
    { label: "Value", before: "Lounge · 1", after: "Main floor · 5" },
  ]);

  const missingProfile = structuredClone(swapped);
  missingProfile.profiles = [];
  assert.equal(auditReason(firstLog, missingProfile), "Seat swap");
  assert.equal(
    auditReason({ ...firstLog, reason: "{malformed" }, swapped),
    "Seat swap",
  );
});
