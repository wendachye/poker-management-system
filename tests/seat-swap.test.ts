import test from "node:test";
import assert from "node:assert/strict";
import {
  commandSchema,
  type Command,
  type SeatSwapParticipant,
} from "../src/domain/commands";
import type { Staff, Store } from "../src/domain/model";
import { applyCommand, DomainError } from "../src/domain/operations";
import { debt, totalsForDay } from "../src/domain/selectors";
import { configuredStore } from "./helpers/store";

const time = "2026-10-23T10:00:00.000Z";
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
type SwapCommand = Extract<Command, { kind: "SWAP_SEATS" }>;

function act(store: Store, command: Command, actor = admin) {
  return applyCommand(store, command, actor, time);
}

function participant(store: Store, name: string): SeatSwapParticipant {
  const profile = store.profiles.find((value) => value.name === name);
  assert.ok(profile);
  const session = store.sessions.find(
    (value) => value.playerId === profile.id && value.status === "ACTIVE",
  );
  assert.ok(session);
  return {
    playerId: profile.id,
    sessionId: session.id,
    tableId: session.tableId,
    seat: session.seat,
  };
}

function fixture(crossTable = false) {
  let store = act(configuredStore(), {
    kind: "OPEN_DAY",
    date: "2026-10-23",
    openingCash: 2_000_000,
  });
  store = act(store, {
    kind: "TABLE",
    name: "Main floor",
    dealer: "",
    status: "OPEN",
    smallBlind: 500,
    bigBlind: 1000,
  });
  store = act(store, {
    kind: "TABLE",
    name: "Lounge",
    dealer: "",
    status: "OPEN",
    smallBlind: 1000,
    bigBlind: 2500,
  });
  const main = store.tables.find((value) => value.name === "Main floor")!.id;
  const lounge = store.tables.find((value) => value.name === "Lounge")!.id;
  for (const [name, phone, type, tableId, seat] of [
    ["Cash Alex", "+60123456701", "CASH", main, 1],
    [
      "Credit Sara",
      "+60123456702",
      "CREDIT",
      crossTable ? lounge : main,
      crossTable ? 1 : 2,
    ],
    ["Other player", "+60123456703", "CASH", lounge, 9],
  ] as const) {
    store = act(store, {
      kind: "CHECK_IN",
      name,
      phone,
      type,
      creditLimit: type === "CREDIT" ? 200_000 : 0,
      tags: [],
      tableId,
      seat,
    });
  }
  const first = participant(store, "Cash Alex");
  const second = participant(store, "Credit Sara");
  for (const [playerId, type, amount] of [
    [first.playerId, "Buy-in", 50_000],
    [second.playerId, "Buy-in", 50_000],
    [second.playerId, "Credit Repayment", 20_000],
  ] as const) {
    store = act(
      store,
      {
        kind: "REQUEST",
        type,
        playerId,
        amount,
        note: "Initial chips and credit",
      },
      cashier,
    );
    store = act(store, {
      kind: "DECIDE",
      approvalId: store.approvals[0].id,
      decision: "APPROVED",
    });
  }
  // An earlier visit at the same position must stay historical and not block a swap.
  store.sessions.push({
    ...store.sessions.find((value) => value.id === first.sessionId)!,
    id: "old-visit",
    dayId: "old-day",
    status: "OUT",
    sessionStart: "2026-10-22T10:00:00.000Z",
    sessionEnd: "2026-10-22T12:00:00.000Z",
  });
  return {
    store,
    command: { kind: "SWAP_SEATS", first, second } satisfies SwapCommand,
  };
}

function rejected(
  store: Store,
  command: SwapCommand,
  message: RegExp,
  actor = cashier,
) {
  const before = structuredClone(store);
  assert.throws(() => act(store, command, actor), message);
  assert.deepEqual(
    store,
    before,
    "a failed swap must leave its complete input unchanged",
  );
}

