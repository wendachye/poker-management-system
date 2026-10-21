import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "./helpers/database";
import { hashPassword, login, sessionUser } from "../src/server/auth";
import { mutate, readSnapshot } from "../src/server/repository";
import { createBackup, parseBackup, restoreBackup } from "../src/server/backup";
import { defaultSettings, effectiveTableRules } from "../src/domain/settings";
import { currentDay, debt, totalsForDay } from "../src/domain/selectors";
import type { Command } from "../src/domain/commands";
import type { EntryType, Role, Snapshot } from "../src/domain/model";

const password = "sample-rules-test-password";
const passwordHash = hashPassword(password);
const roles = {
  admin: "ADMIN",
  manager: "MANAGER",
  manager2: "MANAGER",
  cashier: "CASHIER",
  dealer: "DEALER",
} as const satisfies Record<string, Role>;
type Actor = keyof typeof roles;
const sen = (ringgit: number) => ringgit * 100;

/** This helper creates an in-memory database; no environment connection is used. */
async function venue({ complete = true, open = true } = {}) {
  const { db, engine } = await testDatabase();
  const tokens = {} as Record<Actor, string>;
  for (const [id, role] of Object.entries(roles)) {
    await db.query(
      "INSERT INTO poker_users(id,username,password_hash) VALUES($1,$2,$3)",
      [id, `rules.${id}`, await passwordHash],
    );
    await db.query(
      "INSERT INTO poker_memberships(user_id,branch_id,role) VALUES($1,'local',$2)",
      [id, role],
    );
    tokens[id as Actor] = await login(db, `rules.${id}`, password);
  }
  let snapshot: Snapshot = await readSnapshot(db, tokens.admin);
  let lastPayload: {
    branchId: string;
    revision: number;
    operationId: string;
    command: Command;
  };
  async function act(command: Command, actor: Actor = "admin") {
    lastPayload = {
      branchId: "local",
      revision: snapshot.revision,
      operationId: crypto.randomUUID(),
      command,
    };
    snapshot = await mutate(db, tokens[actor], lastPayload);
    return snapshot;
  }
  async function denied(
    command: Command,
    message: RegExp,
    actor: Actor = "admin",
  ) {
    const before = { revision: snapshot.revision, store: snapshot.store };
    await assert.rejects(
      mutate(db, tokens[actor], {
        branchId: "local",
        revision: snapshot.revision,
        operationId: crypto.randomUUID(),
        command,
      }),
      message,
    );
    const after = await readSnapshot(db, tokens.admin);
    assert.deepEqual({ revision: after.revision, store: after.store }, before);
  }
  const { setupCompleted: _, ...defaults } = defaultSettings();
  void _;
  await act({
    kind: "UPDATE_SETTINGS",
    reason: "Save sample rules for the local workflow test",
    settings: {
      ...defaults,
      smallBlind: sen(5),
      bigBlind: sen(10),
      minBuyIn: sen(200),
      maxBuyIn: sen(5_000),
      buyInStep: sen(50),
      rakePercent: 5,
      rakeCap: sen(50),
      tipsEnabled: true,
      rakeEnabled: true,
      insuranceEnabled: true,
      jackpotEnabled: true,
      creditEnabled: true,
      tipsPolicy: "Voluntary tips are recorded manually.",
      houseRules: "Sample rules for local testing; table limits may differ.",
    },
  });
  await act({
    kind: "TABLE",
    name: "Main floor",
    dealer: "Main dealer",
    status: "OPEN",
  });
  await act({
    kind: "TABLE",
    name: "Reserve",
    dealer: "Reserve dealer",
    status: "OPEN",
    smallBlind: sen(10),
    bigBlind: sen(25),
    minBuyIn: sen(500),
    maxBuyIn: sen(10_000),
    buyInStep: sen(50),
  });
  const main = snapshot.store.tables.find(
    (table) => table.name === "Main floor",
  )!.id;
  const reserve = snapshot.store.tables.find(
    (table) => table.name === "Reserve",
  )!.id;
  if (complete) await act({ kind: "COMPLETE_SETUP" });
  if (open)
    await act(
      { kind: "OPEN_DAY", date: "2026-10-21", openingCash: sen(10_000) },
      "manager",
    );
  async function checkIn(
    name: string,
    phone: string,
    type: "CASH" | "CREDIT",
    tableId = main,
    seat = 1,
    actor: Actor = type === "CREDIT" ? "manager" : "cashier",
  ) {
    await act(
      {
        kind: "CHECK_IN",
        name,
        phone,
        type,
        tableId,
        seat,
        creditLimit: type === "CREDIT" ? sen(5_000) : 0,
        tags: [],
      },
      actor,
    );
    return snapshot.store.profiles.find((profile) => profile.phone === phone)!
      .id;
  }
  async function request(
    type: EntryType,
    ringgit: number,
    playerId?: string,
    tableId = main,
    actor: Actor = "cashier",
  ) {
    await act(
      {
        kind: "REQUEST",
        type,
        amount: sen(ringgit),
        playerId,
        tableId,
        note: "Local rules workflow entry",
      },
      actor,
    );
    return snapshot.store.approvals[0].id;
  }
  async function approve(approvalId: string, actor: Actor) {
    return act({ kind: "DECIDE", approvalId, decision: "APPROVED" }, actor);
  }
  async function post(
    type: EntryType,
    ringgit: number,
    playerId?: string,
    tableId = main,
    actor: Actor = "cashier",
  ) {
    const approvalId = await request(type, ringgit, playerId, tableId, actor);
    const level = snapshot.store.approvals[0].approvalLevel;
    if (level === "DUAL") await approve(approvalId, "manager");
    await approve(approvalId, level === "MANAGER" ? "manager" : "admin");
    return snapshot.store.transactions.find(
      (tx) => tx.approvalId === approvalId,
    )!;
  }
  return {
    db,
    engine,
    tokens,
    main,
    reserve,
    act,
    denied,
    checkIn,
    request,
    approve,
    post,
    get snapshot() {
      return snapshot;
    },
    get store() {
      return snapshot.store;
    },
    get lastPayload() {
      return lastPayload;
    },
  };
}

