import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import type { Command } from "../src/domain/commands";
import type { Role } from "../src/domain/model";
import {
  commandDependencies,
  changedDependencyKeys,
} from "../src/domain/command-concurrency";
import { DomainError } from "../src/domain/operations";
import { currentDay, debt } from "../src/domain/selectors";
import { hashPassword, login } from "../src/server/auth";
import { loadCommandStore } from "../src/server/command-store";
import { mutate, readSnapshot } from "../src/server/repository";
import { importStore, type StorageMetadata } from "../src/server/storage";
import { testDatabase } from "./helpers/database";
import { configuredStore } from "./helpers/store";

async function fixture() {
  const run = await testDatabase();
  const password = "scoped-concurrency-test-password";
  const passwordHash = await hashPassword(password);
  for (const role of ["ADMIN", "MANAGER", "CASHIER"] as Role[]) {
    const id = role.toLowerCase();
    await run.db.query(
      "INSERT INTO poker_users(id,username,password_hash) VALUES($1,$1,$2)",
      [id, passwordHash],
    );
    await run.db.query(
      "INSERT INTO poker_memberships(user_id,branch_id,role) VALUES($1,'local',$2)",
      [id, role],
    );
  }
  await importStore(run.db, "local", configuredStore());
  const tokens = {
    admin: await login(run.db, "admin", password),
    manager: await login(run.db, "manager", password),
    cashier: await login(run.db, "cashier", password),
  };
  const read = (actor: keyof typeof tokens = "admin") =>
    readSnapshot(run.db, tokens[actor]);
  async function act(
    command: Command,
    actor: keyof typeof tokens = "admin",
    revision?: number,
  ) {
    const before = await read(actor);
    return mutate(run.db, tokens[actor], {
      branchId: "local",
      operationId: randomUUID(),
      revision: revision ?? before.revision,
      command,
    });
  }
  const table = await act({
    kind: "TABLE",
    name: "Main",
    dealer: "",
    status: "OPEN",
  });
  const tableId = table.store.tables[0].id;
  await act({ kind: "OPEN_DAY", date: "2026-10-28", openingCash: 0 });
  const checkIn = (name: string, seat: number, credit = false) =>
    act({
      kind: "CHECK_IN",
      name,
      phone: `+120255501${String(seat).padStart(2, "0")}`,
      type: credit ? "CREDIT" : "CASH",
      creditLimit: credit ? 100_000 : 0,
      tags: [],
      tableId,
      seat,
    });
  return { ...run, tokens, read, act, checkIn, tableId };
}
function conflict(error: unknown) {
  assert.ok(error instanceof DomainError);
  assert.equal(error.status, 409);
  return true;
}

test("different empty seats accept one reviewed revision while the same seat rejects a competing check-in", async (t) => {
  const run = await fixture();
  t.after(() => run.engine.close());
  const before = await run.read();
  const command = (name: string, phone: string, seat: number): Command => ({
    kind: "CHECK_IN",
    name,
    phone,
    type: "CASH",
    creditLimit: 0,
    tags: [],
    tableId: run.tableId,
    seat,
  });
  const first = await run.act(
    command("First", "+12025550201", 1),
    "cashier",
    before.revision,
  );
  const second = await run.act(
    command("Second", "+12025550202", 2),
    "cashier",
    before.revision,
  );
  assert.equal(second.revision, first.revision + 1);
  assert.equal(
    second.store.sessions.filter((value) => value.status === "ACTIVE").length,
    2,
  );
  await assert.rejects(
    run.act(
      command("Competing", "+12025550203", 1),
      "cashier",
      before.revision,
    ),
    conflict,
  );
  assert.equal((await run.read()).store.profiles.length, 2);
});

