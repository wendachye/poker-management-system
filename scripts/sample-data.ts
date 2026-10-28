import { createHash, randomUUID } from "node:crypto";
import { applyCommand } from "../src/domain/operations";
import { emptyStore, totalsForDay } from "../src/domain/selectors";
import { defaultSettings } from "../src/domain/settings";
import type { Command } from "../src/domain/commands";
import type { Staff, Store, EntryType, PlayerTag } from "../src/domain/model";
import type { Database } from "../src/server/database";
import { readStore, replaceStore } from "../src/server/storage";

const SAMPLE_OPERATION = "b4824185-8f4d-4ad3-81e0-f9af1b627ede";
const SAMPLE_VERSION = "local-sample-data-v1";
type SampleStaff = Record<"cashier" | "manager" | "admin" | "dealer", Staff>;

/** Fictional operations go through the same validation and ledger rules as the app. */
export function buildSampleStore(actors: SampleStaff, now = new Date()): Store {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kuala_Lumpur",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const midnight = Date.parse(today + "T00:00:00+08:00");
  let store = emptyStore(),
    cursor = 0,
    step = 60_000;
  store.settings = { ...defaultSettings(), setupCompleted: true };
  function startClock(offset: number) {
    const start = midnight + offset * 86_400_000;
    const elapsed = Math.max(1, now.getTime() - midnight);
    cursor =
      start +
      (offset === 0 ? Math.min(9 * 3_600_000, elapsed / 4) : 10 * 3_600_000);
    step = offset === 0 ? Math.min(60_000, elapsed / 500) : 60_000;
    return new Date(start + 8 * 3_600_000).toISOString().slice(0, 10);
  }
  function run(command: Command, actor = actors.admin) {
    cursor += step;
    store = applyCommand(store, command, actor, new Date(cursor).toISOString());
  }
  function request(
    type: EntryType,
    amount: number,
    playerId?: string,
    tableId?: string,
    approve = true,
    note = "Sample venue activity",
  ) {
    run(
      {
        kind: "REQUEST",
        type,
        amount,
        playerId,
        tableId,
        note: "[Sample] " + note,
      },
      actors.cashier,
    );
    const id = store.approvals[0].id;
    if (approve)
      run(
        { kind: "DECIDE", approvalId: id, decision: "APPROVED" },
        actors.admin,
      );
    return id;
  }
  const names = [
    "Alex Tan",
    "Mei Lim",
    "Arjun Rao",
    "Sara Lee",
    "Daniel Wong",
    "Aina Yusuf",
    "Ben Ong",
    "Chloe Ng",
    "David Teoh",
    "Eva Chan",
    "Farid Aziz",
    "Grace Low",
    "Hao Lin",
    "Irene Goh",
    "Jason Chen",
    "Nadia Aziz",
  ];
  const limits: Record<number, number> = {
    1: 500_000,
    4: 1_000_000,
    9: 300_000,
    15: 800_000,
  };
  const phone = (i: number) => "+1202555" + String(101 + i).padStart(4, "0");
  const player = (i: number) =>
    store.profiles.find((p) => p.phone === phone(i))!;
  function checkIn(i: number) {
    const tags: PlayerTag[] =
      i === 0 || i === 1 ? ["VIP"] : i === 3 ? ["Risk"] : [];
    run({
      kind: "CHECK_IN",
      playerId: store.profiles.find((profile) => profile.phone === phone(i))
        ?.id,
      name: "Sample · " + names[i],
      phone: phone(i),
      type: limits[i] ? "CREDIT" : "CASH",
      creditLimit: limits[i] ?? 0,
      tags,
      tableId: store.tables[Math.floor(i / 9)].id,
      seat: (i % 9) + 1,
    });
  }
  function tableActivity(multiplier: number) {
    for (const [type, amount] of [
      ["Rake", 7_500],
      ["Tips", 2_500],
      ["Insurance Premium", 6_000],
      ["Insurance Payout", 2_000],
      ["Jackpot Contribution", 5_000],
    ] as const)
      request(type, amount * multiplier, undefined, store.tables[0].id);
  }
  function closeDay(variance = 0) {
    const countedCash = totalsForDay(store).expectedCash + variance;
    run({
      kind: "CLOSE_DAY",
      countedCash,
      reason: variance
        ? "[Sample] RM25 counting difference for reconciliation practice."
        : "[Sample] Cash reconciled.",
    });
    return countedCash;
  }

  // First completed day: all players have a visit, including a credit carryover.
  run({ kind: "OPEN_DAY", date: startClock(-2), openingCash: 2_000_000 });
  for (const [name, dealer, status] of [
    ["Sample · Main floor", "Sample Dealer A", "OPEN"],
    ["Sample · Lounge", "Sample Dealer B", "OPEN"],
    ["Sample · Reserve", "", "OPEN"],
    ["Sample · Training", "", "CLOSED"],
  ] as const)
    run({ kind: "TABLE", name, dealer, status });
  for (let i = 0; i < names.length; i++) {
    checkIn(i);
    const amount = (i + 3) * 10_000;
    request("Buy-in", amount, player(i).id);
    const payout =
      i === 15 ? amount - 50_000 : amount + (i % 2 ? 5_000 : -5_000);
    request("Cash-out", payout, player(i).id);
  }
  tableActivity(1);
  const secondOpening = closeDay(-2_500);

  // Second completed day: returning players, repayment and a balanced close.
  run({ kind: "OPEN_DAY", date: startClock(-1), openingCash: secondOpening });
  for (let i = 0; i < 10; i++) {
    checkIn(i);
    const amount = 50_000 + i * 5_000;
    request("Buy-in", amount, player(i).id);
    request("Cash-out", amount + 8_000, player(i).id);
  }
  request("Credit Repayment", 20_000, player(15).id);
  tableActivity(2);
  const currentOpening = closeDay();
  run({
    kind: "UPDATE_PROFILE",
    playerId: player(14).id,
    name: player(14).name,
    tags: ["Banned"],
    creditLimit: 0,
    reason:
      "[Sample] Restricted inactive profile for testing the check-in guard.",
  });

  // Current day: one full table, one partly occupied, one empty and one closed.
  run({ kind: "OPEN_DAY", date: startClock(0), openingCash: currentOpening });
  const amounts = [
    75_000, 400_000, 50_000, 60_000, 150_000, 40_000, 100_000, 50_000, 70_000,
    180_000, 30_000, 55_000, 80_000, 90_000,
  ];
  for (let i = 0; i < amounts.length; i++) {
    checkIn(i);
    request("Buy-in", amounts[i], player(i).id);
  }
  request("Cash-out", 92_000, player(12).id);
  request("Cash-out", 83_000, player(13).id);
  tableActivity(3);
  request(
    "Tips",
    1_200,
    undefined,
    store.tables[1].id,
    true,
    "Duplicate tip entry for the reversal example.",
  );
  const duplicateTip = store.transactions[0];
  run(
    {
      kind: "CORRECT",
      transactionId: duplicateTip.id,
      reason: "[Sample] Reverse the duplicate tip entry.",
    },
    actors.cashier,
  );
  run({
    kind: "DECIDE",
    approvalId: store.approvals[0].id,
    decision: "APPROVED",
  });

  // Ready-to-review examples. Existing local staff can independently review these.
  request(
    "Buy-in",
    25_000,
    player(0).id,
    undefined,
    false,
    "Additional chips requested.",
  );
  request(
    "Cash-out",
    420_000,
    player(1).id,
    undefined,
    false,
    "Credit settlement and cash payout example.",
  );
  const rejected = request(
    "Buy-in",
    10_000,
    player(2).id,
    undefined,
    false,
    "Duplicate counter slip.",
  );
  run(
    {
      kind: "DECIDE",
      approvalId: rejected,
      decision: "REJECTED",
      reason:
        "[Sample] Duplicate request. The original buy-in is already posted.",
    },
    actors.manager,
  );
  run(
    {
      kind: "REQUEST",
      type: "Rake",
      amount: 5_000,
      tableId: store.tables[1].id,
      note: "[Sample] Dealer shift entry awaiting review.",
    },
    actors.dealer,
  );
  const dual = request(
    "Cash Received",
    2_500_000,
    undefined,
    undefined,
    false,
    "Cash float transfer: a second reviewer including an admin is required.",
  );
  run(
    { kind: "DECIDE", approvalId: dual, decision: "APPROVED" },
    actors.manager,
  );
  const premium = store.transactions.find(
    (tx) => tx.dayId === store.currentDayId && tx.type === "Insurance Premium",
  )!;
  run(
    {
      kind: "CORRECT",
      transactionId: premium.id,
      reason: "[Sample] Insurance correction awaiting admin review.",
    },
    actors.cashier,
  );
  return store;
}