test("saved sample rules support setup, revision protection, safe retries and branch isolation", async () => {
  const f = await venue({ complete: false, open: false });
  try {
    assert.deepEqual(effectiveTableRules(f.store, f.store.tables[0]), {
      smallBlind: sen(5),
      bigBlind: sen(10),
      minBuyIn: sen(200),
      maxBuyIn: sen(5_000),
      buyInStep: sen(50),
    });
    assert.deepEqual(effectiveTableRules(f.store, f.store.tables[1]), {
      smallBlind: sen(10),
      bigBlind: sen(25),
      minBuyIn: sen(500),
      maxBuyIn: sen(10_000),
      buyInStep: sen(50),
    });
    assert.equal(f.store.settings!.rakePercent, 5);
    assert.equal(f.store.settings!.rakeCap, sen(50));
    await f.denied(
      { kind: "OPEN_DAY", date: "2026-10-21", openingCash: 0 },
      /setup/,
      "manager",
    );
    await f.denied({ kind: "COMPLETE_SETUP" }, /administrator/, "manager");
    await f.act({ kind: "COMPLETE_SETUP" });
    assert.equal(f.store.settings!.setupCompleted, true);
    assert.equal(
      f.store.days.length,
      0,
      "completing setup does not open a day",
    );
    await f.act(
      { kind: "OPEN_DAY", date: "2026-10-21", openingCash: sen(10_000) },
      "manager",
    );
    const opening = f.lastPayload;
    const revision = f.snapshot.revision;
    const retry = await mutate(f.db, f.tokens.manager, opening);
    assert.equal(retry.revision, revision);
    assert.equal(retry.store.days.length, 1);
    await assert.rejects(
      mutate(f.db, f.tokens.manager, {
        ...opening,
        command: { ...opening.command, openingCash: 0 },
      }),
      /identifier/,
    );
    await assert.rejects(mutate(f.db, f.tokens.admin, opening), /identifier/);
    const edit: Command = {
      kind: "TABLE",
      tableId: f.main,
      name: "Main floor",
      dealer: "Next dealer",
      status: "OPEN",
    };
    await f.act(edit, "manager");
    await assert.rejects(
      mutate(f.db, f.tokens.manager, {
        branchId: "local",
        revision,
        operationId: crypto.randomUUID(),
        command: edit,
      }),
      /updated this branch/,
    );
    await assert.rejects(
      mutate(f.db, f.tokens.admin, {
        branchId: "other",
        revision: 0,
        operationId: crypto.randomUUID(),
        command: { kind: "OPEN_DAY", date: "2026-10-21", openingCash: 0 },
      }),
      /branch changed/,
    );
    const other = (
      await f.db.query<{ data: { days: unknown[] } }>(
        "SELECT data FROM poker_branch_state WHERE branch_id='other'",
      )
    ).rows[0];
    assert.equal(other.data.days.length, 0);
    assert.equal(
      (await readSnapshot(f.db, f.tokens.admin)).revision,
      revision + 1,
    );
  } finally {
    await f.engine.close();
  }
});

