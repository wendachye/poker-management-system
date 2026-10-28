import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Store } from "../domain/model";
import { settingsSchema } from "../domain/settings";
import { tableRuleIssue } from "../domain/settings";
import { MAX_MONEY } from "../domain/money";
import type { Database, SqlConnection } from "./database";
import { readStore, replaceStore } from "./storage";

const id = z.string().min(1),
  amount = z.number().int().safe();
const timestamp = z.iso.datetime({ offset: true });
const role = z.enum(["DEALER", "CASHIER", "MANAGER", "ADMIN"]);
const txType = z.enum([
  "Buy-in",
  "Cash-out",
  "Rake",
  "Tips",
  "Insurance Premium",
  "Insurance Payout",
  "Jackpot Contribution",
  "Jackpot Payout",
  "Cash Received",
  "Cash Payout",
  "Credit Repayment",
  "Reversal",
]);
const storeSchema = z
  .object({
    schemaVersion: z.literal(1),
    settings: settingsSchema.optional(),
    currentDayId: id.nullable(),
    profiles: z.array(
      z
        .object({
          id,
          name: z.string(),
          phone: z.string(),
          type: z.enum(["CASH", "CREDIT"]),
          creditLimit: amount.nonnegative(),
          tags: z.array(z.enum(["VIP", "Risk", "Banned"])),
        })
        .strict(),
    ),
    tables: z.array(
      z
        .object({
          id,
          name: z.string(),
          status: z.enum(["OPEN", "CLOSED"]),
          dealer: z.string(),
          smallBlind: amount.positive().max(MAX_MONEY).optional(),
          bigBlind: amount.positive().max(MAX_MONEY).optional(),
          minBuyIn: amount.nonnegative().max(MAX_MONEY).optional(),
          maxBuyIn: amount.positive().max(MAX_MONEY).optional(),
          buyInStep: amount.nonnegative().max(MAX_MONEY).optional(),
        })
        .strict(),
    ),
    sessions: z.array(
      z
        .object({
          id,
          playerId: id,
          dayId: id,
          status: z.enum(["ACTIVE", "OUT"]),
          tableId: id,
          seat: z.number().int().min(1).max(9),
          sessionStart: timestamp,
          sessionEnd: timestamp.optional(),
        })
        .strict(),
    ),
    transactions: z.array(
      z
        .object({
          id,
          dayId: id,
          type: txType,
          playerId: id.optional(),
          sessionId: id.optional(),
          tableId: id.optional(),
          amount,
          staff: z.string(),
          staffId: id,
          cashReceived: amount,
          cashPayout: amount,
          creditDelta: amount,
          time: timestamp,
          note: z.string(),
          reversesId: id.optional(),
          approvalId: id,
        })
        .strict(),
    ),
    approvals: z.array(
      z
        .object({
          id,
          dayId: id,
          type: txType,
          amount: amount.nonnegative(),
          playerId: id.optional(),
          sessionId: id.optional(),
          tableId: id.optional(),
          staff: z.string(),
          note: z.string(),
          status: z.enum(["PENDING", "APPROVED", "REJECTED"]),
          approvalLevel: z.enum(["MANAGER", "ADMIN", "DUAL"]),
          riskReason: z.string(),
          requestedBy: z.string(),
          requestedById: id,
          createdAt: timestamp,
          decidedBy: z.string().optional(),
          decidedAt: timestamp.optional(),
          rejectionReason: z.string().optional(),
          reversesId: id.optional(),
          votes: z.array(
            z
              .object({
                staffId: id,
                username: z.string(),
                role,
                time: timestamp,
              })
              .strict(),
          ),
        })
        .strict(),
    ),
    auditLogs: z.array(
      z
        .object({
          id,
          time: timestamp,
          actor: z.string(),
          actorId: id,
          action: z.string(),
          entity: z.string(),
          reason: z.string(),
          before: z.string().optional(),
          after: z.string().optional(),
        })
        .strict(),
    ),
    days: z.array(
      z
        .object({
          id,
          date: z.iso.date(),
          openedAt: timestamp,
          openingCash: amount.nonnegative(),
          status: z.enum(["OPEN", "CLOSED"]),
          closes: z.array(
            z
              .object({
                time: timestamp,
                actor: z.string(),
                countedCash: amount.nonnegative(),
                expectedCash: amount,
                variance: amount,
                reason: z.string(),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
  })
  .strict();
const payloadSchema = z
  .object({
    format: z.literal("poker-local-backup"),
    version: z.literal(1),
    createdAt: timestamp,
    branches: z.array(
      z.object({ id, name: z.string(), timezone: z.string() }).strict(),
    ),
    users: z.array(
      z
        .object({
          id,
          username: z.string(),
          password_hash: z.string(),
          active: z.boolean(),
        })
        .strict(),
    ),
    memberships: z.array(
      z.object({ user_id: id, branch_id: id, role }).strict(),
    ),
    states: z.array(
      z
        .object({
          branch_id: id,
          revision: z.number().int().nonnegative(),
          data: storeSchema,
        })
        .strict(),
    ),
    operations: z.array(
      z
        .object({
          branch_id: id,
          operation_id: id,
          actor_id: id,
          fingerprint: z.string(),
          revision: z.number().int().nonnegative(),
          created_at: timestamp,
          result_context: z
            .object({
              playerIds: z.array(id.max(100)).max(20).optional(),
              approvalIds: z.array(id.max(100)).max(20).optional(),
              transactionIds: z.array(id.max(100)).max(20).optional(),
            })
            .strict()
            .optional(),
        })
        .strict(),
    ),
  })
  .strict();
export type BackupPayload = z.infer<typeof payloadSchema>;
export type Backup = { payload: BackupPayload; checksum: string };
export function sealBackup(payload: BackupPayload): Backup {
  return {
    payload,
    checksum: createHash("sha256")
      .update(JSON.stringify(payload))
      .digest("hex"),
  };
}
function unique(values: string[]) {
  if (new Set(values).size !== values.length)
    throw new Error("Backup contains duplicate records.");
}
function reference(set: Set<string>, value: string | null | undefined) {
  if (value != null && !set.has(value))
    throw new Error("Backup contains a missing record reference.");
}
function validateStore(store: Store, users: Set<string>) {
  for (const table of store.tables) {
    const issue = tableRuleIssue(store, table);
    if (issue)
      throw new Error(
        `Backup contains invalid rules for table ${table.name}: ${issue}`,
      );
  }
  for (const rows of [
    store.profiles,
    store.tables,
    store.sessions,
    store.transactions,
    store.approvals,
    store.auditLogs,
    store.days,
  ])
    unique(rows.map((r) => r.id));
  unique(store.days.map((d) => d.date));
  const ids = (rows: { id: string }[]) => new Set(rows.map((r) => r.id));
  const days = ids(store.days),
    profiles = ids(store.profiles),
    tables = ids(store.tables),
    sessions = ids(store.sessions),
    transactions = ids(store.transactions),
    approvals = ids(store.approvals);
  reference(days, store.currentDayId);
  for (const day of store.days)
    if (day.status === "CLOSED" && !day.closes.length)
      throw new Error("Closed business day has no closing snapshot.");
  for (const session of store.sessions) {
    reference(days, session.dayId);
    reference(profiles, session.playerId);
    reference(tables, session.tableId);
  }
  unique(
    store.sessions
      .filter((s) => s.status === "ACTIVE")
      .map((s) => s.tableId + ":" + s.seat),
  );
  unique(
    store.sessions.filter((s) => s.status === "ACTIVE").map((s) => s.playerId),
  );
  for (const entry of [...store.transactions, ...store.approvals]) {
    reference(days, entry.dayId);
    reference(profiles, entry.playerId);
    reference(tables, entry.tableId);
    reference(sessions, entry.sessionId);
    reference(transactions, entry.reversesId);
  }
  for (const tx of store.transactions) {
    reference(users, tx.staffId);
    reference(approvals, tx.approvalId);
  }
  for (const request of store.approvals) {
    reference(users, request.requestedById);
    for (const vote of request.votes) reference(users, vote.staffId);
  }
  for (const log of store.auditLogs) reference(users, log.actorId);
}
export function parseBackup(input: unknown): Backup {
  const envelope = z
    .object({
      payload: z.unknown(),
      checksum: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict()
    .safeParse(input);
  if (!envelope.success) throw new Error("Not a full local backup file.");
  const checksum = createHash("sha256")
    .update(JSON.stringify(envelope.data.payload))
    .digest("hex");
  if (checksum !== envelope.data.checksum)
    throw new Error(
      "Backup checksum does not match. The file is damaged or was edited.",
    );
  const parsed = payloadSchema.safeParse(envelope.data.payload);
  if (!parsed.success)
    throw new Error(
      "Backup format or data is invalid. This file cannot be restored.",
    );
  const p = parsed.data;
  unique(p.branches.map((b) => b.id));
  unique(p.users.map((u) => u.id));
  unique(p.users.map((u) => u.username));
  unique(p.states.map((s) => s.branch_id));
  unique(p.memberships.map((m) => JSON.stringify([m.user_id, m.branch_id])));
  unique(
    p.operations.map((o) => JSON.stringify([o.branch_id, o.operation_id])),
  );
  const branches = new Set(p.branches.map((b) => b.id)),
    users = new Set(p.users.map((u) => u.id));
  for (const b of p.branches) {
    new Intl.DateTimeFormat("en", { timeZone: b.timezone });
    if (!p.states.some((s) => s.branch_id === b.id))
      throw new Error("Backup is missing branch state.");
  }
  for (const m of p.memberships) {
    reference(branches, m.branch_id);
    reference(users, m.user_id);
  }
  for (const s of p.states) {
    reference(branches, s.branch_id);
    validateStore(s.data, users);
  }
  for (const o of p.operations) {
    reference(branches, o.branch_id);
    reference(users, o.actor_id);
    if (o.result_context) {
      const state = p.states.find((s) => s.branch_id === o.branch_id)!;
      for (const [key, rows] of [
        ["playerIds", state.data.profiles],
        ["approvalIds", state.data.approvals],
        ["transactionIds", state.data.transactions],
      ] as const) {
        const known = new Set(rows.map((row) => row.id));
        for (const value of o.result_context[key] ?? [])
          reference(known, value);
      }
    }
  }
  // Keep the original serialized payload: parsing can reorder object keys used by the checksum.
  return envelope.data as Backup;
}

async function capture(connection: SqlConnection): Promise<Backup> {
  const branches = (
    await connection.query<BackupPayload["branches"][number]>(
      "SELECT id,name,timezone FROM poker_branches ORDER BY id",
    )
  ).rows;
  const users = (
    await connection.query<BackupPayload["users"][number]>(
      "SELECT id,username,password_hash,active FROM poker_users ORDER BY id",
    )
  ).rows;
  const memberships = (
    await connection.query<BackupPayload["memberships"][number]>(
      "SELECT user_id,branch_id,role FROM poker_memberships ORDER BY branch_id,user_id",
    )
  ).rows;
  const stateRows = (
    await connection.query<{ branch_id: string; revision: number }>(
      "SELECT branch_id,revision FROM poker_branch_state ORDER BY branch_id",
    )
  ).rows;
  const states: BackupPayload["states"] = [];
  for (const state of stateRows)
    states.push({
      ...state,
      data: await readStore(connection, state.branch_id),
    });
  const records = (
    await connection.query<
      Omit<BackupPayload["operations"][number], "created_at"> & {
        created_at: Date | string;
      }
    >(
      "SELECT branch_id,operation_id,actor_id,fingerprint,revision,created_at,result_context FROM poker_operations ORDER BY branch_id,operation_id",
    )
  ).rows;
  const operations = records.map((r) => ({
    ...r,
    created_at: new Date(r.created_at).toISOString(),
  }));
  return parseBackup(
    sealBackup({
      format: "poker-local-backup",
      version: 1,
      createdAt: new Date().toISOString(),
      branches,
      users,
      memberships,
      states,
      operations,
    }),
  );
}
export async function createBackup(db: Database) {
  return db.transaction(async (connection) => {
    await connection.query(
      "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    return capture(connection);
  });
}
export function backupSummary(backup: Backup) {
  return {
    createdAt: backup.payload.createdAt,
    branches: backup.payload.branches.length,
    staffAccounts: backup.payload.users.length,
    players: backup.payload.states.reduce(
      (sum, s) => sum + s.data.profiles.length,
      0,
    ),
    transactions: backup.payload.states.reduce(
      (sum, s) => sum + s.data.transactions.length,
      0,
    ),
    requests: backup.payload.states.reduce(
      (sum, s) => sum + s.data.approvals.length,
      0,
    ),
  };
}
export async function restoreBackup(
  db: Database,
  input: unknown,
  saveBeforeRestore: (backup: Backup) => Promise<void>,
) {
  const { payload: p } = parseBackup(input);
  await db.transaction(async (connection) => {
    // Maintenance operation: block all writers until replacement commits or rolls back.
    await connection.query(
      "LOCK TABLE poker_users,poker_memberships,poker_branches,poker_branch_state,poker_operations,poker_sessions,poker_login_attempts,poker_login_budget,poker_profiles,poker_tables,poker_visits,poker_days,poker_approvals,poker_ledger,poker_audit,poker_change_versions,poker_financial_totals IN ACCESS EXCLUSIVE MODE",
    );
    await saveBeforeRestore(await capture(connection));
    for (const table of [
      "poker_sessions",
      "poker_login_attempts",
      "poker_login_budget",
      "poker_operations",
      "poker_financial_totals",
      "poker_ledger",
      "poker_approvals",
      "poker_visits",
      "poker_audit",
      "poker_tables",
      "poker_profiles",
      "poker_days",
      "poker_change_versions",
      "poker_memberships",
      "poker_branch_state",
      "poker_users",
      "poker_branches",
    ])
      await connection.query(`DELETE FROM ${table}`);
    for (const b of p.branches)
      await connection.query(
        "INSERT INTO poker_branches(id,name,timezone) VALUES($1,$2,$3)",
        [b.id, b.name, b.timezone],
      );
    for (const u of p.users)
      await connection.query(
        "INSERT INTO poker_users(id,username,password_hash,active) VALUES($1,$2,$3,$4)",
        [u.id, u.username, u.password_hash, u.active],
      );
    for (const m of p.memberships)
      await connection.query(
        "INSERT INTO poker_memberships(user_id,branch_id,role) VALUES($1,$2,$3)",
        [m.user_id, m.branch_id, m.role],
      );
    for (const s of p.states)
      await replaceStore(connection, s.branch_id, s.data, s.revision);
    for (const o of p.operations)
      await connection.query(
        "INSERT INTO poker_operations(branch_id,operation_id,actor_id,fingerprint,revision,created_at,result_context) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          o.branch_id,
          o.operation_id,
          o.actor_id,
          o.fingerprint,
          o.revision,
          o.created_at,
          JSON.stringify(o.result_context ?? {}),
        ],
      );
  });
}