function assertSwapped(store: Store, command: SwapCommand, actor = cashier) {
  const before = structuredClone(store);
  const after = act(store, command, actor);
  assert.deepEqual(
    store,
    before,
    "a successful command must also leave its input unchanged",
  );
  for (const [source, destination] of [
    [command.first, command.second],
    [command.second, command.first],
  ]) {
    assert.deepEqual(
      after.sessions.find((value) => value.id === source.sessionId),
      {
        ...before.sessions.find((value) => value.id === source.sessionId),
        tableId: destination.tableId,
        seat: destination.seat,
      },
    );
  }
  const untouched = (value: Store) =>
    value.sessions.filter(
      (session) =>
        ![command.first.sessionId, command.second.sessionId].includes(
          session.id,
        ),
    );
  assert.deepEqual(untouched(after), untouched(before));
  for (const key of [
    "profiles",
    "transactions",
    "approvals",
    "tables",
    "days",
    "settings",
  ] as const) {
    assert.deepEqual(after[key], before[key], `${key} must be preserved`);
  }
  assert.deepEqual(totalsForDay(after), totalsForDay(before));
  assert.equal(debt(after, command.second.playerId), 30_000);
  assert.equal(after.currentDayId, before.currentDayId);
  assert.equal(after.auditLogs.length, before.auditLogs.length + 2);
  assert.deepEqual(after.auditLogs.slice(2), before.auditLogs);
  const logs = after.auditLogs.slice(0, 2);
  assert.equal(logs[0].reason, logs[1].reason);
  const reason = JSON.parse(logs[0].reason);
  assert.match(reason.swapId, /^SWAP-/);
  assert.deepEqual(reason.players, [
    command.first.playerId,
    command.second.playerId,
  ]);
  for (const [source, destination] of [
    [command.first, command.second],
    [command.second, command.first],
  ]) {
    const log = logs.find((value) => value.entity === source.playerId);
    assert.ok(log);
    assert.equal(log.action, "Swapped player seats");
    assert.equal(log.before, `${source.tableId}, seat ${source.seat}`);
    assert.equal(log.after, `${destination.tableId}, seat ${destination.seat}`);
    assert.equal(log.actorId, actor.id);
    assert.equal(log.actor, actor.username);
    assert.equal(log.time, time);
  }
  return after;
}

for (const crossTable of [false, true]) {
  test(`atomic ${crossTable ? "cross-table" : "same-table"} swap preserves visits, balances, history and ledger`, () => {
    const { store, command } = fixture(crossTable);
    assertSwapped(store, command);
  });
}

test("cashiers, managers and admins can swap; dealers cannot", () => {
  const { store, command } = fixture();
  for (const role of ["CASHIER", "MANAGER", "ADMIN"] as const) {
    assertSwapped(store, command, { ...cashier, role });
  }
  const dealer = { ...cashier, role: "DEALER" as const };
  rejected(store, command, /permission/, dealer);
  assert.throws(
    () => act(store, command, dealer),
    (error) => error instanceof DomainError && error.status === 403,
  );
});

test("swap requires a current open business day", () => {
  const { store, command } = fixture();
  rejected({ ...store, currentDayId: null }, command, /open a business day/);
  const closed = structuredClone(store);
  closed.days.find((value) => value.id === closed.currentDayId)!.status =
    "CLOSED";
  rejected(closed, command, /business day is closed/);
});

test("swap rejects the same player, the same session or the same position", () => {
  const { store, command } = fixture();
  rejected(
    store,
    {
      ...command,
      second: { ...command.second, playerId: command.first.playerId },
    },
    /different players/,
  );
  rejected(
    store,
    {
      ...command,
      second: { ...command.second, sessionId: command.first.sessionId },
    },
    /different players/,
  );
  rejected(
    store,
    {
      ...command,
      second: {
        ...command.second,
        tableId: command.first.tableId,
        seat: command.first.seat,
      },
    },
    /different seats/,
  );
});

for (const side of ["first", "second"] as const) {
  test(`${side} participant must still have exactly the confirmed active current-day assignment`, () => {
    const { store, command } = fixture(true);
    for (const replacement of [
      { playerId: "missing-player" },
      { sessionId: "missing-session" },
      { tableId: "missing-table" },
      { seat: 8 },
    ]) {
      rejected(
        store,
        { ...command, [side]: { ...command[side], ...replacement } },
        /seating changed/,
      );
    }
    for (const update of [
      { status: "OUT" as const },
      { dayId: "earlier-day" },
      { tableId: command[side === "first" ? "second" : "first"].tableId },
      { seat: 8 },
    ]) {
      const stale = structuredClone(store);
      Object.assign(
        stale.sessions.find((value) => value.id === command[side].sessionId)!,
        update,
      );
      rejected(stale, command, /seating changed/);
    }
    const missingSession = structuredClone(store);
    missingSession.sessions = missingSession.sessions.filter(
      (value) => value.id !== command[side].sessionId,
    );
    rejected(missingSession, command, /seating changed/);
    const missingProfile = structuredClone(store);
    missingProfile.profiles = missingProfile.profiles.filter(
      (value) => value.id !== command[side].playerId,
    );
    rejected(missingProfile, command, /seating changed/);
  });

  test(`${side} table must remain open and present`, () => {
    const { store, command } = fixture(true);
    const closed = structuredClone(store);
    closed.tables.find((value) => value.id === command[side].tableId)!.status =
      "CLOSED";
    rejected(closed, command, /open table/);
    const missing = structuredClone(store);
    missing.tables = missing.tables.filter(
      (value) => value.id !== command[side].tableId,
    );
    rejected(missing, command, /open table/);
  });

  for (const link of ["playerId", "sessionId"] as const) {
    test(`pending ${side} request linked only by ${link} blocks both assignments`, () => {
      const { store: initialStore, command } = fixture(true);
      let store = initialStore;
      store = act(
        store,
        {
          kind: "REQUEST",
          type: "Buy-in",
          playerId: command[side].playerId,
          amount: 50_000,
          note: "Pending buy-in",
        },
        cashier,
      );
      delete store.approvals[0][link === "playerId" ? "sessionId" : "playerId"];
      rejected(store, command, /Resolve pending request first/);
    });
  }

  test(`unexpected third active occupant at ${side} position blocks the entire swap`, () => {
    const { store, command } = fixture(true);
    const third = store.sessions.find(
      (value) => value.playerId === participant(store, "Other player").playerId,
    )!;
    third.tableId = command[side].tableId;
    third.seat = command[side].seat;
    rejected(store, command, /seat is occupied/);
  });
}