export function sampleSummary(store: Store) {
  return {
    players: store.profiles.length,
    activePlayers: store.sessions.filter((s) => s.status === "ACTIVE").length,
    tables: store.tables.length,
    businessDays: store.days.length,
    transactions: store.transactions.length,
    pendingRequests: store.approvals.filter((r) => r.status === "PENDING")
      .length,
    rejectedRequests: store.approvals.filter((r) => r.status === "REJECTED")
      .length,
    currentDate: store.days.find((d) => d.id === store.currentDayId)?.date,
  };
}

/** Refuses populated venues; the marker and records commit atomically under the branch lock. */
export async function seedLocalSamples(
  db: Database,
  now = new Date(),
  backup?: (value: { revision: number; data: Store }) => Promise<void>,
) {
  return db.transaction(async (connection) => {
    const row = (
      await connection.query<{ revision: number }>(
        "SELECT revision FROM poker_branch_state WHERE branch_id=$1 FOR UPDATE",
        ["local"],
      )
    ).rows[0];
    if (!row)
      throw new Error("Start npm run local before loading sample data.");
    const current = await readStore(connection, "local");
    const exists =
      (
        await connection.query(
          "SELECT operation_id FROM poker_operations WHERE branch_id=$1 AND operation_id=$2",
          ["local", SAMPLE_OPERATION],
        )
      ).rows.length > 0;
    if (exists) return { added: false, ...sampleSummary(current) };
    if (
      current.currentDayId ||
      Object.values(current).some(
        (value) => Array.isArray(value) && value.length > 0,
      )
    )
      throw new Error(
        "Local Venue already contains records. Sample loading stopped without changing them.",
      );
    await backup?.({ revision: row.revision, data: current });
    const actors = Object.fromEntries(
      (["cashier", "manager", "admin", "dealer"] as const).map((role) => [
        role,
        {
          id: randomUUID(),
          username: "sample." + role,
          role: role.toUpperCase(),
          branchId: "local",
        },
      ]),
    ) as SampleStaff;
    const next = buildSampleStore(actors, now);
    for (const actor of Object.values(actors)) {
      // These audit actors cannot sign in. Existing staff accounts are untouched.
      await connection.query(
        "INSERT INTO poker_users(id,username,password_hash,active) VALUES($1,$2,$3,false)",
        [actor.id, actor.username, "sample-data-no-login"],
      );
      await connection.query(
        "INSERT INTO poker_memberships(user_id,branch_id,role) VALUES($1,$2,$3)",
        [actor.id, "local", actor.role],
      );
    }
    await replaceStore(connection, "local", next, row.revision + 1);
    await connection.query(
      "INSERT INTO poker_operations(branch_id,operation_id,actor_id,fingerprint,revision) VALUES($1,$2,$3,$4,$5)",
      [
        "local",
        SAMPLE_OPERATION,
        actors.admin.id,
        createHash("sha256").update(SAMPLE_VERSION).digest("hex"),
        row.revision + 1,
      ],
    );
    return { added: true, ...sampleSummary(next) };
  });
}
