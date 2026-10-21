import type { Command } from "@/domain/commands";
import type { EntryType, Role, Staff, Store } from "@/domain/model";
import { applyCommand } from "@/domain/operations";
import { emptyStore, totalsForDay } from "@/domain/selectors";
import { defaultSettings } from "@/domain/settings";
import type { StaffAccount } from "@/domain/staff";

export type PrototypeScenario = "busy" | "walkthrough" | "closing";
export type PrototypePersonaId = "cashier" | "manager" | "admin" | "dealer";
export type PrototypeAccount = StaffAccount & {
  personaId?: PrototypePersonaId;
};

export const prototypePersonas = [
  { id: "cashier", label: "Cashier", role: "CASHIER" },
  { id: "manager", label: "Manager", role: "MANAGER" },
  { id: "admin", label: "Admin", role: "ADMIN" },
  { id: "dealer", label: "Dealer", role: "DEALER" },
] as const satisfies readonly {
  id: PrototypePersonaId;
  label: string;
  role: Role;
}[];

export const prototypeScenarios = [
  {
    id: "busy",
    label: "Busy shift",
    description:
      "Explore occupied tables, cash and credit players, reports and pending approvals.",
  },
  {
    id: "walkthrough",
    label: "Player walkthrough",
    description:
      "Start with free seats and follow a player from check-in to buy-in, approval and cash-out.",
  },
  {
    id: "closing",
    label: "Ready to close",
    description:
      "All players are checked out and requests reviewed. Count the float and close the shift.",
  },
] as const satisfies readonly {
  id: PrototypeScenario;
  label: string;
  description: string;
}[];

const samplePeople = [
  ["Alex Tan", "CASH"],
  ["Mei Lim", "CREDIT"],
  ["Arjun Rao", "CASH"],
  ["Sara Lee", "CREDIT"],
  ["Daniel Wong", "CASH"],
  ["Aina Yusuf", "CASH"],
  ["Ben Ong", "CASH"],
  ["Chloe Ng", "CREDIT"],
  ["David Teoh", "CASH"],
  ["Eva Chan", "CASH"],
  ["Farid Aziz", "CREDIT"],
  ["Grace Low", "CASH"],
] as const;