test("cash players complete seating, table-specific buy-ins, returns, closing and a full backup restore", async () => {
  const f = await venue();
  try {
    const alice = await f.checkIn("Cash Alice", "+12025550201", "CASH");
    const bob = await f.checkIn("Cash Bob", "+12025550202", "CASH", f.main, 2);
    await f.denied(
      {
        kind: "CHECK_IN",
        name: "Seat collision",
        phone: "+12025550203",
        type: "CASH",
        creditLimit: 0,
        tags: [],
        tableId: f.main,
        seat: 1,
      },
      /occupied/,
      "cashier",
    );
    await f.denied(
      {
        kind: "CHECK_IN",
        name: "Cash Alice",
        phone: "+12025550201",
        type: "CASH",
        creditLimit: 0,
        tags: [],
        tableId: f.main,
        seat: 3,
      },
      /already checked in/,
      "cashier",
    );
    assert.equal(
      f.store.profiles.length,
      2,
      "invalid seating must not create a profile",
    );
    for (const [amount, message] of [
      [100, /minimum and maximum/],
      [5_050, /minimum and maximum/],
      [225, /increment/],
    ] as const)
      await f.denied(
        {
          kind: "REQUEST",
          type: "Buy-in",
          amount: sen(amount),
          playerId: alice,
          note: "Invalid local buy-in",
        },
        message,
        "cashier",
      );
    const buyIn = await f.request("Buy-in", 250, alice);
    const buyInPayload = f.lastPayload;
    await f.denied(
      { kind: "MOVE", playerId: alice, tableId: f.reserve, seat: 1 },
      /pending/,
      "cashier",
    );
    await f.denied(
      {
        kind: "REQUEST",
        type: "Cash-out",
        amount: sen(250),
        playerId: alice,
        note: "Pending buy-in blocks settlement",
      },
      /pending/,
      "cashier",
    );
    await f.denied(
      { kind: "DECIDE", approvalId: buyIn, decision: "APPROVED" },
      /Independent/,
      "cashier",
    );
    await f.approve(buyIn, "manager");
    assert.equal(f.store.transactions[0].cashReceived, sen(250));
    await f.act(
      { kind: "MOVE", playerId: alice, tableId: f.reserve, seat: 1 },
      "cashier",
    );
    await f.denied(
      {
        kind: "REQUEST",
        type: "Buy-in",
        amount: sen(250),
        playerId: alice,
        note: "Reserve has a higher minimum",
      },
      /minimum and maximum/,
      "cashier",
    );
    await f.post("Buy-in", 500, alice, f.reserve);
    await f.denied(
      { kind: "MOVE", playerId: bob, tableId: f.reserve, seat: 1 },
      /occupied/,
      "cashier",
    );
    await f.act(
      { kind: "MOVE", playerId: bob, tableId: f.reserve, seat: 2 },
      "cashier",
    );
    await f.post("Buy-in", 500, bob, f.reserve);
    await f.denied(
      { kind: "CLOSE_DAY", countedCash: sen(11_250), reason: "" },
      /active players/,
      "manager",
    );
    const payout = await f.request("Cash-out", 700, alice, f.reserve);
    await f.denied(
      { kind: "DECIDE", approvalId: payout, decision: "APPROVED" },
      /Independent/,
      "manager",
    );
    await f.approve(payout, "admin");
    assert.equal(
      f.store.sessions.find((session) => session.playerId === alice)!.status,
      "OUT",
    );
    const returned = await f.checkIn(
      "Different supplied name",
      "+12025550201",
      "CASH",
      f.main,
    );
    assert.equal(returned, alice);
    assert.equal(
      f.store.profiles.find((profile) => profile.id === alice)!.name,
      "Cash Alice",
    );
    assert.equal(f.store.profiles.length, 2);
    await f.post("Buy-in", 200, alice);
    const zero = await f.post("Cash-out", 0, alice);
    assert.deepEqual(
      {
        amount: zero.amount,
        received: zero.cashReceived,
        paid: zero.cashPayout,
      },
      { amount: 0, received: 0, paid: 0 },
    );
    await f.post("Cash-out", 500, bob, f.reserve);
    const pending = await f.request("Rake", 50, undefined, f.main, "dealer");
    await f.denied(
      { kind: "CLOSE_DAY", countedCash: sen(10_250), reason: "" },
      /pending approvals/,
      "manager",
    );
    await f.denied(
      { kind: "DECIDE", approvalId: pending, decision: "REJECTED", reason: "" },
      /reason/,
      "manager",
    );
    await f.act(
      {
        kind: "DECIDE",
        approvalId: pending,
        decision: "REJECTED",
        reason: "Discarded demonstration request",
      },
      "manager",
    );
    assert.equal(totalsForDay(f.store).expectedCash, sen(10_250));
    await f.denied(
      { kind: "CLOSE_DAY", countedCash: sen(10_249), reason: "" },
      /variance/,
      "manager",
    );
    await f.act(
      {
        kind: "CLOSE_DAY",
        countedCash: sen(10_249),
        reason: "Counted RM1 short during the local test",
      },
      "manager",
    );
    assert.equal(totalsForDay(f.store).variance, -sen(1));
    await f.denied(
      {
        kind: "REQUEST",
        type: "Rake",
        amount: sen(50),
        tableId: f.main,
        note: "Closed day must reject new entries",
      },
      /closed/,
      "dealer",
    );
    await f.denied(
      { kind: "REOPEN_DAY", reason: "Review closing count" },
      /permission/,
      "manager",
    );
    await f.act({ kind: "REOPEN_DAY", reason: "Review closing count" });
    assert.equal(totalsForDay(f.store).countedCash, null);
    await f.act(
      { kind: "CLOSE_DAY", countedCash: sen(10_250), reason: "" },
      "manager",
    );
    assert.equal(currentDay(f.store)!.closes.length, 2);
    assert.equal(currentDay(f.store)!.closes[0].variance, -sen(1));
    assert.equal(totalsForDay(f.store).variance, 0);
    const firstDay = f.store.currentDayId;
    await f.act(
      { kind: "OPEN_DAY", date: "2026-10-22", openingCash: sen(10_250) },
      "manager",
    );
    await f.checkIn("Cash Alice", "+12025550201", "CASH");
    await f.post("Cash-out", 0, alice);
    await f.act(
      { kind: "CLOSE_DAY", countedCash: sen(10_250), reason: "" },
      "manager",
    );
    assert.equal(f.store.days.length, 2);
    assert.equal(totalsForDay(f.store, firstDay).expectedCash, sen(10_250));
    assert.equal(
      totalsForDay(f.store).cashReceived,
      0,
      "next day must not count yesterday's receipts again",
    );

    const backup = parseBackup(
      JSON.parse(JSON.stringify(await createBackup(f.db))),
    );
    assert.equal(JSON.stringify(backup).includes(f.tokens.admin), false);
    const target = await testDatabase();
    try {
      let safetyCaptured = false;
      await restoreBackup(target.db, backup, async (before) => {
        safetyCaptured = true;
        assert.equal(before.payload.states[0].data.transactions.length, 0);
      });
      assert.equal(safetyCaptured, true);
      assert.equal(await sessionUser(target.db, f.tokens.admin), null);
      const restoredAdmin = await login(target.db, "rules.admin", password);
      assert.deepEqual(
        (await readSnapshot(target.db, restoredAdmin)).store,
        f.store,
      );
      const restoredCashier = await login(target.db, "rules.cashier", password);
      const retried = await mutate(target.db, restoredCashier, buyInPayload);
      assert.equal(retried.revision, f.snapshot.revision);
      assert.equal(
        retried.store.approvals.filter((approval) => approval.id === buyIn)
          .length,
        1,
      );
      assert.equal(
        retried.store.transactions.filter((tx) => tx.approvalId === buyIn)
          .length,
        1,
      );
    } finally {
      await target.engine.close();
    }
  } finally {
    await f.engine.close();
  }
});

