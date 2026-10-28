import { ledgerImpact } from "./ledger-impact";
import { commandSchema, type Command } from "./commands";
import type {
  ApprovalRequest,
  EntryType,
  Staff,
  Store,
  Transaction,
} from "./model";
import { currentDay, debt, totalsForDay } from "./selectors";
import {
  effectiveTableRules,
  settingsSchema,
  tableRuleIssue,
  venueSettings,
} from "./settings";
import type { TableRecord } from "./model";

export class DomainError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
function requireThat(
  condition: unknown,
  message: string,
  status = 400,
): asserts condition {
  if (!condition) throw new DomainError(message, status);
}
function permit(actor: Staff, roles: Staff["role"][]) {
  requireThat(
    roles.includes(actor.role),
    "You do not have permission for this action.",
    403,
  );
}
const supervisors: Staff["role"][] = ["MANAGER", "ADMIN"];
const cashiers: Staff["role"][] = ["CASHIER", ...supervisors];
const dealerEntries: EntryType[] = [
  "Rake",
  "Tips",
  "Insurance Premium",
  "Insurance Payout",
  "Jackpot Contribution",
  "Jackpot Payout",
];
const payouts: EntryType[] = [
  "Cash-out",
  "Insurance Payout",
  "Jackpot Payout",
  "Cash Payout",
];
const uid = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;

export function normalizePhone(phone: string) {
  const normalized = phone.replace(/[\s()-]/g, "");
  requireThat(
    /^\+[1-9]\d{7,14}$/.test(normalized),
    "Use an international phone number, for example +60123456789.",
  );
  return normalized;
}
export function canApprove(actor: Staff, request: ApprovalRequest) {
  return (
    supervisors.includes(actor.role) &&
    actor.id !== request.requestedById &&
    !request.votes.some((vote) => vote.staffId === actor.id) &&
    request.status === "PENDING" &&
    (request.approvalLevel !== "ADMIN" || actor.role === "ADMIN")
  );
}
function policy(type: string, amount: number) {
  if (amount >= 2_500_000)
    return {
      approvalLevel: "DUAL" as const,
      riskReason: "Two distinct reviewers, including one admin, required.",
    };
  if (
    amount >= 1_000_000 ||
    payouts.includes(type as EntryType) ||
    type === "Reversal"
  ) {
    return {
      approvalLevel: "ADMIN" as const,
      riskReason: "Admin review required for this amount or transaction type.",
    };
  }
  return {
    approvalLevel: "MANAGER" as const,
    riskReason: "Independent manager or admin review required.",
  };
}
function ensureSeat(
  store: Store,
  tableId: string,
  seat: number,
  sessionId?: string,
) {
  requireThat(
    store.tables.some(
      (table) => table.id === tableId && table.status === "OPEN",
    ),
    "Select an open table.",
  );
  requireThat(
    !store.sessions.some(
      (session) =>
        session.status === "ACTIVE" &&
        session.tableId === tableId &&
        session.seat === seat &&
        session.id !== sessionId,
    ),
    "That seat is occupied.",
  );
}
function audit(
  store: Store,
  actor: Staff,
  time: string,
  action: string,
  entity: string,
  reason: string,
  before?: string,
  after?: string,
) {
  store.auditLogs.unshift({
    id: uid("LOG"),
    time,
    actor: actor.username,
    actorId: actor.id,
    action,
    entity,
    reason,
    before,
    after,
  });
}

function reservedCredit(store: Store, playerId: string) {
  if (store.readModel) return store.readModel.reservedCredit[playerId] ?? 0;
  return store.approvals
    .filter(
      (request) =>
        request.playerId === playerId &&
        request.type === "Buy-in" &&
        request.status === "PENDING",
    )
    .reduce((sum, request) => sum + request.amount, 0);
}