/** Fictional accounts for frontend demonstrations. No passwords exist in this model. */
export function createPrototypeAccounts(branchId: string): PrototypeAccount[] {
  const branchNumber =
    branchId === "demo-city"
      ? "10000000"
      : branchId === "demo-riverside"
        ? "20000000"
        : crypto.randomUUID().slice(0, 8);
  return prototypePersonas.map((persona, index) => ({
    id: `${branchNumber}-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    username: `demo.${persona.id}`,
    role: persona.role,
    personaId: persona.id,
    active: true,
    sharedAccount: false,
  }));
}

function businessDate(now: Date, offset: number) {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kuala_Lumpur",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const date = new Date(`${today}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

/** PROTOTYPE: repeatable fictional shifts, built through the normal pure business rules. */
export function createPrototypeSample(
  branchId: string,
  venueName: string,
  scenario: PrototypeScenario,
  now = new Date(),
) {
  const accounts = createPrototypeAccounts(branchId);
  const actors = Object.fromEntries(
    accounts.map((account) => [
      account.personaId!,
      {
        id: account.id,
        username: account.username,
        role: account.role,
        branchId,
      },
    ]),
  ) as Record<PrototypePersonaId, Staff>;
  let store: Store = emptyStore();
  store.settings = {
    ...defaultSettings(),
    setupCompleted: true,
    venueName,
    smallBlind: 500,
    bigBlind: 1000,
    minBuyIn: 20000,
    maxBuyIn: 500000,
    buyInStep: 5000,
    rakePercent: 5,
    rakeCap: 5000,
    tipsPolicy:
      "Tips are optional and recorded separately from player cash-outs.",
    houseRules:
      "Fictional venue for stakeholder review. Buy-ins and cash-outs require independent approval. Seat changes retain the player's visit history.",
  };
  let cursor = 0;
  function run(command: Command, actor: Staff = actors.cashier) {
    cursor += 30_000;
    store = applyCommand(store, command, actor, new Date(cursor).toISOString());
  }
  function startDay(offset: number) {
    const date = businessDate(now, offset);
    // Keep today's sample entries in the past, including early-morning demos.
    cursor =
      offset === 0
        ? now.getTime() - 2 * 60 * 60_000
        : Date.parse(`${date}T09:00:00+08:00`);
    run({ kind: "OPEN_DAY", date, openingCash: 2000000 }, actors.manager);
  }
  function post(
    type: EntryType,
    amount: number,
    subject: { playerId?: string; tableId?: string } = {},
    actor: Staff = actors.cashier,
    note = "Fictional completed shift entry",
  ) {
    run({ kind: "REQUEST", type, amount, ...subject, note }, actor);
    const approvalId = store.approvals[0].id;
    run({ kind: "DECIDE", approvalId, decision: "APPROVED" }, actors.admin);
    if (
      store.approvals.find((request) => request.id === approvalId)?.status ===
      "PENDING"
    )
      run({ kind: "DECIDE", approvalId, decision: "APPROVED" }, actors.manager);
  }
  function checkIn(index: number, tableId: string, seat: number) {
    const [name, type] = samplePeople[index];
    const phone = `+1202555${String(100 + index).padStart(4, "0")}`;
    run(
      {
        kind: "CHECK_IN",
        name,
        phone,
        type,
        creditLimit: type === "CREDIT" ? 500000 : 0,
        tags: index === 0 ? ["VIP"] : [],
        tableId,
        seat,
      },
      type === "CREDIT" ? actors.manager : actors.cashier,
    );
    return store.profiles.find((profile) => profile.phone === phone)!.id;
  }
  cursor = Date.parse(`${businessDate(now, -3)}T08:00:00+08:00`);
  run(
    {
      kind: "TABLE",
      name: "Main floor",
      dealer: "Demo dealer",
      status: "OPEN",
    },
    actors.admin,
  );
  run(
    {
      kind: "TABLE",
      name: "Lounge",
      dealer: "Demo dealer",
      status: "OPEN",
      smallBlind: 1000,
      bigBlind: 2500,
      minBuyIn: 50000,
      maxBuyIn: 1000000,
      buyInStep: 5000,
    },
    actors.admin,
  );
  run(
    { kind: "TABLE", name: "Private room", dealer: "", status: "CLOSED" },
    actors.admin,
  );
  const main = store.tables[0].id;
  const lounge = store.tables[1].id;

  for (const offset of [-3, -2, -1]) {
    startDay(offset);
    for (let index = 0; index < samplePeople.length; index++) {
      const playerId = checkIn(index, main, 1);
      const amount = (4 + (index % 4)) * 10000;
      post("Buy-in", amount, { playerId });
      const cashOut =
        offset === -1 && index === 10
          ? 0
          : amount + (index % 3 === 0 ? 5000 : index % 3 === 1 ? -5000 : 0);
      post("Cash-out", cashOut, { playerId });
    }
    post(
      "Rake",
      (35 + Math.abs(offset) * 5) * 100,
      { tableId: main },
      actors.dealer,
    );
    post("Tips", 1000, { tableId: main }, actors.dealer);
    run(
      {
        kind: "CLOSE_DAY",
        dayId: store.currentDayId!,
        countedCash: totalsForDay(store).expectedCash,
        reason: "",
      },
      actors.manager,
    );
  }
  startDay(0);
  if (scenario === "busy") {
    const activeCount = branchId === "demo-riverside" ? 6 : 9;
    const currentPlayers: string[] = [];
    for (let index = 0; index < activeCount; index++) {
      const playerId = checkIn(
        index,
        index < 5 ? main : lounge,
        index < 5 ? index + 1 : index - 4,
      );
      currentPlayers.push(playerId);
      post(
        "Buy-in",
        50000,
        { playerId },
        actors.cashier,
        "Opening chips for this fictional visit",
      );
    }
    post("Rake", 5000, { tableId: main }, actors.dealer);
    post("Tips", 1000, { tableId: main }, actors.dealer);
    post("Insurance Premium", 2000, { tableId: lounge }, actors.dealer);
    post("Jackpot Contribution", 1500, { tableId: main }, actors.dealer);
    run({
      kind: "REQUEST",
      type: "Buy-in",
      amount: 50000,
      playerId: currentPlayers[0],
      note: "Additional chips requested at the counter",
    });
    run({
      kind: "REQUEST",
      type: "Cash-out",
      amount: 70000,
      playerId: currentPlayers[3],
      note: "Return RM700 in chips; settle credit before cash payout",
    });
    run({
      kind: "REQUEST",
      type: "Cash Received",
      amount: 2500000,
      note: "Example float top-up requiring two independent reviewers",
    });
  } else if (scenario === "closing") {
    for (let index = 0; index < 5; index++) {
      const playerId = checkIn(index, main, 1);
      post("Buy-in", 50000, { playerId });
      post("Cash-out", index === 0 ? 70000 : 50000, { playerId });
    }
    post("Rake", 15000, { tableId: main }, actors.dealer);
    post("Tips", 2500, { tableId: main }, actors.dealer);
  }
  return { store, accounts };
}
