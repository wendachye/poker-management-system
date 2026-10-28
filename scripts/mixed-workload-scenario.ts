import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { Pool } from "pg";
import type { Command } from "../src/domain/commands";
import type { Snapshot, Staff } from "../src/domain/model";
import type { ReadQuery } from "../src/domain/read-model";
import { DomainError } from "../src/domain/operations";
import { debt, emptyStore, totalsForDay } from "../src/domain/selectors";
import { defaultSettings } from "../src/domain/settings";
import { login } from "../src/server/auth";
import {
  capacityLimits,
  capacityOptions,
  latencySummary,
} from "../src/server/capacity-target";
import { databaseFromPool, type Database } from "../src/server/database";
import { databasePoolErrorCode } from "../src/server/database-options";
import { readOperationalSnapshot, readPage } from "../src/server/queries";
import { mutate } from "../src/server/repository";
import { readStore, replaceStore } from "../src/server/storage";

type Environment = Readonly<Record<string, string | undefined>>;
export const mixedLimits = {
  venues: [2, capacityLimits.venues],
  staffPerVenue: capacityLimits.staffPerVenue,
  totalWorkers: capacityLimits.totalWorkers,
  retainedEntriesPerVenue: capacityLimits.retainedEntriesPerVenue,
  cycles: 10,
  readRoundsPerReader: 100,
  readersPerVenue: 5,
} as const;
export function mixedOptions(env: Environment) {
  const integer = (key: string, fallback: number, maximum: number) => {
    const raw = env[key] ?? String(fallback);
    if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > maximum)
      throw new Error(`${key} must be an integer from 1 to ${maximum}.`);
    return Number(raw);
  };
  const venues = integer("MIXED_VENUES", 2, 5);
  if (venues !== 2 && venues !== 5)
    throw new Error("MIXED_VENUES must be 2 or 5.");
  const retained = integer("MIXED_RETAINED_ENTRIES", 1000, 20_000);
  const limits = capacityOptions({
    CAPACITY_VENUES: String(venues),
    CAPACITY_STAFF_PER_VENUE: "10",
    CAPACITY_ENTRY_COUNTS: String(retained),
  });
  return {
    venues,
    staffPerVenue: limits.staffPerVenue,
    workers: limits.workers,
    retainedEntriesPerVenue: retained,
    cycles: integer("MIXED_CYCLES", 2, mixedLimits.cycles),
    readRoundsPerReader: integer(
      "MIXED_READ_ROUNDS",
      20,
      mixedLimits.readRoundsPerReader,
    ),
    readersPerVenue: 5,
    readPauseMs: 25,
  };
}
export type MixedOptions = ReturnType<typeof mixedOptions>;
export class MixedInvariant extends Error {
  constructor(readonly check: string) {
    super(check);
  }
}
export function invariant(value: unknown, check: string): asserts value {
  if (!value) throw new MixedInvariant(check);
}
export function errorCategory(error: unknown) {
  if (error instanceof DomainError) return `HTTP_${error.status}`;
  if (error instanceof MixedInvariant) return `INVARIANT_${error.check}`;
  return databasePoolErrorCode(error);
}
export type Measurement = {
  action: string;
  mode: "ordinary" | "deliberate-race" | "isolation";
  ms: number;
  bytes?: number;
  outcome: "success" | "expected-conflict" | "expected-denial" | "error";
  error?: string;
};
export function summarizeMeasurements(rows: Measurement[]) {
  const actions = [...new Set(rows.map((row) => `${row.mode}:${row.action}`))];
  return actions.map((key) => {
    const samples = rows.filter((row) => `${row.mode}:${row.action}` === key);
    const sizes = samples.flatMap((row) =>
      row.bytes === undefined ? [] : [row.bytes],
    );
    const errors: Record<string, number> = {};
    for (const sample of samples)
      if (sample.outcome === "error")
        errors[sample.error ?? "UNKNOWN"] =
          (errors[sample.error ?? "UNKNOWN"] ?? 0) + 1;
    return {
      action: samples[0].action,
      mode: samples[0].mode,
      latency: latencySummary(samples.map((row) => row.ms)),
      successfulLatency: latencySummary(
        samples.filter((row) => row.outcome === "success").map((row) => row.ms),
      ),
      successes: samples.filter((row) => row.outcome === "success").length,
      expectedConflicts: samples.filter(
        (row) => row.outcome === "expected-conflict",
      ).length,
      expectedDenials: samples.filter(
        (row) => row.outcome === "expected-denial",
      ).length,
      errors,
      responseBytes: {
        samples: sizes.length,
        min: sizes.length ? Math.min(...sizes) : null,
        max: sizes.length ? Math.max(...sizes) : null,
      },
    };
  });
}

