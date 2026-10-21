import { buildSampleStore } from "../../scripts/sample-data";
import type { Command } from "../../src/domain/commands";
import type { EntryType, Staff, Store } from "../../src/domain/model";
import { applyCommand } from "../../src/domain/operations";

/** Presentation stress cases only; every entry is built with normal domain rules. */
export function financeLayoutFixture(): Store {
  const actors = {
    cashier: {
      id: "qa.cashier",
      username: "AlexandriaCatherineMontgomeryWellingtonCashier",
      role: "CASHIER",
      branchId: "qa",
    },
    manager: {
      id: "qa.manager",
      username: "Jean-Baptiste de Saint-Exupéry Manager",
      role: "MANAGER",
      branchId: "qa",
    },
    admin: {
      id: "qa.admin",
      username: "陳嘉豪林美玲黃志明歐陽文慧管理員",
      role: "ADMIN",
      branchId: "qa",
    },
    dealer: {
      id: "qa.dealer",
      username: "Nur Aisyah binti Muhammad Abdullah Dealer",
      role: "DEALER",
      branchId: "qa",
    },
  } satisfies Record<string, Staff>;
  let store = buildSampleStore(actors, new Date("2026-10-21T15:00:00.000Z"));
  let cursor = Date.parse("2026-10-21T04:00:00.000Z");
  const run = (command: Command, actor: Staff = actors.cashier) => {
    cursor += 30_000;
    store = applyCommand(store, command, actor, new Date(cursor).toISOString());
  };
  const playerNames = [
    "Alex Lin",
    "Alexandria Catherine Montgomery-Wellington",
    "ChristopherMaximilianAlexanderMontgomeryWellington",
    "陳嘉豪林美玲黃志明歐陽文慧",
    "Nur Aisyah binti Muhammad Abdullah",
    "Jean-Baptiste de Saint-Exupéry",
    "Li",
    "María José Fernández de la Cruz",
    "王小明",
  ];
  for (const [index, profile] of store.profiles.entries()) {
    if (!playerNames[index]) continue;
    run(
      {
        kind: "UPDATE_PROFILE",
        playerId: profile.id,
        name: playerNames[index],
        tags: profile.tags,
        creditLimit: profile.creditLimit,
        reason: "Disposable finance list wrapping fixture",
      },
      actors.admin,
    );
  }
  for (const [index, table] of store.tables.slice(0, 2).entries()) {
    run(
      {
        kind: "TABLE",
        tableId: table.id,
        name:
          index === 0
            ? "Main floor · International championship and private tournament seating"
            : "南洋國際德州撲克錦標賽貴賓休息室長名稱測試桌",
        dealer: table.dealer,
        status: table.status,
      },
      actors.admin,
    );
  }
  store.settings = { ...store.settings!, venueName: "UI Test Venue" };
  const cashPlayerId = store.profiles[2].id;
  const creditPlayerId = store.profiles[4].id;
  const mainTableId = store.tables[0].id;
  const loungeId = store.tables[1].id;

  function request(
    type: EntryType,
    amount: number,
    subject: { playerId?: string; tableId?: string } = {},
    note = "Disposable finance layout example",
  ) {
    run({ kind: "REQUEST", type, amount, ...subject, note });
    return store.approvals[0].id;
  }
  function approve(id: string) {
    run({ kind: "DECIDE", approvalId: id, decision: "APPROVED" }, actors.admin);
  }

  // More than one page of posted current-day records, with both cash and credit.
  for (let index = 0; index < 3; index++) {
    for (const [type, amount, subject] of [
      ["Buy-in", 25_000, { playerId: cashPlayerId }],
      ["Buy-in", 25_000, { playerId: creditPlayerId }],
      ["Rake", 1_200, { tableId: mainTableId }],
      ["Tips", 500, { tableId: loungeId }],
      ["Cash Received", 10_000, {}],
      ["Credit Repayment", 500, { playerId: creditPlayerId }],
      ["Insurance Premium", 1_000, { tableId: mainTableId }],
      ["Jackpot Contribution", 1_000, { tableId: loungeId }],
    ] as const) {
      const id = request(
        type,
        amount,
        subject,
        `Counter reconciliation batch ${index + 1}: confirm the player, table and original counter slip before posting this disposable example.`,
      );
      approve(id);
    }
  }

  // A recent posted reversal and a separate pending reversal exercise row actions.
  approve(request("Tips", 2_000, { tableId: loungeId }, "Duplicate tip slip"));
  run({
    kind: "CORRECT",
    transactionId: store.transactions[0].id,
    reason: "Duplicate tip slip: keep this correction linked to its original receipt.",
  });
  approve(store.approvals[0].id);
  run({
    kind: "CORRECT",
    transactionId: store.transactions.find(
      (tx) => tx.dayId === store.currentDayId && tx.type === "Rake",
    )!.id,
    reason: "PendingRakeCorrectionWithALongUnbrokenExplanationForCompactListWrapping",
  });

  // More than one pending page; no approval or ledger mutation is needed for QA.
  for (let index = 0; index < 3; index++) {
    for (const [type, amount, subject] of [
      ["Buy-in", 25_000, { playerId: cashPlayerId }],
      ["Buy-in", 25_000, { playerId: creditPlayerId }],
      ["Rake", 1_200, { tableId: mainTableId }],
      ["Tips", 500, { tableId: loungeId }],
      ["Cash Payout", 1_000, {}],
      ["Insurance Payout", 1_000, { tableId: mainTableId }],
      ["Jackpot Contribution", 1_000, { tableId: loungeId }],
      ["Cash Received", 10_000, {}],
    ] as const) {
      request(
        type,
        amount,
        subject,
        `Pending batch ${index + 1}: please verify the supporting counter slip and player identification. 此項目保留完整附註以便在審核詳情中閱讀。`,
      );
    }
  }

  for (let index = 0; index < 3; index++) {
    const id = request("Cash Payout", 2_000, {}, "Duplicate counter slip");
    run(
      {
        kind: "DECIDE",
        approvalId: id,
        decision: "REJECTED",
        reason:
          index === 1
            ? "DuplicatePayoutRequestTheOriginalCounterSlipHasAlreadyBeenRecordedPleaseCheckTheOriginalReceiptBeforeSubmittingAnotherRequest"
            : "Duplicate payout request. The original counter slip has already been recorded; verify the reference and amount with the cashier before submitting another request. 此拒絕原因包含完整說明，請在詳情中確認。",
      },
      actors.admin,
    );
  }
  return store;
}
