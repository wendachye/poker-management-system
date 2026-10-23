import assert from "node:assert/strict";
import test from "node:test";
import type { Command } from "../src/domain/commands";
import type { Snapshot } from "../src/domain/model";
import {
  prototypeRequest,
  resetPrototype,
  subscribePrototype,
} from "../src/prototype/runtime";

async function snapshot(): Promise<Snapshot> {
  const response = await prototypeRequest("/api/state");
  assert.equal(response.status, 200);
  return response.json();
}

test("prototype duplicate-phone rejection preserves the snapshot, then explicit returning check-in commits once across retries", async (t) => {
  resetPrototype("walkthrough");
  const before = await snapshot();
  const player = before.store.profiles.find(
    (profile) => profile.type === "CREDIT",
  )!;
  const table = before.store.tables.find((entry) => entry.status === "OPEN")!;
  const command: Extract<Command, { kind: "CHECK_IN" }> = {
    kind: "CHECK_IN",
    name: "A different cash identity",
    phone: player.phone,
    type: "CASH",
    creditLimit: 0,
    tags: [],
    tableId: table.id,
    seat: 1,
  };
  const payload = {
    branchId: before.branch.id,
    revision: before.revision,
    operationId: crypto.randomUUID(),
    command,
  };
  const post = (body: typeof payload) =>
    prototypeRequest("/api/state", {
      method: "POST",
      body: JSON.stringify(body),
    });
  let notifications = 0;
  t.after(subscribePrototype(() => notifications++));
  t.after(() => resetPrototype("busy"));

  const rejected = await post(payload);
  assert.equal(rejected.status, 400);
  assert.match(
    (await rejected.json()).error,
    /phone number belongs to an existing player/,
  );
  assert.deepEqual(await snapshot(), before);
  assert.equal(notifications, 0);

  const selected = {
    ...payload,
    operationId: crypto.randomUUID(),
    command: { ...command, playerId: player.id },
  };
  const response = await post(selected);
  const after = (await response.json()) as Snapshot;
  assert.equal(response.status, 200);
  assert.ok(after.revision > before.revision);
  assert.equal(notifications, 1);
  assert.deepEqual(after.store.profiles, before.store.profiles);
  assert.deepEqual(after.store.transactions, before.store.transactions);
  assert.equal(after.store.sessions.at(-1)?.playerId, player.id);
  assert.equal(after.store.sessions.at(-1)?.seat, 1);
  const retry = await post(selected);
  assert.equal(retry.status, 200);
  assert.deepEqual(await retry.json(), after);
  assert.equal(notifications, 1);
  assert.deepEqual(await snapshot(), after);
});
