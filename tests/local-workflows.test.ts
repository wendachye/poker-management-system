import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "./helpers/database";
import { defaultSettings } from "../src/domain/settings";
import { currentDay, debt, totalsForDay } from "../src/domain/selectors";
import type { Command } from "../src/domain/commands";
import type { EntryType, Role, Snapshot } from "../src/domain/model";
import {
  hashPassword,
  login,
  changeBranch,
  sessionUser,
} from "../src/server/auth";
import { manageStaff, listStaff } from "../src/server/staff";
import { mutate, readSnapshot } from "../src/server/repository";
import { createBackup, parseBackup, restoreBackup } from "../src/server/backup";

test("an isolated venue completes setup and a complete audited business day, with a separate location and restore", async (t) => {
  const { db, engine } = await testDatabase();
  const password = "workflow-test-password";
  const tokens: Record<string, string> = {};
  let cashPlayer = "",
    creditPlayer = "",
    mainTable = "",
    loungeTable = "";
  let savedBuyIn: Parameters<typeof mutate>[2];
  let savedSnapshot: Snapshot;
  const editable = () => {
    const { setupCompleted: _, ...settings } = defaultSettings();
    void _;
    return {
      ...settings,
      venueName: "Workflow Test Venue",
      minBuyIn: 10_000,
      maxBuyIn: 5_000_000,
      buyInStep: 1_000,
      tipsPolicy: "Record dealer tips as a separate approved entry.",
      houseRules: "Independent approval is required before cash changes hands.",
    };
  };
  async function snapshot(actor = "admin") {
    return readSnapshot(db, tokens[actor]);
  }
  async function execute(command: Command, actor = "admin") {
    const before = await snapshot(actor);
    return mutate(db, tokens[actor], {
      branchId: before.branch.id,
      revision: before.revision,
      operationId: crypto.randomUUID(),
      command,
    });
  }
  async function createStaff(username: string, role: Role) {
    const before = await snapshot();
    await manageStaff(db, tokens.admin, {
      branchId: before.branch.id,
      revision: before.revision,
      operationId: crypto.randomUUID(),
      command: {
        kind: "STAFF_CREATE",
        username,
        role,
        password,
        reason: "Initial venue staffing",
      },
    });
    tokens[username] = await login(db, username, password);
  }
  async function request(
    type: EntryType,
    amount: number,
    playerId?: string,
    actor = "cashier",
  ) {
    const next = await execute(
      {
        kind: "REQUEST",
        type,
        amount,
        playerId,
        tableId: [
          "Rake",
          "Tips",
          "Insurance Premium",
          "Insurance Payout",
          "Jackpot Contribution",
          "Jackpot Payout",
        ].includes(type)
          ? mainTable
          : undefined,
        note: `Workflow ${type}`,
      },
      actor,
    );
    return next.store.approvals[0].id;
  }
  async function approve(approvalId: string, actor = "manager") {
    return execute({ kind: "DECIDE", approvalId, decision: "APPROVED" }, actor);
  }

  try {
    await db.query(
      "INSERT INTO poker_users(id,username,password_hash) VALUES('owner','admin',$1)",
      [await hashPassword(password)],
    );
    for (const branch of ["local", "other"])
      await db.query(
        "INSERT INTO poker_memberships(user_id,branch_id,role) VALUES('owner',$1,'ADMIN')",
        [branch],
      );
    tokens.admin = await login(db, "admin", password);

    await t.test(
      "onboarding requires saved rules, tables, and independent active staff before opening",
      async () => {
        await assert.rejects(
          execute({
            kind: "OPEN_DAY",
            date: "2026-10-21",
            openingCash: 10_000_000,
          }),
          /setup/i,
        );
        await assert.rejects(execute({ kind: "COMPLETE_SETUP" }));
        await execute({
          kind: "UPDATE_SETTINGS",
          settings: editable(),
          reason: "Configure the venue before opening",
        });
        await assert.rejects(execute({ kind: "COMPLETE_SETUP" }));
        await execute({
          kind: "TABLE",
          name: "Main floor",
          dealer: "dealer",
          status: "OPEN",
        });
        mainTable = (await snapshot()).store.tables[0].id;
        await assert.rejects(execute({ kind: "COMPLETE_SETUP" }));
        await createStaff("cashier", "CASHIER");
        await assert.rejects(
          execute({ kind: "COMPLETE_SETUP" }, "cashier"),
          /permission|admin/i,
        );
        const complete = await execute({ kind: "COMPLETE_SETUP" });
        assert.equal(complete.store.settings?.setupCompleted, true);
        assert.equal(complete.branch.name, "Workflow Test Venue");
        await createStaff("manager", "MANAGER");
        await createStaff("dealer", "DEALER");
        assert.equal((await listStaff(db, tokens.admin)).accounts.length, 4);
        await execute({
          kind: "TABLE",
          name: "Lounge",
          dealer: "dealer",
          status: "OPEN",
        });
        loungeTable = (await snapshot()).store.tables.find(
          (table) => table.name === "Lounge",
        )!.id;
        const opened = await execute(
          { kind: "OPEN_DAY", date: "2026-10-21", openingCash: 10_000_000 },
          "manager",
        );
        assert.equal(currentDay(opened.store)?.status, "OPEN");
      },
    );

    await t.test(
      "cash and credit check-in, occupied seating, moves and independent buy-ins work together",
      async () => {
        await execute(
          {
            kind: "CHECK_IN",
            name: "Cash Player",
            phone: "+12025550111",
            type: "CASH",
            creditLimit: 0,
            tags: [],
            tableId: mainTable,
            seat: 1,
          },
          "cashier",
        );
        cashPlayer = (await snapshot()).store.profiles.find(
          (player) => player.name === "Cash Player",
        )!.id;
        const beforeInvalid = await snapshot();
        await assert.rejects(
          execute(
            {
              kind: "CHECK_IN",
              name: "Occupied Seat",
              phone: "+12025550112",
              type: "CASH",
              creditLimit: 0,
              tags: [],
              tableId: mainTable,
              seat: 1,
            },
            "cashier",
          ),
          /occupied/,
        );
        assert.deepEqual(await snapshot(), beforeInvalid);
        await execute(
          {
            kind: "CHECK_IN",
            name: "Credit Player",
            phone: "+12025550113",
            type: "CREDIT",
            creditLimit: 500_000,
            tags: ["VIP"],
            tableId: mainTable,
            seat: 2,
          },
          "manager",
        );
        creditPlayer = (await snapshot()).store.profiles.find(
          (player) => player.name === "Credit Player",
        )!.id;
        await execute(
          { kind: "MOVE", playerId: cashPlayer, tableId: loungeTable, seat: 3 },
          "cashier",
        );
        const before = await snapshot("cashier");
        savedBuyIn = {
          branchId: "local",
          revision: before.revision,
          operationId: crypto.randomUUID(),
          command: {
            kind: "REQUEST",
            type: "Buy-in",
            amount: 125_000,
            playerId: cashPlayer,
            note: "Initial cash chips",
          },
        };
        const first = await mutate(db, tokens.cashier, savedBuyIn);
        const retried = await mutate(db, tokens.cashier, savedBuyIn);
        assert.equal(retried.revision, first.revision);
        assert.equal(first.store.approvals[0].tableId, loungeTable);
        await assert.rejects(
          approve(first.store.approvals[0].id, "cashier"),
          /Independent/,
        );
        await assert.rejects(
          execute(
            { kind: "MOVE", playerId: cashPlayer, tableId: mainTable, seat: 3 },
            "cashier",
          ),
          /pending/,
        );
        await approve(first.store.approvals[0].id);
        const next = await approve(
          await request("Buy-in", 250_000, creditPlayer),
        );
        assert.equal(debt(next.store, creditPlayer), 250_000);
        assert.equal(totalsForDay(next.store).cashReceived, 125_000);
        await assert.rejects(
          request("Buy-in", 9_000, cashPlayer),
          /buy-in|minimum/i,
        );
        await assert.rejects(
          request("Buy-in", 10_001, cashPlayer),
          /increment|multiple|step/i,
        );
      },
    );

    await t.test(
      "dealer rake, tips, insurance and jackpot entries post the correct separate cash movements",
      async () => {
        for (const [type, amount] of [
          ["Rake", 5_000],
          ["Tips", 1_500],
          ["Insurance Premium", 10_000],
          ["Insurance Payout", 7_000],
          ["Jackpot Contribution", 3_000],
          ["Jackpot Payout", 2_000],
        ] as const) {
          const id = await request(type, amount, undefined, "dealer");
          await approve(id, type.endsWith("Payout") ? "admin" : "manager");
        }
        const totals = totalsForDay((await snapshot()).store);
        assert.equal(totals.cashReceived, 144_500);
        assert.equal(totals.cashPayout, 9_000);
        assert.equal(totals.rake, 5_000);
        assert.equal(totals.tips, 1_500);
        assert.equal(totals.insurance, 3_000);
        assert.equal(totals.jackpot, 1_000);
      },
    );

    await t.test(
      "rejections preserve their reason, replacements post once, and approved corrections preserve the original",
      async () => {
        const rejected = await request("Buy-in", 75_000, cashPlayer);
        await assert.rejects(
          execute(
            {
              kind: "DECIDE",
              approvalId: rejected,
              decision: "REJECTED",
              reason: "",
            },
            "manager",
          ),
          /reason/,
        );
        await execute(
          {
            kind: "DECIDE",
            approvalId: rejected,
            decision: "REJECTED",
            reason: "Wrong slip amount",
          },
          "manager",
        );
        await approve(await request("Buy-in", 80_000, cashPlayer));
        const before = (await snapshot()).store;
        const original = structuredClone(
          before.transactions.find((tx) => tx.type === "Rake")!,
        );
        const pending = await execute(
          {
            kind: "CORRECT",
            transactionId: original.id,
            reason: "Duplicate rake collection",
          },
          "cashier",
        );
        const corrected = await approve(pending.store.approvals[0].id, "admin");
        assert.deepEqual(
          corrected.store.transactions.find((tx) => tx.id === original.id),
          original,
        );
        assert.equal(
          corrected.store.transactions.find(
            (tx) => tx.reversesId === original.id,
          )?.cashReceived,
          -5_000,
        );
        assert.equal(
          corrected.store.approvals.find((approval) => approval.id === rejected)
            ?.rejectionReason,
          "Wrong slip amount",
        );
        assert.equal(totalsForDay(corrected.store).rake, 0);
        await assert.rejects(
          execute(
            {
              kind: "CORRECT",
              transactionId: original.id,
              reason: "Another duplicate reversal",
            },
            "cashier",
          ),
          /already/,
        );
      },
    );

    await t.test(
      "large requests require two distinct reviewers including an admin",
      async () => {
        const id = await request("Cash Received", 3_000_000);
        const before = await snapshot();
        const first = await approve(id);
        assert.equal(
          first.store.approvals.find((approval) => approval.id === id)?.status,
          "PENDING",
        );
        assert.equal(
          first.store.transactions.length,
          before.store.transactions.length,
        );
        await assert.rejects(approve(id), /Independent/);
        const complete = await approve(id, "admin");
        assert.equal(
          complete.store.approvals.find((approval) => approval.id === id)?.votes
            .length,
          2,
        );
        assert.equal(
          complete.store.transactions.filter((tx) => tx.approvalId === id)
            .length,
          1,
        );
      },
    );

    await t.test(
      "zero cash-out, carryover credit repayment, close, reopen and new day reconcile correctly",
      async () => {
        await approve(await request("Credit Repayment", 50_000, creditPlayer));
        const cashOut = await request("Cash-out", 0, cashPlayer);
        await approve(cashOut, "admin");
        const creditOut = await request("Cash-out", 0, creditPlayer);
        const checkedOut = await approve(creditOut, "admin");
        assert.equal(
          checkedOut.store.sessions.filter(
            (session) => session.status === "ACTIVE",
          ).length,
          0,
        );
        assert.equal(debt(checkedOut.store, creditPlayer), 200_000);
        assert.equal(totalsForDay(checkedOut.store).expectedCash, 13_260_500);
        await execute(
          { kind: "CLOSE_DAY", countedCash: 13_260_500, reason: "" },
          "manager",
        );
        const close = structuredClone(
          currentDay((await snapshot()).store)!.closes[0],
        );
        await assert.rejects(
          request("Tips", 100, undefined, "dealer"),
          /closed/,
        );
        await assert.rejects(
          execute(
            { kind: "REOPEN_DAY", reason: "Supervisor reconciliation review" },
            "manager",
          ),
          /permission/,
        );
        await execute({
          kind: "REOPEN_DAY",
          reason: "Admin reconciliation review",
        });
        await execute(
          { kind: "CLOSE_DAY", countedCash: 13_260_500, reason: "" },
          "manager",
        );
        assert.deepEqual(
          currentDay((await snapshot()).store)!.closes[0],
          close,
        );
        const nextDay = await execute(
          { kind: "OPEN_DAY", date: "2026-10-22", openingCash: 13_260_500 },
          "manager",
        );
        assert.equal(totalsForDay(nextDay.store).buyInTotal, 0);
        const repaid = await approve(
          await request("Credit Repayment", 200_000, creditPlayer),
        );
        assert.equal(debt(repaid.store, creditPlayer), 0);
        assert.equal(totalsForDay(repaid.store).cashReceived, 200_000);
        await execute(
          { kind: "CLOSE_DAY", countedCash: 13_460_500, reason: "" },
          "manager",
        );
        savedSnapshot = await snapshot();
      },
    );

    await t.test(
      "switching locations isolates records and rejects commands from a stale location tab",
      async () => {
        await changeBranch(db, tokens.admin, "other");
        const other = await snapshot();
        assert.equal(other.branch.id, "other");
        assert.equal(other.store.profiles.length, 0);
        assert.equal(other.store.days.length, 0);
        assert.equal(other.store.settings?.setupCompleted ?? false, false);
        await assert.rejects(
          mutate(db, tokens.admin, {
            branchId: "local",
            revision: savedSnapshot.revision,
            operationId: crypto.randomUUID(),
            command: {
              kind: "TABLE",
              name: "Wrong location",
              dealer: "",
              status: "OPEN",
            },
          }),
          /branch changed/,
        );
        await assert.rejects(
          changeBranch(db, tokens.cashier, "other"),
          /access/,
        );
        await execute({
          kind: "UPDATE_SETTINGS",
          settings: { ...editable(), venueName: "Other Venue" },
          reason: "Configure the second independent location",
        });
        await execute({
          kind: "TABLE",
          name: "Other Main Table",
          dealer: "",
          status: "OPEN",
        });
        await changeBranch(db, tokens.admin, "local");
        assert.deepEqual(await snapshot(), savedSnapshot);
      },
    );

    await t.test(
      "a validated backup restores both configured locations, complete ledgers and operation retry markers",
      async () => {
        const original = await createBackup(db);
        const backup = parseBackup(JSON.parse(JSON.stringify(original)));
        await db.query(
          "UPDATE poker_branches SET name='Temporary change' WHERE id='local'",
        );
        let safetySaved = false;
        await restoreBackup(db, backup, async (safety) => {
          safetySaved = true;
          assert.equal(
            safety.payload.branches.find((branch) => branch.id === "local")
              ?.name,
            "Temporary change",
          );
        });
        assert.equal(safetySaved, true);
        assert.equal(await sessionUser(db, tokens.admin), null);
        tokens.admin = await login(db, "admin", password);
        tokens.cashier = await login(db, "cashier", password);
        await changeBranch(db, tokens.admin, "local");
        const restored = await createBackup(db);
        assert.deepEqual(
          { ...restored.payload, createdAt: "" },
          { ...original.payload, createdAt: "" },
        );
        assert.deepEqual(await snapshot(), savedSnapshot);
        const retry = await mutate(db, tokens.cashier, savedBuyIn);
        assert.equal(retry.revision, savedSnapshot.revision);
        assert.equal(
          retry.store.transactions.length,
          savedSnapshot.store.transactions.length,
        );
        assert.equal(
          retry.store.approvals.filter(
            (approval) => approval.note === "Initial cash chips",
          ).length,
          1,
        );
        await changeBranch(db, tokens.admin, "other");
        const other = await snapshot();
        assert.equal(other.branch.name, "Other Venue");
        assert.equal(other.store.tables[0].name, "Other Main Table");
        assert.equal(other.store.transactions.length, 0);
      },
    );
  } finally {
    await engine.close();
  }
});
