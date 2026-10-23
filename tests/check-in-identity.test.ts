import test from "node:test";
import assert from "node:assert/strict";
import type { Command } from "../src/domain/commands";
import type { Staff, Store } from "../src/domain/model";
import { applyCommand } from "../src/domain/operations";
import { debt, totalsForDay } from "../src/domain/selectors";
import { configuredStore } from "./helpers/store";

const admin: Staff = {
  id: "identity-admin",
  username: "identity-admin",
  role: "ADMIN",
  branchId: "local",
};
const cashier: Staff = { ...admin, id: "identity-cashier", role: "CASHIER" };

function act(store: Store, command: Command, actor = admin) {
  return applyCommand(store, command, actor, "2026-10-24T02:00:00.000Z");
}

function returningCreditPlayer() {
  let store = act(configuredStore(), {
    kind: "OPEN_DAY",
    date: "2026-10-24",
    openingCash: 1_000_000,
  });
  store = act(store, {
    kind: "TABLE",
    name: "Main floor",
    dealer: "",
    status: "OPEN",
  });
  store = act(store, {
    kind: "CHECK_IN",
    name: "Farid Aziz",
    phone: "+12025550110",
    type: "CREDIT",
    creditLimit: 500_000,
    tags: ["VIP"],
    tableId: store.tables[0].id,
    seat: 1,
  });
  const playerId = store.profiles[0].id;
  for (const [type, amount] of [
    ["Buy-in", 70_000],
    ["Cash-out", 0],
  ] as const) {
    store = act(
      store,
      { kind: "REQUEST", type, playerId, amount, note: "Identity regression" },
      cashier,
    );
    store = act(store, {
      kind: "DECIDE",
      approvalId: store.approvals[0].id,
      decision: "APPROVED",
    });
  }
  assert.equal(debt(store, playerId), 70_000);
  return store;
}

function checkIn(store: Store): Extract<Command, { kind: "CHECK_IN" }> {
  return {
    kind: "CHECK_IN",
    name: "Review New Cash",
    phone: "+1 (202) 555-0110",
    type: "CASH",
    creditLimit: 0,
    tags: [],
    tableId: store.tables[0].id,
    seat: 2,
  };
}

test("a new-player check-in cannot silently reuse an existing credit identity with the same normalized phone", () => {
  const store = returningCreditPlayer();
  const before = structuredClone(store);
  assert.throws(
    () => act(store, checkIn(store), cashier),
    /phone number belongs to an existing player/,
  );
  assert.deepEqual(
    store,
    before,
    "rejected check-in must preserve all profiles, sessions and debt",
  );
});

test("duplicate phone formats all require an explicit existing-player selection", () => {
  const store = returningCreditPlayer();
  for (const phone of [
    "+12025550110",
    "+1 202 555 0110",
    "+1 (202) 555-0110",
  ]) {
    assert.throws(
      () => act(store, { ...checkIn(store), phone }, cashier),
      /phone number belongs to an existing player/,
    );
  }
});

test("explicit returning-player selection keeps the authoritative profile, debt and visit history", () => {
  const before = returningCreditPlayer();
  const profile = before.profiles[0];
  const after = act(
    before,
    { ...checkIn(before), playerId: profile.id },
    cashier,
  );
  assert.deepEqual(after.profiles, before.profiles);
  assert.deepEqual(after.transactions, before.transactions);
  assert.deepEqual(after.approvals, before.approvals);
  assert.deepEqual(after.sessions.slice(0, -1), before.sessions);
  assert.equal(after.sessions.at(-1)?.playerId, profile.id);
  assert.equal(after.sessions.at(-1)?.status, "ACTIVE");
  assert.equal(after.sessions.at(-1)?.seat, 2);
  assert.notEqual(after.sessions.at(-1)?.id, before.sessions[0].id);
  assert.equal(debt(after, profile.id), 70_000);
  assert.deepEqual(totalsForDay(after), totalsForDay(before));
});

test("a missing or mismatched selected profile never falls back to the phone lookup or creates a new account", () => {
  const store = returningCreditPlayer();
  const before = structuredClone(store);
  for (const identity of [
    { playerId: "missing-profile" },
    { playerId: store.profiles[0].id, phone: "+12025550111" },
  ]) {
    assert.throws(
      () => act(store, { ...checkIn(store), ...identity }, cashier),
      /selected player no longer matches this phone number/,
    );
    assert.deepEqual(store, before);
  }
});

test("a new unique phone creates one cash identity and a later duplicate submission cannot silently reuse it", () => {
  const original = returningCreditPlayer();
  const command = { ...checkIn(original), phone: "+12025550111" };
  const store = act(original, command, cashier);
  assert.equal(store.profiles.length, original.profiles.length + 1);
  const created = store.profiles.find(
    (profile) => profile.phone === command.phone,
  )!;
  assert.equal(created.name, "Review New Cash");
  assert.equal(created.type, "CASH");
  assert.equal(created.creditLimit, 0);
  assert.equal(store.sessions.at(-1)?.playerId, created.id);
  assert.throws(
    () => act(store, { ...command, seat: 3 }, cashier),
    /phone number belongs to an existing player/,
  );
});

test("explicit selection preserves banned, already-active and disabled-credit check-in restrictions", () => {
  const original = returningCreditPlayer();
  const command = { ...checkIn(original), playerId: original.profiles[0].id };
  const banned = structuredClone(original);
  banned.profiles[0].tags = ["Banned"];
  assert.throws(() => act(banned, command, cashier), /banned/);
  const active = act(original, command, cashier);
  assert.throws(
    () => act(active, { ...command, seat: 3 }, cashier),
    /already checked in/,
  );
  const disabledCredit = structuredClone(original);
  disabledCredit.settings!.creditEnabled = false;
  assert.throws(
    () => act(disabledCredit, command, cashier),
    /Credit accounts are disabled/,
  );
});