test("credit players settle debt, preserve carryover, repay and return without duplicating profiles", async () => {
  const f = await venue();
  try {
    await f.denied(
      {
        kind: "CHECK_IN",
        name: "Unauthorized credit",
        phone: "+12025550210",
        type: "CREDIT",
        creditLimit: sen(5_000),
        tags: [],
        tableId: f.main,
        seat: 1,
      },
      /permission/,
      "cashier",
    );
    const carla = await f.checkIn("Credit Carla", "+12025550211", "CREDIT");
    await f.post("Buy-in", 500, carla);
    assert.equal(debt(f.store, carla), sen(500));
    assert.equal(totalsForDay(f.store).cashReceived, 0);
    const reserved = await f.request("Buy-in", 4_500, carla);
    await f.denied(
      {
        kind: "REQUEST",
        type: "Buy-in",
        amount: sen(200),
        playerId: carla,
        note: "Reserved credit consumes the available limit",
      },
      /Credit limit/,
      "cashier",
    );
    await f.act(
      {
        kind: "DECIDE",
        approvalId: reserved,
        decision: "REJECTED",
        reason: "Keep the smaller sample balance",
      },
      "manager",
    );
    await f.denied(
      {
        kind: "UPDATE_PROFILE",
        playerId: carla,
        name: "Credit Carla",
        tags: ["VIP"],
        creditLimit: sen(400),
        reason: "Cannot reduce below outstanding debt",
      },
      /outstanding/,
      "manager",
    );
    const payout = await f.post("Cash-out", 700, carla);
    assert.deepEqual(
      { settled: payout.creditDelta, paid: payout.cashPayout },
      { settled: -sen(500), paid: sen(200) },
    );
    assert.equal(debt(f.store, carla), 0);
    const returned = await f.checkIn(
      "Credit Carla",
      "+12025550211",
      "CREDIT",
      f.main,
      1,
      "cashier",
    );
    assert.equal(returned, carla);
    await f.post("Buy-in", 1_000, carla);
    const partial = await f.post("Cash-out", 300, carla);
    assert.equal(partial.cashPayout, 0);
    assert.equal(debt(f.store, carla), sen(700));
    const dylan = await f.checkIn(
      "Credit Dylan",
      "+12025550212",
      "CREDIT",
      f.main,
      2,
    );
    await f.post("Buy-in", 200, dylan);
    await f.post("Cash-out", 0, dylan);
    assert.equal(debt(f.store, dylan), sen(200));
    await f.post("Credit Repayment", 200, carla);
    await f.denied(
      {
        kind: "REQUEST",
        type: "Credit Repayment",
        amount: sen(600),
        playerId: carla,
        note: "Overpayment must be rejected",
      },
      /cannot exceed/,
      "cashier",
    );
    await f.post("Credit Repayment", 500, carla);
    assert.equal(debt(f.store, carla), 0);
    assert.equal(totalsForDay(f.store).expectedCash, sen(10_500));
    await f.act(
      { kind: "CLOSE_DAY", countedCash: sen(10_500), reason: "" },
      "manager",
    );
    await f.act(
      { kind: "OPEN_DAY", date: "2026-10-22", openingCash: sen(10_500) },
      "manager",
    );
    assert.equal(
      await f.checkIn(
        "Credit Dylan",
        "+12025550212",
        "CREDIT",
        f.main,
        2,
        "cashier",
      ),
      dylan,
    );
    assert.equal(debt(f.store, dylan), sen(200));
    await f.post("Credit Repayment", 200, dylan);
    await f.post("Cash-out", 0, dylan);
    assert.equal(debt(f.store, dylan), 0);
    assert.equal(f.store.profiles.length, 2);
    await f.act(
      { kind: "CLOSE_DAY", countedCash: sen(10_700), reason: "" },
      "manager",
    );
    assert.equal(totalsForDay(f.store).variance, 0);
  } finally {
    await f.engine.close();
  }
});