test("unrelated player requests save together but a changed debt invalidates the reviewed cash-out", async (t) => {
  const run = await fixture();
  t.after(() => run.engine.close());
  await run.checkIn("Credit", 1, true);
  const checked = await run.checkIn("Cash", 2);
  const [credit, cash] = checked.store.profiles;
  const base = checked.revision;
  const request = (
    playerId: string,
    type: "Buy-in" | "Cash-out" | "Credit Repayment",
    amount: number,
  ): Command => ({
    kind: "REQUEST",
    playerId,
    type,
    amount,
    note: "Scoped financial test",
  });
  const creditPending = await run.act(
    request(credit.id, "Buy-in", 50_000),
    "cashier",
    base,
  );
  const cashPending = await run.act(
    request(cash.id, "Buy-in", 50_000),
    "cashier",
    base,
  );
  assert.equal(cashPending.store.approvals.length, 2);
  await run.act(
    {
      kind: "DECIDE",
      approvalId: creditPending.store.approvals[0].id,
      decision: "APPROVED",
    },
    "manager",
  );
  const cashOut = await run.act(
    request(credit.id, "Cash-out", 80_000),
    "cashier",
  );
  const cashOutId = cashOut.store.approvals[0].id;
  const repayment = await run.act(
    request(credit.id, "Credit Repayment", 20_000),
    "cashier",
  );
  await run.act(
    {
      kind: "DECIDE",
      approvalId: repayment.store.approvals[0].id,
      decision: "APPROVED",
    },
    "manager",
  );
  const before = await run.read();
  assert.equal(debt(before.store, credit.id), 30_000);
  await assert.rejects(
    run.act(
      { kind: "DECIDE", approvalId: cashOutId, decision: "APPROVED" },
      "admin",
      cashOut.revision,
    ),
    conflict,
  );
  assert.deepEqual(await run.read(), before);
  const saved = await run.act(
    { kind: "DECIDE", approvalId: cashOutId, decision: "APPROVED" },
    "admin",
  );
  const payout = saved.store.transactions.find(
    (value) => value.approvalId === cashOutId,
  )!;
  assert.equal(payout.cashPayout, 50_000);
  assert.equal(payout.creditDelta, -30_000);
  assert.equal(debt(saved.store, credit.id), 0);
});

test("scoped commands enforce all credit reservations without loading pending-request history", async (t) => {
  const run = await fixture();
  t.after(() => run.engine.close());
  const checked = await run.checkIn("Reserved credit", 1, true);
  const player = checked.store.profiles[0];
  for (let index = 0; index < 3; index++)
    await run.act(
      {
        kind: "REQUEST",
        type: "Buy-in",
        amount: 20_000,
        playerId: player.id,
        note: "Reserved credit",
      },
      "cashier",
    );
  const metadata = (
    await run.db.query<{ data: StorageMetadata }>(
      "SELECT data FROM poker_branch_state WHERE branch_id='local'",
    )
  ).rows[0].data;
  const command: Command = {
    kind: "REQUEST",
    type: "Buy-in",
    amount: 50_000,
    playerId: player.id,
    note: "Would exceed limit",
  };
  const scope = await loadCommandStore(run.db, "local", metadata, command);
  assert.equal(scope.approvals.length, 0);
  assert.equal(scope.transactions.length, 0);
  assert.equal(scope.readModel?.reservedCredit[player.id], 60_000);
  await assert.rejects(
    run.act(command, "cashier"),
    /Credit limit would be exceeded/,
  );
  await assert.rejects(
    run.act({
      kind: "UPDATE_PROFILE",
      playerId: player.id,
      name: player.name,
      tags: [],
      creditLimit: 50_000,
      reason: "Too small for reservations",
    }),
    /reserved credit/,
  );
  assert.equal((await run.read()).store.approvals.length, 3);
});

test("closing detects new financial activity but permits unrelated table edits", async (t) => {
  const run = await fixture();
  t.after(() => run.engine.close());
  const reviewed = await run.read();
  await run.act({
    kind: "TABLE",
    name: "Independent",
    dealer: "",
    status: "OPEN",
  });
  const closed = await run.act(
    {
      kind: "CLOSE_DAY",
      dayId: currentDay(reviewed.store)!.id,
      countedCash: 0,
      reason: "",
    },
    "manager",
    reviewed.revision,
  );
  assert.equal(currentDay(closed.store)?.status, "CLOSED");
  await run.act({ kind: "REOPEN_DAY", reason: "Recount for test" });
  const fresh = await run.read();
  await run.act(
    {
      kind: "REQUEST",
      type: "Rake",
      tableId: run.tableId,
      amount: 5000,
      note: "New financial request",
    },
    "cashier",
  );
  await assert.rejects(
    run.act(
      { kind: "CLOSE_DAY", countedCash: 0, reason: "" },
      "manager",
      fresh.revision,
    ),
    conflict,
  );
  assert.equal(currentDay((await run.read()).store)?.status, "OPEN");
});