test("a checked-out and rechecked-in player cannot be swapped using an earlier visit snapshot", () => {
  const { store: initialStore, command } = fixture(true);
  let store = initialStore;
  store = act(
    store,
    {
      kind: "REQUEST",
      type: "Cash-out",
      playerId: command.first.playerId,
      amount: 0,
      note: "End earlier visit",
    },
    cashier,
  );
  store = act(store, {
    kind: "DECIDE",
    approvalId: store.approvals[0].id,
    decision: "APPROVED",
  });
  const profile = store.profiles.find(
    (value) => value.id === command.first.playerId,
  )!;
  store = act(
    store,
    {
      kind: "CHECK_IN",
      playerId: profile.id,
      name: profile.name,
      phone: profile.phone,
      type: profile.type,
      creditLimit: profile.creditLimit,
      tags: profile.tags,
      tableId: command.first.tableId,
      seat: command.first.seat,
    },
    cashier,
  );
  assert.notEqual(
    participant(store, profile.name).sessionId,
    command.first.sessionId,
  );
  rejected(store, command, /seating changed/);
});

test("pending requests on both players block; resolving both permits one atomic swap", () => {
  const { store: initialStore, command } = fixture(true);
  let store = initialStore;
  for (const playerId of [command.first.playerId, command.second.playerId]) {
    store = act(
      store,
      {
        kind: "REQUEST",
        type: "Buy-in",
        playerId,
        amount: 50_000,
        note: "Pending chips",
      },
      cashier,
    );
  }
  rejected(store, command, /Resolve pending request first/);
  const pending = store.approvals.filter((value) => value.status === "PENDING");
  store = act(store, {
    kind: "DECIDE",
    approvalId: pending[0].id,
    decision: "REJECTED",
    reason: "Duplicate request",
  });
  rejected(store, command, /Resolve pending request first/);
  store = act(store, {
    kind: "DECIDE",
    approvalId: pending[1].id,
    decision: "REJECTED",
    reason: "Duplicate request",
  });
  assertSwapped(store, command);
});

test("replaying an old swap fails instead of swapping the players back", () => {
  const { store, command } = fixture(true);
  const swapped = assertSwapped(store, command);
  rejected(swapped, command, /seating changed/);
  const fresh: SwapCommand = {
    kind: "SWAP_SEATS",
    first: participant(swapped, "Cash Alex"),
    second: participant(swapped, "Credit Sara"),
  };
  const restored = assertSwapped(swapped, fresh);
  assert.deepEqual(restored.sessions, store.sessions);
  assert.notEqual(restored.auditLogs[0].reason, swapped.auditLogs[0].reason);
});

test("participant schema is strict and requires valid session, table, player and seat snapshots", () => {
  const { command } = fixture();
  assert.equal(commandSchema.safeParse(command).success, true);
  for (const first of [
    { ...command.first, sessionId: undefined },
    { ...command.first, playerId: "" },
    { ...command.first, tableId: "" },
    { ...command.first, seat: 0 },
    { ...command.first, seat: 10 },
    { ...command.first, seat: 1.5 },
    { ...command.first, unexpected: true },
  ]) {
    assert.equal(commandSchema.safeParse({ ...command, first }).success, false);
    assert.equal(
      commandSchema.safeParse({ ...command, second: first }).success,
      false,
    );
  }
  assert.equal(
    commandSchema.safeParse({ ...command, unexpected: true }).success,
    false,
  );
});
