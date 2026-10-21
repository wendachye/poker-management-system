import test from "node:test";
import assert from "node:assert/strict";
import { applyCommand } from "../src/domain/operations";
import {
  defaultSettings,
  effectiveTableRules,
  editableSettingsSchema,
  venueSettings,
} from "../src/domain/settings";
import { emptyStore, currentDay, debt } from "../src/domain/selectors";
import { configuredStore } from "./helpers/store";
import type { Command } from "../src/domain/commands";
import type { Staff, Store, EntryType } from "../src/domain/model";

const admin: Staff = {
  id: "admin",
  username: "admin",
  role: "ADMIN",
  branchId: "local",
};
const manager: Staff = {
  ...admin,
  id: "manager",
  username: "manager",
  role: "MANAGER",
};
const cashier: Staff = {
  ...admin,
  id: "cashier",
  username: "cashier",
  role: "CASHIER",
};
function act(store: Store, command: Command, actor = admin) {
  return applyCommand(store, command, actor, "2026-10-21T02:00:00Z");
}
function settings() {
  const { setupCompleted: _, ...value } = defaultSettings();
  void _;
  return value;
}
function save(
  store: Store,
  overrides: Partial<ReturnType<typeof settings>> = {},
) {
  const { setupCompleted: _, ...current } = venueSettings(store);
  void _;
  return act(store, {
    kind: "UPDATE_SETTINGS",
    settings: { ...current, ...overrides },
    reason: "Set venue operating rules",
  });
}
function fixture() {
  let store = act(configuredStore(), {
    kind: "TABLE",
    name: "Main table",
    dealer: "Dealer",
    status: "OPEN",
  });
  store = act(store, {
    kind: "OPEN_DAY",
    date: "2026-10-21",
    openingCash: 1_000_000,
  });
  for (const credit of [false, true])
    store = act(store, {
      kind: "CHECK_IN",
      name: credit ? "Credit Player" : "Cash Player",
      phone: credit ? "+12025550122" : "+12025550121",
      type: credit ? "CREDIT" : "CASH",
      creditLimit: credit ? 500_000 : 0,
      tags: [],
      tableId: store.tables[0].id,
      seat: credit ? 2 : 1,
    });
  return store;
}
function request(
  store: Store,
  type: EntryType,
  amount: number,
  playerId?: string,
) {
  return act(
    store,
    {
      kind: "REQUEST",
      type,
      amount,
      playerId,
      tableId: store.tables[0].id,
      note: "Settings workflow entry",
    },
    cashier,
  );
}
function approve(
  store: Store,
  approvalId = store.approvals[0].id,
  actor = manager,
) {
  return act(
    store,
    { kind: "DECIDE", approvalId, decision: "APPROVED" },
    actor,
  );
}

test("new venues must save settings and configure an open table before completing setup", () => {
  const empty = emptyStore();
  assert.equal(venueSettings(empty).setupCompleted, false);
  assert.throws(
    () => act(empty, { kind: "OPEN_DAY", date: "2026-10-21", openingCash: 0 }),
    /setup/i,
  );
  assert.throws(() => act(empty, { kind: "COMPLETE_SETUP" }), /settings/i);
  let store = save(empty);
  assert.throws(() => act(store, { kind: "COMPLETE_SETUP" }), /table/i);
  store = act(store, {
    kind: "TABLE",
    name: "Main table",
    dealer: "",
    status: "CLOSED",
  });
  assert.throws(() => act(store, { kind: "COMPLETE_SETUP" }), /table/i);
  store = act(store, {
    kind: "TABLE",
    tableId: store.tables[0].id,
    name: "Main table",
    dealer: "",
    status: "OPEN",
  });
  assert.throws(
    () => act(store, { kind: "COMPLETE_SETUP" }, manager),
    /permission|admin/i,
  );
  assert.throws(
    () =>
      act(
        store,
        {
          kind: "UPDATE_SETTINGS",
          settings: settings(),
          reason: "Manager cannot change settings",
        },
        manager,
      ),
    /permission/,
  );
  store = act(store, { kind: "COMPLETE_SETUP" });
  assert.equal(venueSettings(store).setupCompleted, true);
  assert.equal(store.auditLogs[0].action, "Completed venue setup");
  assert.throws(
    () => act(store, { kind: "COMPLETE_SETUP" }),
    /already complete/,
  );
  store = save(store, { venueName: "Updated venue" });
  assert.equal(venueSettings(store).setupCompleted, true);
});