export function mixedHistory(
  branchId: string,
  staff: Staff[],
  retained: number,
) {
  const store = emptyStore();
  store.settings = {
    ...defaultSettings(),
    setupCompleted: true,
    venueName: branchId,
    smallBlind: 500,
    bigBlind: 1000,
    minBuyIn: 20_000,
    maxBuyIn: 500_000,
    buyInStep: 5000,
  };
  store.tables = ["main", "reserve"].map((name) => ({
    id: `${branchId}_${name}`,
    name: `Fictional ${name}`,
    status: "OPEN" as const,
    dealer: "",
  }));
  store.profiles = Array.from({ length: 100 }, (_, index) => ({
    id: `${branchId}_profile_${index}`,
    name: `Fictional retained player ${index}`,
    phone: `+1202${String(index).padStart(7, "0")}`,
    type: "CASH" as const,
    creditLimit: 0,
    tags: [],
  }));
  const dayId = `${branchId}_history`;
  store.currentDayId = dayId;
  store.days = [
    {
      id: dayId,
      date: "2026-01-01",
      openedAt: "2026-01-01T00:00:00.000Z",
      openingCash: 1_000_000,
      status: "CLOSED",
      closes: [
        {
          time: "2026-01-01T23:59:00.000Z",
          actor: staff[1].username,
          countedCash: 1_000_000 + retained * 100,
          expectedCash: 1_000_000 + retained * 100,
          variance: 0,
          reason: "Fictional retained history",
        },
      ],
    },
  ];
  for (let index = 0; index < retained; index++) {
    const time = new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString();
    const approvalId = `${branchId}_approval_${index}`;
    const txId = `${branchId}_ledger_${index}`;
    store.approvals.push({
      id: approvalId,
      dayId,
      type: "Rake",
      amount: 100,
      tableId: store.tables[0].id,
      staff: staff[3].username,
      note: "Fictional retained house entry",
      status: "APPROVED",
      approvalLevel: "MANAGER",
      riskReason: "Independent review",
      requestedBy: staff[3].username,
      requestedById: staff[3].id,
      createdAt: time,
      decidedBy: staff[1].username,
      decidedAt: time,
      votes: [
        {
          staffId: staff[1].id,
          username: staff[1].username,
          role: "MANAGER",
          time,
        },
      ],
    });
    store.transactions.push({
      id: txId,
      dayId,
      type: "Rake",
      tableId: store.tables[0].id,
      amount: 100,
      cashReceived: 100,
      cashPayout: 0,
      creditDelta: 0,
      staff: staff[3].username,
      staffId: staff[3].id,
      note: "Fictional retained house entry",
      time,
      approvalId,
    });
    for (const [suffix, actor, action, entity] of [
      ["request", staff[3], "Requested transaction", approvalId],
      ["post", staff[1], "Posted transaction", txId],
    ] as const)
      store.auditLogs.push({
        id: `${branchId}_${suffix}_${index}`,
        actor: actor.username,
        actorId: actor.id,
        action,
        entity,
        time,
        reason: "Fictional retained house entry",
      });
  }
  return store;
}

