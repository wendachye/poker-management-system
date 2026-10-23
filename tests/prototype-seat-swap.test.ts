import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import type { Command, SeatSwapParticipant } from "../src/domain/commands";
import type { Snapshot } from "../src/domain/model";
import { totalsForDay } from "../src/domain/selectors";
import {
  prototypeRequest,
  resetPrototype,
  subscribePrototype,
} from "../src/prototype/runtime";

type Swap = Extract<Command, { kind: "SWAP_SEATS" }>;

beforeEach(() => resetPrototype("busy"));

async function snapshot(): Promise<Snapshot> {
  const response = await prototypeRequest("/api/state");
  assert.equal(response.status, 200);
  return response.json();
}

function participant(state: Snapshot, name: string): SeatSwapParticipant {
  const player = state.store.profiles.find((profile) => profile.name === name)!;
  assert.ok(player, `Missing sample player ${name}`);
  const session = state.store.sessions.find(
    (entry) =>
      entry.playerId === player.id &&
      entry.dayId === state.store.currentDayId &&
      entry.status === "ACTIVE",
  )!;
  assert.ok(session, `Missing active sample session for ${name}`);
  return {
    playerId: player.id,
    sessionId: session.id,
    tableId: session.tableId,
    seat: session.seat,
  };
}

function payload(state: Snapshot, command: Command) {
  return {
    branchId: state.branch.id,
    revision: state.revision,
    operationId: crypto.randomUUID(),
    command,
  };
}

function post(body: ReturnType<typeof payload>) {
  return prototypeRequest("/api/state", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

for (const other of ["Mei Lim", "Aina Yusuf"]) {
  test(`the prototype swaps Daniel with ${other} once across transport retries`, async (t) => {
    const before = await snapshot();
    const command: Swap = {
      kind: "SWAP_SEATS",
      first: participant(before, "Daniel Wong"),
      second: participant(before, other),
    };
    const request = payload(before, command);
    let notifications = 0;
    t.after(subscribePrototype(() => notifications++));

    const response = await post(request);
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    const after = result as Snapshot;
    assert.ok(after.revision > before.revision);
    assert.equal(notifications, 1, "Both assignments publish one snapshot");
    for (const [original, destination] of [
      [command.first, command.second],
      [command.second, command.first],
    ]) {
      const initial = before.store.sessions.find(
        (session) => session.id === original.sessionId,
      )!;
      assert.deepEqual(
        after.store.sessions.find(
          (session) => session.id === original.sessionId,
        ),
        { ...initial, tableId: destination.tableId, seat: destination.seat },
      );
    }
    assert.deepEqual(after.store.profiles, before.store.profiles);
    assert.deepEqual(after.store.transactions, before.store.transactions);
    assert.deepEqual(after.store.approvals, before.store.approvals);
    assert.deepEqual(totalsForDay(after.store), totalsForDay(before.store));
    assert.equal(
      after.store.auditLogs.length,
      before.store.auditLogs.length + 2,
    );
    assert.deepEqual(
      new Set(after.store.auditLogs.slice(0, 2).map((entry) => entry.entity)),
      new Set([command.first.playerId, command.second.playerId]),
    );

    const retried = await post(request);
    assert.equal(retried.status, 200);
    assert.deepEqual(await retried.json(), after);
    assert.equal(
      notifications,
      1,
      "A retry neither swaps back nor publishes again",
    );

    const replay = await post({
      ...request,
      operationId: crypto.randomUUID(),
      revision: after.revision,
    });
    assert.ok([400, 409].includes(replay.status));
    assert.deepEqual(await snapshot(), after);
    assert.equal(notifications, 1);
  });
}

test("a prototype swap with an outdated revision cannot overwrite a concurrent seat move", async (t) => {
  const before = await snapshot();
  const swap = payload(before, {
    kind: "SWAP_SEATS",
    first: participant(before, "Daniel Wong"),
    second: participant(before, "Aina Yusuf"),
  });
  const thirdPlayer = participant(before, "Arjun Rao");
  const moved = await post(
    payload(before, {
      kind: "MOVE",
      playerId: thirdPlayer.playerId,
      tableId: thirdPlayer.tableId,
      seat: 9,
    }),
  );
  assert.equal(moved.status, 200);
  const latest = (await moved.json()) as Snapshot;
  let notifications = 0;
  t.after(subscribePrototype(() => notifications++));

  const stale = await post(swap);
  assert.equal(stale.status, 409);
  assert.deepEqual(await snapshot(), latest);
  assert.equal(notifications, 0);
});

for (const changedSide of ["first", "second"] as const) {
  test(`a fresh revision still rejects a prototype swap whose ${changedSide} seat changed`, async (t) => {
    const before = await snapshot();
    const command: Swap = {
      kind: "SWAP_SEATS",
      first: participant(before, "Daniel Wong"),
      second: participant(before, "Aina Yusuf"),
    };
    const original = command[changedSide];
    const moved = await post(
      payload(before, {
        kind: "MOVE",
        playerId: original.playerId,
        tableId: original.tableId,
        seat: 9,
      }),
    );
    assert.equal(moved.status, 200);
    const latest = (await moved.json()) as Snapshot;
    let notifications = 0;
    t.after(subscribePrototype(() => notifications++));
    const request = payload(latest, command);

    const stale = await post(request);
    assert.ok([400, 409].includes(stale.status));
    assert.deepEqual(await snapshot(), latest);
    assert.equal(notifications, 0);

    // A rejected command does not reserve the operation identifier or mutate either seat.
    const reviewed = await post({
      ...request,
      command: {
        kind: "SWAP_SEATS",
        first: participant(latest, "Daniel Wong"),
        second: participant(latest, "Aina Yusuf"),
      },
    });
    assert.equal(reviewed.status, 200, JSON.stringify(await reviewed.json()));
    assert.equal(notifications, 1);
  });
}

test("a city prototype swap cannot change the selected Riverside venue", async () => {
  const city = await snapshot();
  const request = payload(city, {
    kind: "SWAP_SEATS",
    first: participant(city, "Daniel Wong"),
    second: participant(city, "Aina Yusuf"),
  });
  const switched = await prototypeRequest("/api/branch", {
    method: "POST",
    body: JSON.stringify({ branchId: "demo-riverside" }),
  });
  assert.equal(switched.status, 200);
  const riverside = await snapshot();
  const wrongBranch = await post(request);
  assert.equal(wrongBranch.status, 409);
  assert.deepEqual(await snapshot(), riverside);

  const foreignPlayers = await post({
    ...request,
    branchId: riverside.branch.id,
    revision: riverside.revision,
  });
  assert.ok([400, 409].includes(foreignPlayers.status));
  assert.deepEqual(await snapshot(), riverside);
});