test("settings reject invalid time zones, blinds, ranges, increments and unnamed custom games", () => {
  for (const invalid of [
    { timezone: "Not/A_Timezone" },
    { smallBlind: 0 },
    { smallBlind: 500, bigBlind: 100 },
    { minBuyIn: 100_000, maxBuyIn: 50_000 },
    { minBuyIn: 1_001, maxBuyIn: 1_100, buyInStep: 1_000 },
    { gameType: "OTHER", gameName: "" },
    { rakePercent: 101 },
    { maxBuyIn: -1 },
  ]) {
    assert.equal(
      editableSettingsSchema.safeParse({ ...settings(), ...invalid }).success,
      false,
    );
    assert.throws(
      () => save(emptyStore(), invalid as Partial<ReturnType<typeof settings>>),
      /Invalid operation/,
    );
  }
  assert.equal(
    editableSettingsSchema.safeParse({
      ...settings(),
      gameType: "OTHER",
      gameName: "Local mixed game",
    }).success,
    true,
  );
});

test("tables inherit venue rules, preserve overrides on ordinary edits, and clear overrides explicitly", () => {
  let store = save(configuredStore(), {
    smallBlind: 500,
    bigBlind: 1_000,
    minBuyIn: 10_000,
    maxBuyIn: 100_000,
    buyInStep: 5_000,
  });
  store = act(store, {
    kind: "TABLE",
    name: "5/10",
    dealer: "",
    status: "OPEN",
  });
  store = act(store, {
    kind: "TABLE",
    name: "10/25",
    dealer: "",
    status: "OPEN",
    smallBlind: 1_000,
    bigBlind: 2_500,
    minBuyIn: 50_000,
    maxBuyIn: 200_000,
    buyInStep: 25_000,
  });
  assert.deepEqual(effectiveTableRules(store, store.tables[0]), {
    smallBlind: 500,
    bigBlind: 1_000,
    minBuyIn: 10_000,
    maxBuyIn: 100_000,
    buyInStep: 5_000,
  });
  assert.deepEqual(effectiveTableRules(store, store.tables[1]), {
    smallBlind: 1_000,
    bigBlind: 2_500,
    minBuyIn: 50_000,
    maxBuyIn: 200_000,
    buyInStep: 25_000,
  });
  store = act(store, {
    kind: "TABLE",
    tableId: store.tables[1].id,
    name: "High stakes",
    dealer: "New dealer",
    status: "OPEN",
  });
  assert.equal(store.tables[1].bigBlind, 2_500);
  assert.equal(store.tables[1].maxBuyIn, 200_000);
  store = act(store, {
    kind: "TABLE",
    tableId: store.tables[1].id,
    name: "Inherited rules",
    dealer: "",
    status: "OPEN",
    smallBlind: null,
    bigBlind: null,
    minBuyIn: null,
    maxBuyIn: null,
    buyInStep: null,
  });
  assert.equal(store.tables[1].bigBlind, undefined);
  assert.deepEqual(
    effectiveTableRules(store, store.tables[1]),
    effectiveTableRules(store),
  );
  assert.throws(
    () =>
      act(store, {
        kind: "TABLE",
        tableId: store.tables[0].id,
        name: "Incomplete blinds",
        dealer: "",
        status: "OPEN",
        smallBlind: 500,
      }),
    /both table blinds/,
  );
});