type Worker = { staff: Staff; token: string };
export type Venue = {
  id: string;
  index: number;
  workers: Worker[];
  successfulOperations: Set<string>;
  failedOperations: Set<string>;
};
export async function seedMixed(
  db: Database,
  options: MixedOptions,
  password: string,
  passwordHash: string,
) {
  const venues: Venue[] = [];
  for (let index = 0; index < options.venues; index++) {
    const id = `mixed_venue_${index}`;
    const staff: Staff[] = Array.from({ length: 10 }, (_, number) => ({
      id: `${id}_staff_${number}`,
      username: `${id}_staff_${number}`,
      branchId: id,
      role:
        number === 0
          ? "ADMIN"
          : number < 3 || number === 5
            ? "MANAGER"
            : "CASHIER",
    }));
    await db.transaction(async (connection) => {
      await connection.query(
        "INSERT INTO poker_branches(id,name) VALUES($1,$1)",
        [id],
      );
      for (const person of staff) {
        await connection.query(
          "INSERT INTO poker_users(id,username,password_hash) VALUES($1,$1,$2)",
          [person.id, passwordHash],
        );
        await connection.query(
          "INSERT INTO poker_memberships(user_id,branch_id,role) VALUES($1,$2,$3)",
          [person.id, id, person.role],
        );
      }
      await replaceStore(
        connection,
        id,
        mixedHistory(id, staff, options.retainedEntriesPerVenue),
      );
    });
    const workers: Worker[] = [];
    for (const person of staff)
      workers.push({
        staff: person,
        token: await login(db, person.username, password),
      });
    venues.push({
      id,
      index,
      workers,
      successfulOperations: new Set(),
      failedOperations: new Set(),
    });
  }
  return venues;
}