test("all table entries obey independent, admin and dual review and preserve original reversed receipts", async () => {
  const f = await venue();
  try {
    await f.denied(
      {
        kind: "REQUEST",
        type: "Cash Received",
        amount: sen(100),
        note: "Dealer cannot perform cashier actions",
      },
      /permission/,
      "dealer",
    );
    const entries: [EntryType, number, number, number][] = [
      ["Rake", 50, 50, 0],
      ["Tips", 25, 25, 0],
      ["Insurance Premium", 180, 180, 0],
      ["Insurance Payout", 100, 0, 100],
      ["Jackpot Contribution", 40, 40, 0],
      ["Jackpot Payout", 30, 0, 30],
      ["Cash Received", 1_000, 1_000, 0],
      ["Cash Payout", 200, 0, 200],
    ];
    for (const [type, amount, received, paid] of entries) {
      const request = await f.request(
        type,
        amount,
        undefined,
        f.main,
        type.startsWith("Cash ") ? "cashier" : "dealer",
      );
      const approval = f.store.approvals[0];
      if (paid)
        await f.denied(
          { kind: "DECIDE", approvalId: request, decision: "APPROVED" },
          /Independent/,
          "manager",
        );
      await f.approve(
        request,
        approval.approvalLevel === "ADMIN" ? "admin" : "manager",
      );
      const tx = f.store.transactions.find(
        (entry) => entry.approvalId === request,
      )!;
      assert.equal(tx.cashReceived, sen(received), `${type} cash received`);
      assert.equal(tx.cashPayout, sen(paid), `${type} cash paid`);
      assert.equal(tx.creditDelta, 0);
    }
    const own = await f.request(
      "Cash Received",
      150,
      undefined,
      f.main,
      "manager",
    );
    await f.denied(
      { kind: "DECIDE", approvalId: own, decision: "APPROVED" },
      /Independent/,
      "manager",
    );
    await f.approve(own, "manager2");
    const dual = await f.request("Cash Received", 25_000);
    assert.equal(f.store.approvals[0].approvalLevel, "DUAL");
    const posted = f.store.transactions.length;
    await f.approve(dual, "manager");
    assert.equal(f.store.transactions.length, posted);
    await f.denied(
      { kind: "DECIDE", approvalId: dual, decision: "APPROVED" },
      /Independent/,
      "manager",
    );
    await f.approve(dual, "manager2");
    assert.equal(
      f.store.transactions.length,
      posted,
      "two managers cannot replace the administrator",
    );
    await f.approve(dual, "admin");
    assert.equal(f.store.transactions.length, posted + 1);
    assert.equal(
      f.store.approvals.find((request) => request.id === dual)!.votes.length,
      3,
    );
    await f.denied(
      { kind: "DECIDE", approvalId: dual, decision: "APPROVED" },
      /Independent/,
      "admin",
    );
    const rejected = await f.request("Cash Received", 100);
    await f.act(
      {
        kind: "DECIDE",
        approvalId: rejected,
        decision: "REJECTED",
        reason: "Do not post this sample request",
      },
      "manager",
    );
    assert.equal(
      f.store.transactions.some((tx) => tx.approvalId === rejected),
      false,
    );
    const premium = structuredClone(
      f.store.transactions.find((tx) => tx.type === "Insurance Premium")!,
    );
    await f.act(
      {
        kind: "CORRECT",
        transactionId: premium.id,
        reason: "Reverse the sample premium without editing its receipt",
      },
      "cashier",
    );
    const correction = f.store.approvals[0].id;
    await f.denied(
      { kind: "DECIDE", approvalId: correction, decision: "APPROVED" },
      /Independent/,
      "manager",
    );
    await f.approve(correction, "admin");
    assert.deepEqual(
      f.store.transactions.find((tx) => tx.id === premium.id),
      premium,
    );
    const reversal = f.store.transactions.find(
      (tx) => tx.reversesId === premium.id,
    )!;
    assert.equal(reversal.amount, -sen(180));
    assert.equal(reversal.cashReceived, -sen(180));
    await f.denied(
      {
        kind: "CORRECT",
        transactionId: premium.id,
        reason: "No duplicate reversals",
      },
      /already exists/,
      "cashier",
    );
    assert.equal(totalsForDay(f.store).expectedCash, sen(35_935));
    assert.equal(totalsForDay(f.store).rake, sen(50));
    assert.equal(totalsForDay(f.store).tips, sen(25));
    assert.equal(totalsForDay(f.store).insurance, -sen(100));
    assert.equal(totalsForDay(f.store).jackpot, sen(10));
    await f.act(
      { kind: "CLOSE_DAY", countedCash: sen(35_935), reason: "" },
      "manager",
    );
    assert.equal(totalsForDay(f.store).variance, 0);
    assert.equal(
      f.store.approvals.filter((request) => request.status === "PENDING")
        .length,
      0,
    );
  } finally {
    await f.engine.close();
  }
});
