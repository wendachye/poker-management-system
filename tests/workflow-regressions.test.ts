import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { applyCommand, DomainError } from "../src/domain/operations";
import type { Command } from "../src/domain/commands";
import type { Staff, Store } from "../src/domain/model";
import { currentDay, debt, totalsForDay } from "../src/domain/selectors";
import { ledgerImpact } from "../src/domain/ledger-impact";
import { readSnapshot, mutate } from "../src/server/repository";
import { configuredStore } from "./helpers/store";
import { testDatabase } from "./helpers/database";

const admin: Staff = {
  id: "reviewer",
  username: "reviewer",
  role: "ADMIN",
  branchId: "local",
};
const cashier: Staff = {
  ...admin,
  id: "cashier",
  username: "cashier",
  role: "CASHIER",
};

function act(store: Store, command: Command, actor = admin) {
  return applyCommand(store, command, actor);
}

function fixture(credit = false) {
  let store = act(configuredStore(), {
    kind: "OPEN_DAY",
    date: "2026-10-21",
    openingCash: 1_000_000,
  });
  for (const rules of [
    {
      name: "5/10",
      smallBlind: 500,
      bigBlind: 1_000,
      minBuyIn: 20_000,
      maxBuyIn: 500_000,
    },
    {
      name: "10/25",
      smallBlind: 1_000,
      bigBlind: 2_500,
      minBuyIn: 50_000,
      maxBuyIn: 1_000_000,
    },
  ])
    store = act(store, {
      kind: "TABLE",
      ...rules,
      buyInStep: 5_000,
      dealer: "Dealer",
      status: "OPEN",
    });
  store = act(
    store,
    {
      kind: "CHECK_IN",
      name: "Workflow Player",
      phone: "+12025550190",
      type: credit ? "CREDIT" : "CASH",
      creditLimit: credit ? 500_000 : 0,
      tags: [],
      tableId: store.tables[0].id,
      seat: 1,
    },
    credit ? admin : cashier,
  );
  return store;
}

function request(store: Store, type: "Buy-in" | "Cash-out", amount: number) {
  return act(
    store,
    {
      kind: "REQUEST",
      type,
      amount,
      playerId: store.profiles[0].id,
      note: "Workflow regression",
    },
    cashier,
  );
}

function approve(store: Store, actor = admin) {
  return act(
    store,
    {
      kind: "DECIDE",
      approvalId: store.approvals[0].id,
      decision: "APPROVED",
    },
    actor,
  );
}

test("the 10/25 maximum buy-in crosses the admin review threshold after moving from 5/10", () => {
  let store = fixture();
  store = approve(request(store, "Buy-in", 20_000));
  store = act(
    store,
    {
      kind: "MOVE",
      playerId: store.profiles[0].id,
      tableId: store.tables[1].id,
      seat: 1,
    },
    cashier,
  );
  assert.throws(() => request(store, "Buy-in", 20_000), /minimum/);
  assert.throws(() => request(store, "Buy-in", 52_500), /increment/);
  assert.throws(() => request(store, "Buy-in", 1_005_000), /maximum/);
  store = request(store, "Buy-in", 1_000_000);
  assert.equal(store.approvals[0].approvalLevel, "ADMIN");
  const before = structuredClone(store);
  assert.throws(
    () => approve(store, { ...admin, id: "manager", role: "MANAGER" }),
    /Independent/,
  );
  assert.deepEqual(store, before);
  store = approve(store);
  assert.equal(store.transactions[0].tableId, store.tables[1].id);
  assert.equal(totalsForDay(store).cashReceived, 1_020_000);
});

test("a credit cash-out preview matches settlement and a reconciled close after moving tables", () => {
  let store = approve(request(fixture(true), "Buy-in", 250_000));
  store = act(
    store,
    {
      kind: "MOVE",
      playerId: store.profiles[0].id,
      tableId: store.tables[1].id,
      seat: 1,
    },
    cashier,
  );
  store = request(store, "Cash-out", 300_000);
  const preview = ledgerImpact(store, store.approvals[0]);
  assert.equal(preview.creditDelta, -250_000);
  assert.equal(preview.cashPayout, 50_000);
  assert.throws(() => request(store, "Buy-in", 50_000), /pending cash-out/);
  store = approve(store);
  const posted = store.transactions[0];
  for (const key of [
    "amount",
    "cashReceived",
    "cashPayout",
    "creditDelta",
  ] as const)
    assert.equal(posted[key], preview[key]);
  assert.equal(debt(store, store.profiles[0].id), 0);
  store = act(store, {
    kind: "CLOSE_DAY",
    dayId: currentDay(store)!.id,
    countedCash: 950_000,
    reason: "",
  });
  assert.equal(currentDay(store)!.status, "CLOSED");
  assert.equal(totalsForDay(store).variance, 0);
});