test("a later unrelated repayment request cannot hide an active-session move blocker", async (t) => {
  const run = await fixture();
  t.after(() => run.engine.close());
  const checked = await run.checkIn("Move blocked credit", 1, true);
  const player = checked.store.profiles[0];
  const first = await run.act(
    {
      kind: "REQUEST",
      type: "Buy-in",
      playerId: player.id,
      amount: 50_000,
      note: "Initial credit",
    },
    "cashier",
  );
  await run.act(
    {
      kind: "DECIDE",
      approvalId: first.store.approvals[0].id,
      decision: "APPROVED",
    },
    "manager",
  );
  await run.act(
    {
      kind: "REQUEST",
      type: "Buy-in",
      playerId: player.id,
      amount: 20_000,
      note: "Pending session buy-in",
    },
    "cashier",
  );
  await run.act(
    {
      kind: "REQUEST",
      type: "Credit Repayment",
      playerId: player.id,
      amount: 10_000,
      note: "Newer unrelated repayment",
    },
    "cashier",
  );
  await assert.rejects(
    run.act(
      { kind: "MOVE", playerId: player.id, tableId: run.tableId, seat: 2 },
      "cashier",
    ),
    /pending transactions/,
  );
  assert.equal(
    (await run.read()).store.sessions.find(
      (value) => value.playerId === player.id,
    )?.seat,
    1,
  );
});

test("dependency keys isolate table configuration from seating and retain reversal dependencies", async (t) => {
  const run = await fixture();
  t.after(() => run.engine.close());
  const before = await run.read();
  const after = await run.checkIn("Seat occupant", 1);
  const changed = changedDependencyKeys(before.store, after.store);
  assert.ok(changed.includes(`seat:${run.tableId}:1`));
  assert.ok(changed.includes("venue:activity"));
  assert.equal(changed.includes(`table:${run.tableId}`), false);
  const keys = commandDependencies(after.store, {
    kind: "TABLE",
    tableId: run.tableId,
    name: "Name only",
    dealer: "",
    status: "OPEN",
  });
  assert.equal(
    keys.some((key) => changed.includes(key)),
    false,
  );
  assert.ok(
    commandDependencies(after.store, {
      kind: "CORRECT",
      transactionId: "original",
      reason: "Correction reason",
    }).includes("reversal:original"),
  );
});

test("a compact idempotent retry retains its request after the recent-page window moves", async (t) => {
  const run = await fixture();
  t.after(() => run.engine.close());
  const before = await run.read();
  const original = {
    branchId: "local",
    revision: before.revision,
    operationId: randomUUID(),
    command: {
      kind: "REQUEST",
      type: "Rake",
      amount: 1000,
      tableId: run.tableId,
      note: "Original retained receipt",
    },
  };
  const saved = await mutate(run.db, run.tokens.cashier, original, {
    compact: true,
  });
  const requestId = saved.store.approvals.find(
    (value) => value.note === "Original retained receipt",
  )!.id;
  for (let index = 0; index < 25; index++)
    await run.act(
      {
        kind: "REQUEST",
        type: "Rake",
        amount: 1000,
        tableId: run.tableId,
        note: `Later request ${index}`,
      },
      "cashier",
    );
  const replay = await mutate(run.db, run.tokens.cashier, original, {
    compact: true,
  });
  assert.ok(replay.store.approvals.some((value) => value.id === requestId));
  const full = await run.read();
  assert.equal(
    full.store.approvals.filter(
      (value) => value.note === "Original retained receipt",
    ).length,
    1,
  );
  assert.equal(full.store.approvals.length, 26);
  assert.equal(
    (
      await run.db.query(
        "SELECT operation_id FROM poker_operations WHERE operation_id=$1",
        [original.operationId],
      )
    ).rows.length,
    1,
  );
});

test("cash-out reversal cannot reopen an earlier visit after a later visit exists", async (t) => {
  const run = await fixture();
  t.after(() => run.engine.close());
  const checked = await run.checkIn("Returning cash", 1);
  const player = checked.store.profiles[0];
  const cashOut = await run.act(
    {
      kind: "REQUEST",
      type: "Cash-out",
      amount: 0,
      playerId: player.id,
      note: "Zero sample checkout",
    },
    "cashier",
  );
  const posted = await run.act(
    {
      kind: "DECIDE",
      approvalId: cashOut.store.approvals[0].id,
      decision: "APPROVED",
    },
    "admin",
  );
  const original = posted.store.transactions[0];
  await run.act(
    {
      kind: "CHECK_IN",
      playerId: player.id,
      name: player.name,
      phone: player.phone,
      type: player.type,
      creditLimit: 0,
      tags: [],
      tableId: run.tableId,
      seat: 2,
    },
    "cashier",
  );
  await assert.rejects(
    run.act(
      {
        kind: "CORRECT",
        transactionId: original.id,
        reason: "Try reopening earlier visit",
      },
      "cashier",
    ),
    /later session/,
  );
  const final = await run.read();
  assert.equal(
    final.store.approvals.filter((value) => value.type === "Reversal").length,
    0,
  );
  assert.equal(
    final.store.sessions.filter((value) => value.status === "ACTIVE").length,
    1,
  );
  assert.equal(
    final.store.sessions.find((value) => value.status === "ACTIVE")?.seat,
    2,
  );
});
