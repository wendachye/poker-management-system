import type { ApprovalRequest, Store, Transaction, TxType } from "./model";
import { ledgerImpact } from "./ledger-impact";
import { MAX_MONEY } from "./money";
import { emptyStore } from "./selectors";

export type FinancialIntegrityCode =
  | "INCOMPLETE_STORE"
  | "RECORD_ID"
  | "DUPLICATE_RECORD"
  | "REFERENCE"
  | "PROFILE_FINANCE"
  | "DAY_LIFECYCLE"
  | "SESSION_LIFECYCLE"
  | "REQUEST_FINANCE"
  | "APPROVAL_REVIEW"
  | "APPROVAL_POSTING"
  | "LEDGER_LINK"
  | "LEDGER_IMPACT"
  | "REVERSAL_LINK"
  | "DEBT_BALANCE"
  | "CREDIT_RESERVATION"
  | "CLOSING_TOTAL"
  | "UNSAFE_TOTAL";

/** Diagnostics identify the invariant and technical record, never names or amounts. */
export class FinancialIntegrityError extends Error {
  constructor(
    readonly code: FinancialIntegrityCode,
    readonly entityId?: string,
  ) {
    super(`Financial integrity check failed (${code}).`);
    this.name = "FinancialIntegrityError";
  }
}

function requireIntegrity(
  condition: unknown,
  code: FinancialIntegrityCode,
  entityId?: string,
): asserts condition {
  if (!condition) throw new FinancialIntegrityError(code, entityId);
}

const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
const zero = BigInt(0);
function safe(value: bigint, entityId?: string) {
  requireIntegrity(
    value >= -maxSafe && value <= maxSafe,
    "UNSAFE_TOTAL",
    entityId,
  );
  return value;
}
function money(value: number, signed = false, entityId?: string) {
  requireIntegrity(
    Number.isSafeInteger(value) &&
      value >= (signed ? -MAX_MONEY : 0) &&
      value <= MAX_MONEY,
    "REQUEST_FINANCE",
    entityId,
  );
  return BigInt(value);
}
function records<T extends { id: string }>(rows: T[]) {
  const result = new Map<string, T>();
  for (const row of rows) {
    requireIntegrity(
      row && typeof row.id === "string" && row.id.length,
      "RECORD_ID",
    );
    requireIntegrity(!result.has(row.id), "DUPLICATE_RECORD", row.id);
    result.set(row.id, row);
  }
  return result;
}
function timestamp(value: string | undefined) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
const types = new Set<TxType>([
  "Buy-in",
  "Cash-out",
  "Credit Repayment",
  "Rake",
  "Tips",
  "Insurance Premium",
  "Insurance Payout",
  "Jackpot Contribution",
  "Jackpot Payout",
  "Cash Received",
  "Cash Payout",
  "Reversal",
]);