test("per-table minimum, maximum and increments follow the player's current seat", () => {
  let store = fixture();
  const player = store.profiles[0];
  store = act(store, {
    kind: "TABLE",
    tableId: store.tables[0].id,
    name: "5/10",
    dealer: "",
    status: "OPEN",
    smallBlind: 500,
    bigBlind: 1_000,
    minBuyIn: 20_000,
    maxBuyIn: 80_000,
    buyInStep: 10_000,
  });
  store = act(store, {
    kind: "TABLE",
    name: "10/25",
    dealer: "",
    status: "OPEN",
    smallBlind: 1_000,
    bigBlind: 2_500,
    minBuyIn: 50_000,
    maxBuyIn: 200_000,
    buyInStep: 25_000,
  });
  assert.throws(
    () => request(store, "Buy-in", 10_000, player.id),
    /between|minimum|buy-in/i,
  );
  assert.throws(
    () => request(store, "Buy-in", 90_000, player.id),
    /between|maximum|buy-in/i,
  );
  assert.throws(
    () => request(store, "Buy-in", 25_000, player.id),
    /increment|multiple/i,
  );
  store = approve(request(store, "Buy-in", 30_000, player.id));
  store = act(
    store,
    { kind: "MOVE", playerId: player.id, tableId: store.tables[1].id, seat: 1 },
    cashier,
  );
  assert.throws(
    () => request(store, "Buy-in", 30_000, player.id),
    /between|minimum|buy-in/i,
  );
  assert.throws(
    () => request(store, "Buy-in", 60_000, player.id),
    /increment|multiple/i,
  );
  store = approve(request(store, "Buy-in", 75_000, player.id));
  assert.equal(store.transactions[0].tableId, store.tables[1].id);
});

test("venue changes cannot make an existing table's inherited buy-in range invalid", () => {
  let store = save(configuredStore(), { minBuyIn: 10_000, maxBuyIn: 100_000 });
  store = act(store, {
    kind: "TABLE",
    name: "Capped table",
    dealer: "",
    status: "OPEN",
    maxBuyIn: 80_000,
  });
  assert.throws(() => save(store, { minBuyIn: 90_000 }), /Maximum buy-in/);
  assert.equal(venueSettings(store).minBuyIn, 10_000);
});

test("disabling optional entries blocks new requests while pending approvals and existing credit settlements remain usable", () => {
  let store = fixture();
  const credit = store.profiles.find((profile) => profile.type === "CREDIT")!;
  store = request(store, "Tips", 1_000);
  const pendingTips = store.approvals[0].id;
  store = request(store, "Buy-in", 100_000, credit.id);
  const pendingCredit = store.approvals[0].id;
  store = save(store, {
    tipsEnabled: false,
    rakeEnabled: false,
    insuranceEnabled: false,
    jackpotEnabled: false,
    creditEnabled: false,
    minBuyIn: 200_000,
  });
  for (const type of [
    "Tips",
    "Rake",
    "Insurance Premium",
    "Insurance Payout",
    "Jackpot Contribution",
    "Jackpot Payout",
  ] as const)
    assert.throws(() => request(store, type, 1_000), /disabled/);
  assert.throws(() => request(store, "Buy-in", 200_000, credit.id), /disabled/);
  assert.throws(
    () =>
      act(store, {
        kind: "CHECK_IN",
        name: "New Credit Player",
        phone: "+12025550123",
        type: "CREDIT",
        creditLimit: 100_000,
        tags: [],
        tableId: store.tables[0].id,
        seat: 3,
      }),
    /disabled/,
  );
  store = approve(store, pendingTips);
  store = approve(store, pendingCredit);
  assert.equal(debt(store, credit.id), 100_000);
  store = approve(request(store, "Credit Repayment", 40_000, credit.id));
  store = approve(
    request(store, "Cash-out", 60_000, credit.id),
    undefined,
    admin,
  );
  assert.equal(debt(store, credit.id), 0);
  assert.equal(
    store.sessions.find((session) => session.playerId === credit.id)?.status,
    "OUT",
  );
});

test("a close dialog for an earlier day cannot close a newly opened day", () => {
  let store = act(configuredStore(), {
    kind: "OPEN_DAY",
    date: "2026-10-21",
    openingCash: 100_000,
  });
  const previousDay = currentDay(store)!.id;
  store = act(store, {
    kind: "CLOSE_DAY",
    dayId: previousDay,
    countedCash: 100_000,
    reason: "",
  });
  store = act(store, {
    kind: "OPEN_DAY",
    date: "2026-10-22",
    openingCash: 200_000,
  });
  const before = structuredClone(store);
  assert.throws(
    () =>
      act(store, {
        kind: "CLOSE_DAY",
        dayId: previousDay,
        countedCash: 100_000,
        reason: "Outdated closing dialog",
      }),
    /day changed/i,
  );
  assert.deepEqual(store, before);
  assert.equal(currentDay(store)?.status, "OPEN");
});