/** Pure business operation. The repository commits its entire result atomically. */
export function applyCommand(
  original: Store,
  input: Command,
  actor: Staff,
  time = new Date().toISOString(),
): Store {
  const parsed = commandSchema.safeParse(input);
  requireThat(parsed.success, "Invalid operation. Check the supplied fields.");
  const command = parsed.data;
  const store = structuredClone(original);
  const day = currentDay(store);
  const settings = venueSettings(store);
  if (command.kind === "UPDATE_SETTINGS") {
    permit(actor, ["ADMIN"]);
    const next = {
      ...command.settings,
      setupCompleted: settings.setupCompleted,
    };
    store.settings = next;
    for (const table of store.tables) {
      const issue = tableRuleIssue(store, table);
      requireThat(!issue, `Table ${table.name}: ${issue}`);
    }
    audit(
      store,
      actor,
      time,
      "Updated venue settings",
      actor.branchId,
      command.reason,
      JSON.stringify(settings),
      JSON.stringify(next),
    );
    return store;
  }
  if (command.kind === "COMPLETE_SETUP") {
    permit(actor, ["ADMIN"]);
    requireThat(!settings.setupCompleted, "Venue setup is already complete.");
    requireThat(
      store.settings && settingsSchema.safeParse(store.settings).success,
      "Save valid venue and game settings before completing setup.",
    );
    requireThat(
      store.tables.some((table) => table.status === "OPEN"),
      "Create at least one open table before completing setup.",
    );
    store.settings = { ...settings, setupCompleted: true };
    audit(
      store,
      actor,
      time,
      "Completed venue setup",
      actor.branchId,
      "Venue, game rules, tables and staff reviewed",
      "INCOMPLETE",
      "COMPLETE",
    );
    return store;
  }
  if (command.kind === "OPEN_DAY") {
    permit(actor, supervisors);
    requireThat(
      settings.setupCompleted,
      "An administrator must complete venue setup before opening a business day.",
    );
    requireThat(
      !day || day.status === "CLOSED",
      "Close the current business day first.",
    );
    const date = new Date(`${command.date}T00:00:00Z`);
    requireThat(
      Number.isFinite(date.getTime()) &&
        date.toISOString().slice(0, 10) === command.date,
      "Invalid business date.",
    );
    requireThat(
      !store.days.some((value) => value.date >= command.date),
      "The new business date must follow previous days.",
    );
    const next = {
      id: uid("DAY"),
      date: command.date,
      openedAt: time,
      openingCash: command.openingCash,
      status: "OPEN" as const,
      closes: [],
    };
    store.days.push(next);
    store.currentDayId = next.id;
    audit(
      store,
      actor,
      time,
      "Opened day",
      next.id,
      command.date,
      undefined,
      String(command.openingCash),
    );
    return store;
  }
  if (command.kind === "TABLE") {
    permit(actor, supervisors);
    const table = store.tables.find((value) => value.id === command.tableId);
    requireThat(!command.tableId || table, "Table not found.");
    requireThat(
      command.status !== "CLOSED" ||
        !store.sessions.some(
          (session) =>
            session.tableId === command.tableId && session.status === "ACTIVE",
        ),
      "Move or check out all players before closing this table.",
    );
    requireThat(
      command.status !== "CLOSED" ||
        !store.approvals.some(
          (request) =>
            request.tableId === command.tableId && request.status === "PENDING",
        ),
      "Resolve this table's pending approvals first.",
    );
    const before = table ? JSON.stringify(table) : undefined;
    const next: TableRecord = {
      ...table,
      id: table?.id ?? uid("T"),
      name: command.name,
      dealer: command.dealer,
      status: command.status,
    };
    for (const key of [
      "smallBlind",
      "bigBlind",
      "minBuyIn",
      "maxBuyIn",
      "buyInStep",
    ] as const) {
      if (command[key] === null) delete next[key];
      else if (command[key] !== undefined) next[key] = command[key];
    }
    const ruleIssue = tableRuleIssue(store, next);
    requireThat(!ruleIssue, ruleIssue ?? "Invalid table rules.");
    if (table) store.tables[store.tables.indexOf(table)] = next;
    else store.tables.push(next);
    audit(
      store,
      actor,
      time,
      "Updated table",
      next.id,
      "Table configuration",
      before,
      JSON.stringify(next),
    );
    return store;
  }
  if (command.kind === "UPDATE_PROFILE") {
    permit(actor, supervisors);
    const profile = store.profiles.find(
      (player) => player.id === command.playerId,
    );
    requireThat(profile, "Player not found.");
    const pendingCredit = reservedCredit(store, profile.id);
    requireThat(
      profile.type !== "CREDIT" ||
        command.creditLimit >= debt(store, profile.id) + pendingCredit,
      "Credit limit cannot be below outstanding and reserved credit.",
    );
    const before = JSON.stringify(profile);
    profile.name = command.name;
    profile.tags = [...new Set(command.tags)];
    profile.creditLimit = profile.type === "CREDIT" ? command.creditLimit : 0;
    audit(
      store,
      actor,
      time,
      "Updated profile",
      profile.id,
      command.reason,
      before,
      JSON.stringify(profile),
    );
    return store;
  }
  requireThat(day, "A manager must open a business day first.");
  if (command.kind === "REOPEN_DAY") {
    permit(actor, ["ADMIN"]);
    requireThat(day.status === "CLOSED", "This day is already open.");
    day.status = "OPEN";
    audit(
      store,
      actor,
      time,
      "Reopened day",
      day.id,
      command.reason,
      "CLOSED",
      "OPEN",
    );
    return store;
  }
  requireThat(day.status === "OPEN", "The business day is closed.");
  switch (command.kind) {
    case "CHECK_IN": {
      permit(actor, cashiers);
      const phone = normalizePhone(command.phone);
      let profile = command.playerId
        ? store.profiles.find((player) => player.id === command.playerId)
        : undefined;
      if (command.playerId) {
        requireThat(
          profile && profile.phone === phone,
          "The selected player no longer matches this phone number. Select the player again.",
        );
      } else {
        requireThat(
          !store.profiles.some((player) => player.phone === phone),
          "This phone number belongs to an existing player. Select that player to check in.",
        );
      }
      requireThat(
        (profile?.type ?? command.type) !== "CREDIT" || settings.creditEnabled,
        "Credit accounts are disabled in venue settings.",
      );
      if (!profile) {
        if (command.type === "CREDIT") permit(actor, supervisors);
        requireThat(
          command.type !== "CREDIT" || command.creditLimit > 0,
          "Set a positive credit limit.",
        );
        requireThat(
          !command.tags.includes("Banned"),
          "Banned players cannot check in.",
        );
        profile = {
          id: uid("P"),
          name: command.name,
          phone,
          type: command.type,
          creditLimit: command.type === "CREDIT" ? command.creditLimit : 0,
          tags: [...new Set(command.tags)],
        };
        store.profiles.push(profile);
      }
      requireThat(!profile.tags.includes("Banned"), "This player is banned.");
      requireThat(
        !store.sessions.some(
          (session) =>
            session.playerId === profile.id && session.status === "ACTIVE",
        ),
        "This player is already checked in.",
      );
      ensureSeat(store, command.tableId, command.seat);
      store.sessions.push({
        id: uid("S"),
        playerId: profile.id,
        dayId: day.id,
        status: "ACTIVE",
        tableId: command.tableId,
        seat: command.seat,
        sessionStart: time,
      });
      audit(
        store,
        actor,
        time,
        "Checked in player",
        profile.id,
        `${command.tableId}, seat ${command.seat}`,
      );
      break;
    }
    case "MOVE": {
      permit(actor, cashiers);
      const session = store.sessions.find(
        (value) =>
          value.playerId === command.playerId && value.status === "ACTIVE",
      );
      requireThat(session, "Player has no active session.");
      requireThat(
        !store.approvals.some(
          (request) =>
            request.sessionId === session.id && request.status === "PENDING",
        ),
        "Resolve this player's pending transactions before moving them.",
      );
      ensureSeat(store, command.tableId, command.seat, session.id);
      const before = `${session.tableId}, seat ${session.seat}`;
      session.tableId = command.tableId;
      session.seat = command.seat;
      audit(
        store,
        actor,
        time,
        "Moved player",
        session.playerId,
        "Seat transfer",
        before,
        `${session.tableId}, seat ${session.seat}`,
      );
      break;
    }
    case "SWAP_SEATS": {
      permit(actor, cashiers);
      const { first, second } = command;
      requireThat(
        first.playerId !== second.playerId &&
          first.sessionId !== second.sessionId,
        "Select two different players to swap.",
      );
      requireThat(
        first.tableId !== second.tableId || first.seat !== second.seat,
        "Choose two different seats.",
      );
      const participants = [first, second];
      const sessions = participants.map((participant) => {
        const session = store.sessions.find(
          (value) =>
            value.id === participant.sessionId &&
            value.playerId === participant.playerId &&
            value.dayId === day.id &&
            value.status === "ACTIVE" &&
            value.tableId === participant.tableId &&
            value.seat === participant.seat,
        );
        requireThat(
          session &&
            store.profiles.some(
              (profile) => profile.id === participant.playerId,
            ) &&
            !store.sessions.some(
              (value) =>
                value.playerId === participant.playerId &&
                value.status === "ACTIVE" &&
                value.id !== participant.sessionId,
            ),
          "The seating changed. Close this dialog and try the swap again.",
        );
        return session;
      });
      requireThat(
        participants.every((participant) =>
          store.tables.some(
            (table) =>
              table.id === participant.tableId && table.status === "OPEN",
          ),
        ),
        "Select an open table.",
      );
      requireThat(
        !store.approvals.some(
          (request) =>
            request.status === "PENDING" &&
            participants.some(
              (participant) =>
                request.playerId === participant.playerId ||
                request.sessionId === participant.sessionId,
            ),
        ),
        "Resolve pending request first",
      );
      requireThat(
        !store.sessions.some(
          (occupant) =>
            occupant.status === "ACTIVE" &&
            !participants.some(
              (participant) => participant.sessionId === occupant.id,
            ) &&
            participants.some(
              (participant) =>
                occupant.tableId === participant.tableId &&
                occupant.seat === participant.seat,
            ),
        ),
        "That seat is occupied.",
      );

      // Validate both original assignments before changing either session.
      // The enclosing command persists one result, never two separate moves.
      const reason = JSON.stringify({
        swapId: uid("SWAP"),
        players: [first.playerId, second.playerId],
      });
      sessions[0].tableId = second.tableId;
      sessions[0].seat = second.seat;
      sessions[1].tableId = first.tableId;
      sessions[1].seat = first.seat;
      for (const [index, participant] of participants.entries()) {
        const destination = participants[1 - index];
        audit(
          store,
          actor,
          time,
          "Swapped player seats",
          participant.playerId,
          reason,
          `${participant.tableId}, seat ${participant.seat}`,
          `${destination.tableId}, seat ${destination.seat}`,
        );
      }
      break;
    }
    case "REQUEST": {
      permit(
        actor,
        dealerEntries.includes(command.type)
          ? ["DEALER", ...cashiers]
          : cashiers,
      );
      requireThat(
        command.amount > 0 || command.type === "Cash-out",
        "Amount must be positive.",
      );
      requireThat(
        command.type !== "Tips" || settings.tipsEnabled,
        "Tips are disabled in venue settings.",
      );
      requireThat(
        command.type !== "Rake" || settings.rakeEnabled,
        "Rake is disabled in venue settings.",
      );
      requireThat(
        !["Insurance Premium", "Insurance Payout"].includes(command.type) ||
          settings.insuranceEnabled,
        "Insurance entries are disabled in venue settings.",
      );
      requireThat(
        !["Jackpot Contribution", "Jackpot Payout"].includes(command.type) ||
          settings.jackpotEnabled,
        "Jackpot entries are disabled in venue settings.",
      );
      const profile = store.profiles.find(
        (player) => player.id === command.playerId,
      );
      requireThat(!command.playerId || profile, "Player not found.");
      const session = store.sessions.find(
        (value) => value.playerId === profile?.id && value.status === "ACTIVE",
      );
      const isSession =
        command.type === "Buy-in" || command.type === "Cash-out";
      requireThat(
        !isSession || session,
        "Select a player with an active session.",
      );
      if (command.type === "Buy-in") {
        const rules = effectiveTableRules(
          store,
          store.tables.find((table) => table.id === session?.tableId),
        );
        requireThat(
          command.amount >= rules.minBuyIn && command.amount <= rules.maxBuyIn,
          "Buy-in amount is outside the configured minimum and maximum.",
        );
        requireThat(
          rules.buyInStep === 0 || command.amount % rules.buyInStep === 0,
          "Buy-in amount must follow the configured increment.",
        );
        requireThat(
          profile?.type !== "CREDIT" || settings.creditEnabled,
          "New credit buy-ins are disabled in venue settings. Repayments and cash-out remain available.",
        );
        requireThat(
          !profile?.tags.includes("Banned"),
          "This player is banned.",
        );
        requireThat(
          !store.approvals.some(
            (request) =>
              request.playerId === profile?.id &&
              request.type === "Cash-out" &&
              request.status === "PENDING",
          ),
          "Resolve the pending cash-out first.",
        );
        if (profile?.type === "CREDIT") {
          const reserved = reservedCredit(store, profile.id);
          requireThat(
            debt(store, profile.id) + reserved + command.amount <=
              profile.creditLimit,
            "Credit limit would be exceeded.",
          );
        }
      }
      if (command.type === "Cash-out") {
        requireThat(
          !store.approvals.some(
            (request) =>
              request.sessionId === session?.id && request.status === "PENDING",
          ),
          "Resolve this session's pending transactions before cash-out.",
        );
      }
      if (command.type === "Credit Repayment")
        requireThat(profile?.type === "CREDIT", "Select a credit player.");
      const tableId = isSession ? session?.tableId : command.tableId;
      if (tableId)
        requireThat(
          store.tables.some(
            (table) => table.id === tableId && table.status === "OPEN",
          ),
          "Select an open table.",
        );
      if (dealerEntries.includes(command.type))
        requireThat(tableId, "Select a table.");
      if (command.type === "Cash Received" || command.type === "Cash Payout")
        requireThat(command.note.length >= 3, "Explain this cash movement.");
      const request: ApprovalRequest = {
        id: uid("APR"),
        dayId: day.id,
        type: command.type,
        amount: command.amount,
        playerId: profile?.id,
        sessionId: isSession ? session?.id : undefined,
        tableId,
        staff: actor.username,
        note: command.note,
        status: "PENDING",
        ...policy(command.type, command.amount),
        requestedBy: actor.username,
        requestedById: actor.id,
        createdAt: time,
        votes: [],
      };
      // Validate the settlement against current records without posting it.
      validateEntry(store, request);
      store.approvals.unshift(request);
      audit(
        store,
        actor,
        time,
        "Requested approval",
        request.id,
        `${request.type}: ${request.amount} sen`,
      );
      break;
    }
    case "CORRECT": {
      permit(actor, cashiers);
      const tx = store.transactions.find(
        (value) => value.id === command.transactionId,
      );
      requireThat(
        tx && tx.dayId === day.id && !tx.reversesId,
        "Only original transactions in the current open day can be reversed.",
      );
      requireThat(
        !store.transactions.some((value) => value.reversesId === tx.id) &&
          !store.approvals.some(
            (value) => value.reversesId === tx.id && value.status === "PENDING",
          ),
        "A reversal already exists or is awaiting review.",
      );
      const request: ApprovalRequest = {
        id: uid("APR"),
        dayId: day.id,
        type: "Reversal",
        amount: tx.amount,
        playerId: tx.playerId,
        sessionId: tx.sessionId,
        tableId: tx.tableId,
        staff: actor.username,
        note: command.reason,
        reversesId: tx.id,
        status: "PENDING",
        ...policy("Reversal", tx.amount),
        requestedBy: actor.username,
        requestedById: actor.id,
        createdAt: time,
        votes: [],
      };
      validateEntry(store, request);
      store.approvals.unshift(request);
      audit(
        store,
        actor,
        time,
        "Requested reversal",
        request.id,
        command.reason,
        tx.id,
      );
      break;
    }
    case "DECIDE": {
      const request = store.approvals.find(
        (value) => value.id === command.approvalId,
      );
      requireThat(
        request && request.dayId === day.id,
        "Approval not found in this business day.",
      );
      requireThat(
        canApprove(actor, request),
        "Independent authorized review required; duplicate decisions are not allowed.",
        403,
      );
      if (command.decision === "REJECTED") {
        requireThat(
          command.reason && command.reason.length >= 3,
          "Give a reason for rejection.",
        );
        request.status = "REJECTED";
        request.rejectionReason = command.reason;
      } else {
        validateEntry(store, request);
        request.votes.push({
          staffId: actor.id,
          username: actor.username,
          role: actor.role,
          time,
        });
        const complete =
          request.approvalLevel !== "DUAL" ||
          (request.votes.length >= 2 &&
            request.votes.some((vote) => vote.role === "ADMIN"));
        if (complete) {
          postEntry(store, request, time);
          request.status = "APPROVED";
        }
      }
      if (request.status !== "PENDING") {
        request.decidedAt = time;
        request.decidedBy = actor.username;
      }
      audit(
        store,
        actor,
        time,
        command.decision === "REJECTED"
          ? "Rejected request"
          : "Approved request",
        request.id,
        command.reason || request.riskReason,
        "PENDING",
        request.status,
      );
      break;
    }
    case "CLOSE_DAY": {
      permit(actor, supervisors);
      requireThat(
        !command.dayId || command.dayId === day.id,
        "The active business day changed. Reopen the closing form and review its totals.",
        409,
      );
      requireThat(
        !store.sessions.some((session) => session.status === "ACTIVE"),
        "Check out all active players before closing.",
      );
      requireThat(
        !store.approvals.some((request) => request.status === "PENDING"),
        "Resolve all pending approvals before closing.",
      );
      const totals = totalsForDay(store);
      const variance = command.countedCash - totals.expectedCash;
      requireThat(
        variance === 0 || command.reason.length >= 3,
        "Explain the cash variance before closing.",
      );
      day.closes.push({
        time,
        actor: actor.username,
        countedCash: command.countedCash,
        expectedCash: totals.expectedCash,
        variance,
        reason: command.reason,
      });
      day.status = "CLOSED";
      audit(
        store,
        actor,
        time,
        "Closed day",
        day.id,
        command.reason || "Cash reconciled",
        "OPEN",
        JSON.stringify(day.closes.at(-1)),
      );
      break;
    }
  }
  return store;
}