test("parallel credit reservations and cash-out decisions preserve limits and post payouts once", async () => {
  const { db, engine } = await testDatabase();
  const tokens: Record<string, string> = {};
  try {
    for (const actor of [
      cashier,
      admin,
      { ...admin, id: "reviewer2", username: "reviewer2" },
    ]) {
      const token = randomBytes(32).toString("hex");
      tokens[actor.id] = token;
      await db.query(
        "INSERT INTO poker_users(id,username,password_hash) VALUES($1,$2,'test-no-login')",
        [actor.id, actor.username],
      );
      await db.query(
        "INSERT INTO poker_memberships(user_id,branch_id,role) VALUES($1,'local',$2)",
        [actor.id, actor.role],
      );
      await db.query(
        "INSERT INTO poker_sessions(token_hash,user_id,branch_id,expires_at) VALUES($1,$2,'local',now()+interval '1 hour')",
        [createHash("sha256").update(token).digest("hex"), actor.id],
      );
    }
    await db.query(
      "UPDATE poker_branch_state SET data=$1 WHERE branch_id='local'",
      [JSON.stringify(fixture(true))],
    );
    const snapshot = () => readSnapshot(db, tokens.cashier);
    const first = await snapshot();
    const payload = (command: Command, revision: number) => ({
      branchId: "local",
      revision,
      operationId: crypto.randomUUID(),
      command,
    });
    const buyIn: Command = {
      kind: "REQUEST",
      type: "Buy-in",
      amount: 300_000,
      playerId: first.store.profiles[0].id,
      note: "Concurrent credit reservation",
    };
    const reservations = await Promise.allSettled([
      mutate(db, tokens.cashier, payload(buyIn, first.revision)),
      mutate(db, tokens.cashier, payload(buyIn, first.revision)),
    ]);
    assert.equal(
      reservations.filter((value) => value.status === "fulfilled").length,
      1,
    );
    const conflict = reservations.find((value) => value.status === "rejected");
    assert.ok(
      conflict?.status === "rejected" &&
        conflict.reason instanceof DomainError &&
        conflict.reason.status === 409,
    );
    let latest = await snapshot();
    await assert.rejects(
      mutate(db, tokens.cashier, payload(buyIn, latest.revision)),
      /Credit limit/,
    );
    latest = await mutate(
      db,
      tokens.reviewer,
      payload(
        {
          kind: "DECIDE",
          approvalId: latest.store.approvals[0].id,
          decision: "APPROVED",
        },
        latest.revision,
      ),
    );
    latest = await mutate(
      db,
      tokens.cashier,
      payload(
        {
          kind: "REQUEST",
          type: "Cash-out",
          amount: 350_000,
          playerId: first.store.profiles[0].id,
          note: "Concurrent cash-out review",
        },
        latest.revision,
      ),
    );
    const decision: Command = {
      kind: "DECIDE",
      approvalId: latest.store.approvals[0].id,
      decision: "APPROVED",
    };
    const attempts = [
      payload(decision, latest.revision),
      payload(decision, latest.revision),
    ];
    const reviewers = ["reviewer", "reviewer2"];
    const decisions = await Promise.allSettled(
      attempts.map((input, index) =>
        mutate(db, tokens[reviewers[index]], input),
      ),
    );
    assert.equal(
      decisions.filter((value) => value.status === "fulfilled").length,
      1,
    );
    const winningIndex = decisions.findIndex(
      (value) => value.status === "fulfilled",
    );
    const retry = await mutate(
      db,
      tokens[reviewers[winningIndex]],
      attempts[winningIndex],
    );
    assert.equal(
      retry.store.transactions.filter((tx) => tx.type === "Cash-out").length,
      1,
    );
    assert.equal(retry.store.sessions[0].status, "OUT");
    assert.equal(debt(retry.store, first.store.profiles[0].id), 0);
    assert.equal(totalsForDay(retry.store).cashPayout, 50_000);
    assert.equal(retry.store.approvals[0].votes.length, 1);
    await assert.rejects(
      mutate(
        db,
        tokens[reviewers[1 - winningIndex]],
        payload(decision, retry.revision),
      ),
      /Independent/,
    );
    assert.deepEqual(await snapshot(), {
      ...retry,
      user: cashier,
      branch: { ...retry.branch, role: "CASHIER" },
    });
  } finally {
    await engine.close();
  }
});