/** Complete authoritative history only. Scoped/UI stores deliberately fail closed. */
export function assertFinancialIntegrity(store: Store): void {
  requireIntegrity(
    store?.schemaVersion === 1 &&
      store.readModel === undefined &&
      [
        store.profiles,
        store.tables,
        store.days,
        store.sessions,
        store.approvals,
        store.transactions,
        store.auditLogs,
      ].every(Array.isArray),
    "INCOMPLETE_STORE",
  );
  const profiles = records(store.profiles),
    tables = records(store.tables),
    days = records(store.days),
    sessions = records(store.sessions),
    approvals = records(store.approvals),
    transactions = records(store.transactions);
  records(store.auditLogs);
  const current =
    store.currentDayId === null ? undefined : days.get(store.currentDayId);
  requireIntegrity(
    days.size
      ? current &&
          current.date ===
            [...days.values()].reduce(
              (latest, day) => (day.date > latest ? day.date : latest),
              "",
            )
      : store.currentDayId === null,
    "DAY_LIFECYCLE",
    store.currentDayId ?? undefined,
  );
  const dates = new Set<string>();
  for (const profile of profiles.values()) {
    money(profile.creditLimit, false, profile.id);
    requireIntegrity(
      profile.type === "CREDIT" ||
        (profile.type === "CASH" && profile.creditLimit === 0),
      "PROFILE_FINANCE",
      profile.id,
    );
  }
  for (const day of days.values()) {
    money(day.openingCash, false, day.id);
    requireIntegrity(
      /^\d{4}-\d{2}-\d{2}$/.test(day.date) &&
        timestamp(day.date + "T00:00:00Z") &&
        new Date(day.date + "T00:00:00Z").toISOString().slice(0, 10) ===
          day.date &&
        !dates.has(day.date) &&
        timestamp(day.openedAt) &&
        (day.status === "CLOSED" ||
          (day.status === "OPEN" && day.id === current?.id)) &&
        Array.isArray(day.closes) &&
        (day.status !== "CLOSED" || day.closes.length > 0),
      "DAY_LIFECYCLE",
      day.id,
    );
    dates.add(day.date);
    for (const close of day.closes) {
      const counted = money(close.countedCash, false, day.id);
      requireIntegrity(
        Number.isSafeInteger(close.expectedCash) &&
          Number.isSafeInteger(close.variance) &&
          timestamp(close.time),
        "CLOSING_TOTAL",
        day.id,
      );
      requireIntegrity(
        counted - BigInt(close.expectedCash) === BigInt(close.variance) &&
          (close.variance === 0 ||
            (typeof close.reason === "string" &&
              close.reason.trim().length >= 3)),
        "CLOSING_TOTAL",
        day.id,
      );
    }
  }
  const activePlayers = new Set<string>(),
    activeSeats = new Set<string>();
  for (const visit of sessions.values()) {
    requireIntegrity(
      profiles.has(visit.playerId) &&
        days.has(visit.dayId) &&
        tables.has(visit.tableId),
      "REFERENCE",
      visit.id,
    );
    requireIntegrity(
      Number.isInteger(visit.seat) &&
        visit.seat >= 1 &&
        visit.seat <= 9 &&
        timestamp(visit.sessionStart),
      "SESSION_LIFECYCLE",
      visit.id,
    );
    if (visit.status === "ACTIVE") {
      const seat = JSON.stringify([visit.tableId, visit.seat]);
      requireIntegrity(
        visit.dayId === current?.id &&
          current.status === "OPEN" &&
          tables.get(visit.tableId)?.status === "OPEN" &&
          visit.sessionEnd === undefined &&
          !activePlayers.has(visit.playerId) &&
          !activeSeats.has(seat),
        "SESSION_LIFECYCLE",
        visit.id,
      );
      activePlayers.add(visit.playerId);
      activeSeats.add(seat);
    } else
      requireIntegrity(
        visit.status === "OUT" && timestamp(visit.sessionEnd),
        "SESSION_LIFECYCLE",
        visit.id,
      );
  }
  function links(entry: ApprovalRequest | Transaction) {
    requireIntegrity(
      days.has(entry.dayId) &&
        (!entry.playerId || profiles.has(entry.playerId)) &&
        (!entry.tableId || tables.has(entry.tableId)),
      "REFERENCE",
      entry.id,
    );
    const visit = entry.sessionId ? sessions.get(entry.sessionId) : undefined;
    requireIntegrity(
      !entry.sessionId ||
        (visit &&
          visit.playerId === entry.playerId &&
          visit.dayId === entry.dayId),
      "LEDGER_LINK",
      entry.id,
    );
    requireIntegrity(
      !["Buy-in", "Cash-out"].includes(entry.type) ||
        (visit && entry.playerId && entry.tableId),
      "LEDGER_LINK",
      entry.id,
    );
    requireIntegrity(
      entry.type !== "Credit Repayment" ||
        (entry.playerId &&
          profiles.get(entry.playerId)?.type === "CREDIT" &&
          !entry.sessionId),
      "LEDGER_LINK",
      entry.id,
    );
    requireIntegrity(
      ![
        "Rake",
        "Tips",
        "Insurance Premium",
        "Insurance Payout",
        "Jackpot Contribution",
        "Jackpot Payout",
      ].includes(entry.type) || entry.tableId,
      "LEDGER_LINK",
      entry.id,
    );
    requireIntegrity(types.has(entry.type), "LEDGER_LINK", entry.id);
    requireIntegrity(
      entry.type === "Reversal"
        ? !!entry.reversesId
        : entry.reversesId === undefined,
      "REVERSAL_LINK",
      entry.id,
    );
  }
  const posted = new Map<string, Transaction>(),
    reversed = new Map<string, Transaction>();
  for (const tx of transactions.values()) {
    links(tx);
    for (const value of [
      tx.amount,
      tx.cashReceived,
      tx.cashPayout,
      tx.creditDelta,
    ])
      money(value, true, tx.id);
    requireIntegrity(
      timestamp(tx.time) && !posted.has(tx.approvalId),
      "APPROVAL_POSTING",
      tx.id,
    );
    posted.set(tx.approvalId, tx);
    const request = approvals.get(tx.approvalId);
    requireIntegrity(
      request && request.status === "APPROVED",
      "APPROVAL_POSTING",
      tx.id,
    );
    requireIntegrity(
      tx.type === request.type &&
        tx.dayId === request.dayId &&
        tx.playerId === request.playerId &&
        tx.sessionId === request.sessionId &&
        tx.tableId === request.tableId &&
        tx.reversesId === request.reversesId &&
        tx.staffId === request.requestedById &&
        tx.staff === request.staff &&
        tx.note === request.note &&
        tx.time === request.decidedAt,
      "LEDGER_LINK",
      tx.id,
    );
    if (tx.reversesId) {
      requireIntegrity(!reversed.has(tx.reversesId), "REVERSAL_LINK", tx.id);
      reversed.set(tx.reversesId, tx);
    }
  }
  const pendingCredit = new Map<string, bigint>(),
    pendingReversals = new Set<string>();
  for (const request of approvals.values()) {
    links(request);
    money(request.amount, false, request.id);
    requireIntegrity(
      request.amount > 0 || ["Cash-out", "Reversal"].includes(request.type),
      "REQUEST_FINANCE",
      request.id,
    );
    requireIntegrity(
      timestamp(request.createdAt) &&
        request.staff === request.requestedBy &&
        request.requestedById &&
        Array.isArray(request.votes) &&
        ["MANAGER", "ADMIN", "DUAL"].includes(request.approvalLevel),
      "APPROVAL_REVIEW",
      request.id,
    );
    const voters = new Set<string>();
    let complete = false,
      hasAdmin = false;
    for (const vote of request.votes) {
      requireIntegrity(
        !complete &&
          vote.staffId &&
          vote.staffId !== request.requestedById &&
          !voters.has(vote.staffId) &&
          ["ADMIN", "MANAGER"].includes(vote.role) &&
          (request.approvalLevel !== "ADMIN" || vote.role === "ADMIN") &&
          typeof vote.username === "string" &&
          vote.username.length &&
          timestamp(vote.time),
        "APPROVAL_REVIEW",
        request.id,
      );
      voters.add(vote.staffId);
      hasAdmin ||= vote.role === "ADMIN";
      complete =
        request.approvalLevel === "DUAL" ? voters.size >= 2 && hasAdmin : true;
    }
    if (request.status === "APPROVED") {
      const last = request.votes.at(-1);
      requireIntegrity(
        complete &&
          last &&
          request.decidedBy === last.username &&
          request.decidedAt === last.time &&
          request.rejectionReason === undefined,
        "APPROVAL_REVIEW",
        request.id,
      );
      requireIntegrity(posted.has(request.id), "APPROVAL_POSTING", request.id);
    } else {
      requireIntegrity(
        !posted.has(request.id) && !complete,
        "APPROVAL_POSTING",
        request.id,
      );
      if (request.status === "PENDING") {
        requireIntegrity(
          request.dayId === current?.id &&
            current.status === "OPEN" &&
            request.decidedAt === undefined &&
            request.decidedBy === undefined &&
            request.rejectionReason === undefined,
          "DAY_LIFECYCLE",
          request.id,
        );
        const ordinaryVisit = ["Buy-in", "Cash-out"].includes(request.type);
        const reversesBuyIn =
          request.reversesId &&
          transactions.get(request.reversesId)?.type === "Buy-in";
        if (ordinaryVisit || reversesBuyIn) {
          const visit = request.sessionId
            ? sessions.get(request.sessionId)
            : undefined;
          requireIntegrity(
            visit?.status === "ACTIVE" &&
              (!ordinaryVisit || visit.tableId === request.tableId),
            "SESSION_LIFECYCLE",
            request.id,
          );
        }
        if (
          request.type === "Buy-in" &&
          request.playerId &&
          profiles.get(request.playerId)?.type === "CREDIT"
        )
          pendingCredit.set(
            request.playerId,
            (pendingCredit.get(request.playerId) ?? zero) +
              BigInt(request.amount),
          );
        if (request.reversesId) {
          requireIntegrity(
            !pendingReversals.has(request.reversesId) &&
              !reversed.has(request.reversesId),
            "REVERSAL_LINK",
            request.id,
          );
          pendingReversals.add(request.reversesId);
        }
      } else
        requireIntegrity(
          request.status === "REJECTED" &&
            timestamp(request.decidedAt) &&
            request.decidedBy &&
            request.decidedBy !== request.requestedBy &&
            typeof request.rejectionReason === "string" &&
            request.rejectionReason.trim().length >= 3,
          "APPROVAL_REVIEW",
          request.id,
        );
    }
    if (request.reversesId) {
      const original = transactions.get(request.reversesId);
      requireIntegrity(
        original &&
          original.type !== "Reversal" &&
          !original.reversesId &&
          request.dayId === original.dayId &&
          request.playerId === original.playerId &&
          request.sessionId === original.sessionId &&
          request.tableId === original.tableId &&
          request.amount === original.amount,
        "REVERSAL_LINK",
        request.id,
      );
    }
  }

  // This private replay context carries only independently reconstructed debt.
  // Posting order is the retained newest-first ledger array, not wall-clock time.
  const balances: Record<string, number> = Object.fromEntries(
    [...profiles.keys()].map((id) => [id, 0]),
  );
  const replay: Store = {
    ...emptyStore(),
    readModel: {
      server: true,
      balances,
      playerDay: {},
      totals: {},
      tableTotals: {},
      outstandingCredit: 0,
      pendingTotal: 0,
      pendingCurrent: 0,
      adminReview: 0,
      reviewable: 0,
      pendingPlayers: {},
      reservedCredit: {},
    },
  };
  const seen = new Map<string, Transaction>(),
    settledSessions = new Map<string, Set<string>>();
  const sums = new Map<string, bigint[]>();
  function accumulate(key: unknown[], values: bigint[]) {
    const id = JSON.stringify(key),
      total = sums.get(id) ?? Array<bigint>(9).fill(zero);
    for (let index = 0; index < values.length; index++)
      total[index] += values[index];
    sums.set(id, total);
  }
  for (let index = store.transactions.length - 1; index >= 0; index--) {
    const tx = store.transactions[index],
      request = approvals.get(tx.approvalId)!;
    const original = tx.reversesId ? seen.get(tx.reversesId) : undefined;
    requireIntegrity(
      !tx.reversesId || (original && original.type !== "Reversal"),
      "REVERSAL_LINK",
      tx.id,
    );
    if (tx.sessionId) {
      const settled = settledSessions.get(tx.sessionId) ?? new Set<string>();
      if (
        ["Buy-in", "Cash-out"].includes(tx.type) ||
        original?.type === "Buy-in"
      )
        requireIntegrity(settled.size === 0, "SESSION_LIFECYCLE", tx.id);
      if (original?.type === "Cash-out")
        requireIntegrity(
          settled.size === 1 && settled.has(original.id),
          "SESSION_LIFECYCLE",
          tx.id,
        );
    }
    const profile = tx.playerId ? profiles.get(tx.playerId) : undefined;
    replay.profiles = profile ? [profile] : [];
    replay.transactions = original ? [original] : [];
    const expected = ledgerImpact(replay, request);
    requireIntegrity(
      ["amount", "cashReceived", "cashPayout", "creditDelta"].every(
        (key) =>
          tx[key as keyof typeof expected] ===
          expected[key as keyof typeof expected],
      ),
      "LEDGER_IMPACT",
      tx.id,
    );
    if (tx.playerId) {
      const next = safe(
        BigInt(balances[tx.playerId]) + BigInt(tx.creditDelta),
        tx.id,
      );
      requireIntegrity(next >= zero, "DEBT_BALANCE", tx.id);
      balances[tx.playerId] = Number(next);
    }
    if (
      tx.sessionId &&
      (tx.type === "Cash-out" || original?.type === "Cash-out")
    ) {
      const settled = settledSessions.get(tx.sessionId) ?? new Set<string>();
      if (original) settled.delete(original.id);
      else settled.add(tx.id);
      settledSessions.set(tx.sessionId, settled);
    }
    const type = original?.type ?? tx.type,
      amount = BigInt(tx.amount);
    const values = [
      type === "Buy-in" ? amount : zero,
      type === "Cash-out" ? amount : zero,
      type === "Rake" ? amount : zero,
      type === "Tips" ? amount : zero,
      type === "Insurance Premium"
        ? amount
        : type === "Insurance Payout"
          ? -amount
          : zero,
      type === "Jackpot Contribution"
        ? amount
        : type === "Jackpot Payout"
          ? -amount
          : zero,
      BigInt(tx.cashReceived),
      BigInt(tx.cashPayout),
      BigInt(tx.creditDelta),
    ];
    accumulate(["VENUE"], values);
    accumulate(["DAY", tx.dayId], values);
    if (tx.playerId) {
      accumulate(["PLAYER", tx.playerId], values);
      accumulate(["PLAYER_DAY", tx.playerId, tx.dayId], values);
    }
    if (tx.tableId) accumulate(["TABLE_DAY", tx.tableId, tx.dayId], values);
    seen.set(tx.id, tx);
  }
  for (const total of sums.values()) for (const value of total) safe(value);
  for (const profile of profiles.values()) {
    const reserved = safe(pendingCredit.get(profile.id) ?? zero, profile.id);
    requireIntegrity(
      BigInt(balances[profile.id]) + reserved <= BigInt(profile.creditLimit),
      "CREDIT_RESERVATION",
      profile.id,
    );
  }
  for (const visit of sessions.values()) {
    const settled = settledSessions.get(visit.id) ?? new Set<string>();
    requireIntegrity(
      settled.size === (visit.status === "OUT" ? 1 : 0),
      "SESSION_LIFECYCLE",
      visit.id,
    );
    if (visit.status === "OUT")
      requireIntegrity(
        transactions.get([...settled][0])?.time === visit.sessionEnd,
        "SESSION_LIFECYCLE",
        visit.id,
      );
  }
  for (const day of days.values()) {
    const totals = sums.get(JSON.stringify(["DAY", day.id]));
    const expected = safe(
      BigInt(day.openingCash) + (totals?.[6] ?? zero) - (totals?.[7] ?? zero),
      day.id,
    );
    if (day.status === "CLOSED")
      requireIntegrity(
        BigInt(day.closes.at(-1)!.expectedCash) === expected,
        "CLOSING_TOTAL",
        day.id,
      );
  }
}