function validateEntry(store: Store, request: ApprovalRequest) {
  const profile = store.profiles.find(
    (player) => player.id === request.playerId,
  );
  const session = store.sessions.find(
    (value) => value.id === request.sessionId,
  );
  if (request.type === "Reversal") {
    const tx = store.transactions.find(
      (value) => value.id === request.reversesId,
    );
    requireThat(
      tx && !store.transactions.some((value) => value.reversesId === tx.id),
      "Transaction was already reversed.",
    );
    if (tx.playerId)
      requireThat(
        debt(store, tx.playerId) - tx.creditDelta >= 0,
        "Reverse later settlements before reversing this credit entry.",
      );
    if (profile?.type === "CREDIT" && tx.creditDelta < 0) {
      const reserved = reservedCredit(store, profile.id);
      requireThat(
        debt(store, profile.id) - tx.creditDelta + reserved <=
          profile.creditLimit,
        "Reversal would exceed the credit limit, including pending buy-ins.",
      );
    }
    if (tx.type === "Buy-in")
      requireThat(
        session?.status === "ACTIVE",
        "Reverse the cash-out before reversing a buy-in.",
      );
    if (tx.type === "Cash-out") {
      requireThat(
        session &&
          !store.sessions.some(
            (value) =>
              value.playerId === tx.playerId &&
              value.id !== session.id &&
              value.sessionStart >= session.sessionStart,
          ),
        "A later session prevents reopening this session.",
      );
      ensureSeat(store, session.tableId, session.seat, session.id);
    }
    return;
  }
  if (request.type === "Buy-in" || request.type === "Cash-out") {
    requireThat(
      profile &&
        session?.status === "ACTIVE" &&
        session.dayId === request.dayId &&
        session.tableId === request.tableId,
      "Player session changed; reject this request and create a new one.",
    );
    if (request.type === "Buy-in") {
      requireThat(!profile.tags.includes("Banned"), "This player is banned.");
      requireThat(
        profile.type !== "CREDIT" ||
          debt(store, profile.id) + request.amount <= profile.creditLimit,
        "Credit limit would be exceeded.",
      );
    } else {
      requireThat(
        !store.approvals.some(
          (value) =>
            value.sessionId === session.id &&
            value.id !== request.id &&
            value.status === "PENDING",
        ),
        "Resolve other session requests first.",
      );
    }
  }
  if (request.type === "Credit Repayment")
    requireThat(
      profile?.type === "CREDIT" && request.amount <= debt(store, profile.id),
      "Repayment cannot exceed outstanding credit.",
    );
  if (request.tableId)
    requireThat(
      store.tables.some(
        (table) => table.id === request.tableId && table.status === "OPEN",
      ),
      "The table is closed.",
    );
}

function postEntry(store: Store, request: ApprovalRequest, time: string) {
  requireThat(
    !store.transactions.some((tx) => tx.approvalId === request.id),
    "This request was already posted.",
  );
  const tx: Transaction = {
    id: uid("TX"),
    dayId: request.dayId,
    type: request.type,
    amount: request.amount,
    playerId: request.playerId,
    tableId: request.tableId,
    sessionId: request.sessionId,
    staff: request.staff,
    staffId: request.requestedById,
    cashReceived: 0,
    cashPayout: 0,
    creditDelta: 0,
    time,
    note: request.note,
    approvalId: request.id,
  };
  Object.assign(tx, ledgerImpact(store, request));
  const session = store.sessions.find(
    (value) => value.id === request.sessionId,
  );
  if (request.type === "Reversal") {
    const original = store.transactions.find(
      (value) => value.id === request.reversesId,
    )!;
    tx.reversesId = original.id;
    if (original.type === "Cash-out" && session) {
      session.status = "ACTIVE";
      delete session.sessionEnd;
    }
  } else if (request.type === "Cash-out" && session) {
    session.status = "OUT";
    session.sessionEnd = time;
  }
  store.transactions.unshift(tx);
}