export function mixedRunner(db: Database, measurements: Measurement[]) {
  async function measure<T>(
    action: string,
    run: () => Promise<T>,
    mode: Measurement["mode"] = "ordinary",
    expectedStatus?: number,
  ): Promise<T> {
    const started = performance.now();
    try {
      const result = await run();
      const bytes = Buffer.byteLength(JSON.stringify(result), "utf8");
      measurements.push({
        action,
        mode,
        ms: performance.now() - started,
        outcome: "success",
        bytes,
      });
      return result;
    } catch (error) {
      const expected =
        ((mode === "deliberate-race" && expectedStatus === 409) ||
          (mode === "isolation" && expectedStatus === 404)) &&
        error instanceof DomainError &&
        error.status === expectedStatus;
      measurements.push({
        action,
        mode,
        ms: performance.now() - started,
        outcome: expected
          ? expectedStatus === 409
            ? "expected-conflict"
            : "expected-denial"
          : "error",
        error: errorCategory(error),
      });
      throw error;
    }
  }
  function snapshot(worker: Worker) {
    return db.transaction(async (connection) => {
      await connection.query(
        "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      return readOperationalSnapshot(connection, worker.token);
    });
  }
  async function payload(venue: Venue, worker: number, command: Command) {
    return {
      branchId: venue.id,
      actorId: venue.workers[worker].staff.id,
      revision: (await snapshot(venue.workers[worker])).revision,
      operationId: randomUUID(),
      command,
    };
  }
  type Payload = Awaited<ReturnType<typeof payload>>;
  async function dispatch(
    venue: Venue,
    worker: number,
    input: Payload,
    action: string,
    database = db,
    mode: Measurement["mode"] = "ordinary",
    expectedStatus?: number,
  ) {
    try {
      const result = await measure(
        action,
        () =>
          mutate(database, venue.workers[worker].token, input, {
            compact: true,
          }),
        mode,
        expectedStatus,
      );
      venue.successfulOperations.add(input.operationId);
      return result;
    } catch (error) {
      venue.failedOperations.add(input.operationId);
      throw error;
    }
  }
  async function send(
    venue: Venue,
    worker: number,
    command: Command,
    action: string = command.kind,
  ) {
    const started = performance.now();
    const input = await payload(venue, worker, command);
    const receipt = await dispatch(venue, worker, input, action);
    measurements.push({
      action: `${action}:including-reviewed-read`,
      mode: "ordinary",
      ms: performance.now() - started,
      outcome: "success",
    });
    return receipt;
  }
  async function request(
    venue: Venue,
    command: Extract<Command, { kind: "REQUEST" }>,
    worker = 3,
  ) {
    const receipt = await send(
      venue,
      worker,
      command,
      `request:${command.type}`,
    );
    const approval = receipt.store.approvals.find(
      (row) => row.note === command.note && row.status === "PENDING",
    );
    invariant(approval, "requested-approval-returned");
    return approval.id;
  }
  function decide(
    venue: Venue,
    approvalId: string,
    worker: number,
    decision: "APPROVED" | "REJECTED" = "APPROVED",
  ) {
    return send(
      venue,
      worker,
      {
        kind: "DECIDE",
        approvalId,
        decision,
        ...(decision === "REJECTED"
          ? { reason: "Fictional conflicting reservation rejected" }
          : {}),
      },
      `decision:${decision}`,
    );
  }
  async function journey(venue: Venue, cycle: number, credit: boolean) {
    const lane = credit ? 1 : 0;
    const requester = credit ? 4 : 3;
    const reviewer = credit ? 2 : 1;
    const phone = `+1999${venue.index}${String(cycle).padStart(2, "0")}${lane}01`;
    const checked = await send(
      venue,
      credit ? 0 : requester,
      {
        kind: "CHECK_IN",
        name: `Fictional ${credit ? "credit" : "cash"} ${cycle}`,
        phone,
        type: credit ? "CREDIT" : "CASH",
        creditLimit: credit ? 200_000 : 0,
        tags: [],
        tableId: `${venue.id}_main`,
        seat: lane + 1,
      },
      `check-in:${credit ? "credit" : "cash"}`,
    );
    const player = checked.store.profiles.find((row) => row.phone === phone);
    invariant(player, "checked-in-profile-returned");
    await decide(
      venue,
      await request(
        venue,
        {
          kind: "REQUEST",
          type: "Buy-in",
          playerId: player.id,
          amount: 50_000,
          note: `${phone} buy-in`,
        },
        requester,
      ),
      reviewer,
    );
    if (credit) {
      const repaid = await decide(
        venue,
        await request(
          venue,
          {
            kind: "REQUEST",
            type: "Credit Repayment",
            playerId: player.id,
            amount: 20_000,
            note: `${phone} repayment`,
          },
          requester,
        ),
        reviewer,
      );
      invariant(
        debt(repaid.store, player.id) === 30_000,
        "repayment-reviewed-balance",
      );
    }
    await send(venue, requester, {
      kind: "MOVE",
      playerId: player.id,
      tableId: `${venue.id}_reserve`,
      seat: lane + 1,
    });
    const outId = await request(
      venue,
      {
        kind: "REQUEST",
        type: "Cash-out",
        playerId: player.id,
        amount: 70_000,
        note: `${phone} cash-out`,
      },
      requester,
    );
    const out = await decide(venue, outId, 0);
    const posted = out.store.transactions.find(
      (row) => row.approvalId === outId,
    );
    invariant(
      posted?.cashPayout === (credit ? 40_000 : 70_000),
      "cash-out-reviewed-payout",
    );
    invariant(debt(out.store, player.id) === 0, "cash-out-zero-debt");
    invariant(
      out.store.sessions.some(
        (row) => row.playerId === player.id && row.status === "OUT",
      ),
      "cash-out-releases-visit",
    );
  }
  async function readWorker(
    venue: Venue,
    worker: Worker,
    rounds: number,
    pauseMs: number,
    signal: AbortSignal,
  ) {
    for (let round = 0; round < rounds && !signal.aborted; round++) {
      const queries: [string, ReadQuery][] = [
        [
          "read:players-phone-search",
          { resource: "players", query: "120200000", pageSize: 20 },
        ],
        [
          "read:transactions-history-deep",
          {
            resource: "transactions",
            dayId: `${venue.id}_history`,
            page: 1_000_000,
            pageSize: 20,
          },
        ],
        [
          "read:audit-deep",
          { resource: "audit", page: 1_000_000, pageSize: 20 },
        ],
        [
          "read:current-requests",
          { resource: "requests", status: "PENDING", pageSize: 20 },
        ],
        [
          "read:players-deep",
          { resource: "players", page: 1_000_000, pageSize: 20 },
        ],
      ];
      if (worker.staff.role === "CASHIER")
        queries[2] = [
          "read:requests-history-deep",
          {
            resource: "requests",
            dayId: `${venue.id}_history`,
            status: "APPROVED",
            page: 1_000_000,
            pageSize: 20,
          },
        ];
      if (round % 6 === 0) {
        const result = await measure("read:compact-state", () =>
          snapshot(worker),
        );
        invariant(result.branch.id === venue.id, "snapshot-venue-isolation");
      } else {
        const [label, query] = queries[(round - 1) % queries.length];
        const page = await measure(label, () =>
          readPage(db, worker.token, query),
        );
        invariant(
          page.branchId === venue.id &&
            page.context.branch.id === venue.id &&
            page.items.length <= 20,
          "page-venue-and-size",
        );
      }
      if (!signal.aborted)
        await new Promise((resolve) => setTimeout(resolve, pauseMs));
    }
  }
  return {
    measure,
    snapshot,
    payload,
    dispatch,
    send,
    request,
    decide,
    journey,
    readWorker,
  };
}

/** The small deliberate races use two distinct single-connection pools, queued
 * behind a third native row lock. Their latency includes the barrier hold and
 * is reported separately from ordinary saves. No blind financial conflict retry.
 */
export async function runMixedRaces(
  db: Database,
  holderPool: Pool,
  first: Pool,
  second: Pool,
  runner: ReturnType<typeof mixedRunner>,
  venue: Venue,
) {
  const raceDbs = [databaseFromPool(first), databaseFromPool(second)];
  async function race(
    actions: [() => Promise<Snapshot>, () => Promise<Snapshot>],
  ) {
    const holder = await holderPool.connect();
    let pending: Promise<PromiseSettledResult<Snapshot>[]> | undefined;
    let committed = false;
    let primaryFailure = false;
    try {
      await holder.query("BEGIN");
      await holder.query(
        "SELECT branch_id FROM poker_branch_state WHERE branch_id=$1 FOR UPDATE",
        [venue.id],
      );
      const holderPid = (
        await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
      ).rows[0].pid;
      const pids = await Promise.all(
        [first, second].map(
          async (pool) =>
            (
              await pool.query<{ pid: number }>(
                "SELECT pg_backend_pid() AS pid",
              )
            ).rows[0].pid,
        ),
      );
      invariant(pids[0] !== pids[1], "distinct-race-connections");
      pending = Promise.allSettled(actions.map((action) => action()));
      const deadline = Date.now() + 5000;
      let blocked = false;
      while (Date.now() < deadline) {
        const result = await db.query<{ blocked: boolean }>(
          `WITH RECURSIVE blockers(pid) AS (
          SELECT unnest(pg_blocking_pids($2::int)) UNION SELECT unnest(pg_blocking_pids(blockers.pid)) FROM blockers
        ) SELECT EXISTS(SELECT 1 FROM blockers WHERE pid=$1::int) AS blocked`,
          [holderPid, pids[0]],
        );
        const other = await db.query<{ blocked: boolean }>(
          `WITH RECURSIVE blockers(pid) AS (
          SELECT unnest(pg_blocking_pids($2::int)) UNION SELECT unnest(pg_blocking_pids(blockers.pid)) FROM blockers
        ) SELECT EXISTS(SELECT 1 FROM blockers WHERE pid=$1::int) AS blocked`,
          [holderPid, pids[1]],
        );
        if (result.rows[0].blocked && other.rows[0].blocked) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      invariant(blocked, "both-race-writers-waited-for-row-lock");
      await holder.query("COMMIT");
      committed = true;
      return await pending;
    } catch (error) {
      primaryFailure = true;
      throw error;
    } finally {
      let rollbackFailure: unknown;
      try {
        if (!committed) await holder.query("ROLLBACK");
      } catch (error) {
        rollbackFailure = error;
      } finally {
        // A failed rollback must not strand the row lock or make pool.end wait
        // forever. Destroy that connection, then drain both observed writers.
        holder.release(Boolean(rollbackFailure));
        if (pending) await pending;
      }
      if (rollbackFailure && !primaryFailure) throw rollbackFailure;
    }
  }
  const exactlyOne = (results: PromiseSettledResult<Snapshot>[]) => {
    invariant(
      results.filter((row) => row.status === "fulfilled").length === 1,
      "race-exactly-one-saved",
    );
    const failed = results.find((row) => row.status === "rejected");
    invariant(
      failed?.status === "rejected" &&
        failed.reason instanceof DomainError &&
        failed.reason.status === 409,
      "race-loser-is-reviewed-conflict",
    );
    const winner = results.find((row) => row.status === "fulfilled");
    invariant(winner?.status === "fulfilled", "race-winner-present");
    return winner.value;
  };
  const dispatch =
    (
      worker: number,
      input: Awaited<ReturnType<typeof runner.payload>>,
      index: number,
      label: string,
      expectedStatus?: number,
    ) =>
    () =>
      runner.dispatch(
        venue,
        worker,
        input,
        label,
        raceDbs[index],
        "deliberate-race",
        expectedStatus,
      );
  const rakeCommand: Command = {
    kind: "REQUEST",
    type: "Rake",
    amount: 5000,
    tableId: `${venue.id}_main`,
    note: "Fictional exact-replay rake",
  };
  const replay = await runner.payload(venue, 3, rakeCommand);
  const replayResults = await race([
    dispatch(3, replay, 0, "race:exact-operation-replay"),
    dispatch(3, replay, 1, "race:exact-operation-replay"),
  ]);
  invariant(
    replayResults.every((row) => row.status === "fulfilled"),
    "exact-replay-both-acknowledged",
  );
  let stored = await readStore(db, venue.id);
  const originalRequest = stored.approvals.filter(
    (row) => row.note === rakeCommand.note,
  );
  invariant(originalRequest.length === 1, "exact-replay-one-request");
  invariant(
    (await runner.snapshot(venue.workers[0])).revision === replay.revision + 1,
    "exact-replay-one-revision",
  );
  const approvalId = originalRequest[0].id;
  const approve = await runner.payload(venue, 1, {
    kind: "DECIDE",
    approvalId,
    decision: "APPROVED",
  });
  const beforePosting = {
    entries: stored.transactions.length,
    audit: stored.auditLogs.length,
  };
  const samePosting = await race([
    dispatch(1, approve, 0, "race:exact-posting-replay"),
    dispatch(1, approve, 1, "race:exact-posting-replay"),
  ]);
  invariant(
    samePosting.every((row) => row.status === "fulfilled"),
    "posting-replay-both-acknowledged",
  );
  stored = await readStore(db, venue.id);
  const original = stored.transactions.filter(
    (row) => row.approvalId === approvalId,
  );
  invariant(
    original.length === 1 &&
      stored.approvals.find((row) => row.id === approvalId)?.votes.length === 1,
    "posting-replay-one-post-one-vote",
  );
  invariant(
    stored.transactions.length === beforePosting.entries + 1 &&
      stored.auditLogs.length === beforePosting.audit + 1 &&
      (await runner.snapshot(venue.workers[0])).revision ===
        approve.revision + 1,
    "posting-replay-one-ledger-audit-revision",
  );
  invariant(
    (
      await db.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM poker_operations WHERE branch_id=$1 AND operation_id=$2",
        [venue.id, approve.operationId],
      )
    ).rows[0].count === "1",
    "posting-replay-one-operation",
  );
  const corrected = await runner.send(venue, 3, {
    kind: "CORRECT",
    transactionId: original[0].id,
    reason: "Fictional rake should be RM30",
  });
  const reversal = corrected.store.approvals.find(
    (row) => row.reversesId === original[0].id,
  );
  invariant(reversal, "reversal-request-present");
  await runner.decide(venue, reversal.id, 0);
  const replacementId = await runner.request(venue, {
    kind: "REQUEST",
    type: "Rake",
    amount: 3000,
    tableId: `${venue.id}_main`,
    note: "Fictional RM30 replacement",
  });
  const replacementDecision = await runner.payload(venue, 1, {
    kind: "DECIDE",
    approvalId: replacementId,
    decision: "APPROVED",
  });
  const competing = {
    ...replacementDecision,
    actorId: venue.workers[2].staff.id,
    operationId: randomUUID(),
  };
  exactlyOne(
    await race([
      dispatch(1, replacementDecision, 0, "race:competing-approval", 409),
      dispatch(2, competing, 1, "race:competing-approval", 409),
    ]),
  );
  stored = await readStore(db, venue.id);
  invariant(
    stored.transactions.filter((row) => row.approvalId === replacementId)
      .length === 1 &&
      stored.approvals.find((row) => row.id === replacementId)?.votes.length ===
        1,
    "competing-approval-one-post-one-vote",
  );

  const seatCommand: Command = {
    kind: "CHECK_IN",
    name: "Fictional competing seat A",
    phone: `+1888${venue.index}000001`,
    type: "CASH",
    creditLimit: 0,
    tags: [],
    tableId: `${venue.id}_main`,
    seat: 9,
  };
  const seatFirst = await runner.payload(venue, 3, seatCommand);
  const seatSecond = {
    ...seatFirst,
    actorId: venue.workers[4].staff.id,
    operationId: randomUUID(),
    command: {
      ...seatCommand,
      name: "Fictional competing seat B",
      phone: `+1888${venue.index}000002`,
    },
  };
  const beforeProfiles = stored.profiles.length;
  exactlyOne(
    await race([
      dispatch(3, seatFirst, 0, "race:same-seat", 409),
      dispatch(4, seatSecond, 1, "race:same-seat", 409),
    ]),
  );
  stored = await readStore(db, venue.id);
  const seated = stored.sessions.filter(
    (row) =>
      row.status === "ACTIVE" &&
      row.tableId === seatCommand.tableId &&
      row.seat === 9,
  );
  invariant(
    seated.length === 1 && stored.profiles.length === beforeProfiles + 1,
    "seat-loser-no-orphan-profile",
  );
  await runner.decide(
    venue,
    await runner.request(venue, {
      kind: "REQUEST",
      type: "Cash-out",
      amount: 0,
      playerId: seated[0].playerId,
      note: "Fictional seat-race zero cash-out",
    }),
    0,
  );
  const creditPhone = `+1777${venue.index}000001`;
  const credit = await runner.send(venue, 0, {
    kind: "CHECK_IN",
    name: "Fictional competing credit",
    phone: creditPhone,
    type: "CREDIT",
    creditLimit: 100_000,
    tags: [],
    tableId: `${venue.id}_reserve`,
    seat: 9,
  });
  const creditPlayer = credit.store.profiles.find(
    (row) => row.phone === creditPhone,
  );
  invariant(creditPlayer, "credit-race-player-present");
  const creditFirst = await runner.payload(venue, 3, {
    kind: "REQUEST",
    type: "Buy-in",
    amount: 60_000,
    playerId: creditPlayer.id,
    note: "Fictional reviewed credit reservation",
  });
  const creditSecond = {
    ...creditFirst,
    actorId: venue.workers[4].staff.id,
    operationId: randomUUID(),
  };
  exactlyOne(
    await race([
      dispatch(3, creditFirst, 0, "race:stale-credit-balance", 409),
      dispatch(4, creditSecond, 1, "race:stale-credit-balance", 409),
    ]),
  );
  stored = await readStore(db, venue.id);
  const reservations = stored.approvals.filter(
    (row) => row.playerId === creditPlayer.id && row.status === "PENDING",
  );
  invariant(
    reservations.length === 1 &&
      reservations[0].amount === 60_000 &&
      debt(stored, creditPlayer.id) === 0,
    "credit-reservation-not-overcommitted-or-posted",
  );
  await runner.decide(venue, reservations[0].id, 1, "REJECTED");
  await runner.decide(
    venue,
    await runner.request(venue, {
      kind: "REQUEST",
      type: "Cash-out",
      amount: 0,
      playerId: creditPlayer.id,
      note: "Fictional credit-race zero cash-out",
    }),
    0,
  );
  return {
    barrierVerifiedRaces: 5,
    expectedConflicts: 3,
    exactReplayAcknowledgements: 4,
  };
}

export async function verifyMixedVenue(
  db: Database,
  venue: Venue,
  cycles: number,
  retained: number,
) {
  const store = await readStore(db, venue.id);
  invariant(
    store.sessions.every((row) => row.status === "OUT"),
    "no-active-visits-before-close",
  );
  invariant(
    store.approvals.every((row) => row.status !== "PENDING"),
    "no-pending-requests-before-close",
  );
  const entries = store.transactions.filter(
    (row) => row.dayId === store.currentDayId,
  );
  invariant(entries.length === cycles * 5 + 5, "exact-current-ledger-count");
  invariant(
    store.transactions.length === retained + entries.length,
    "history-preserved",
  );
  invariant(
    new Set(store.transactions.map((row) => row.approvalId)).size ===
      store.transactions.length,
    "one-post-per-approval",
  );
  const originals = store.transactions.filter(
    (row) =>
      row.type === "Rake" &&
      row.dayId === store.currentDayId &&
      row.amount === 5000,
  );
  invariant(
    originals.length === 1 &&
      store.transactions.filter((row) => row.reversesId === originals[0].id)
        .length === 1,
    "one-reversal-per-original",
  );
  invariant(
    store.profiles.every((row) => debt(store, row.id) === 0),
    "all-player-debt-settled",
  );
  const operations = (
    await db.query<{ operation_id: string }>(
      "SELECT operation_id FROM poker_operations WHERE branch_id=$1",
      [venue.id],
    )
  ).rows;
  invariant(
    operations.length === venue.successfulOperations.size &&
      operations.every((row) =>
        venue.successfulOperations.has(row.operation_id),
      ),
    "successful-operation-identifiers-exact",
  );
  invariant(
    operations.every((row) => !venue.failedOperations.has(row.operation_id)),
    "failed-commands-not-recorded",
  );
  const expected = 1_000_000 - cycles * 40_000 + 3000;
  const totals = totalsForDay(store);
  invariant(
    totals.expectedCash === expected,
    "independent-final-cash-arithmetic",
  );
  invariant(
    totals.cashReceived === cycles * 70_000 + 3000 &&
      totals.cashPayout === cycles * 110_000 &&
      totals.buyInTotal === cycles * 100_000 &&
      totals.cashOutTotal === cycles * 140_000 &&
      totals.rake === 3000,
    "independent-gross-cash-and-chip-controls",
  );
  return {
    expectedCashSen: expected,
    activeVisits: 0,
    pendingRequests: 0,
    postedEntries: entries.length,
    successfulOperationIds: operations.length,
    failedOperationIds: venue.failedOperations.size,
  };
}
