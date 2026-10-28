import "server-only";
import type { Database } from "./database";
import { captureBackup } from "./backup";
import { schemaMigrationStatus } from "./schema";

const columns = [
  "buy_in",
  "cash_out",
  "rake",
  "tips",
  "insurance",
  "jackpot",
  "cash_received",
  "cash_payout",
  "credit_delta",
] as const;
type SummaryRow = {
  branch_id: string;
  scope: string;
  entity_id: string;
  day_id: string;
} & Record<(typeof columns)[number], string>;
const key = (branch: string, scope: string, entity: string, day: string) =>
  JSON.stringify([branch, scope, entity, day]);

export class DatabaseIntegrityError extends Error {
  constructor(
    readonly code: "SCHEMA_NOT_READY" | "FINANCIAL_SUMMARY_MISMATCH",
  ) {
    super(
      code === "SCHEMA_NOT_READY"
        ? "Apply the matching database migrations before checking stored records."
        : "Saved financial summaries do not match the authoritative ledger. Review recovery before continuing operations.",
    );
  }
}

/** Explicit maintenance read, not an HTTP polling check. Authoritative records,
 * revisions and derived summaries are examined in one read-only snapshot.
 * The report contains counts and check names, never credentials or record data.
 */
export async function verifyDatabaseIntegrity(db: Database) {
  const started = performance.now();
  return db.transaction(async (connection) => {
    await connection.query(
      "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    if (!(await schemaMigrationStatus(connection)).ready)
      throw new DatabaseIntegrityError("SCHEMA_NOT_READY");
    const backup = await captureBackup(connection);
    const expected = new Map<string, bigint[]>();
    for (const state of backup.payload.states) {
      const originals = new Map(
        state.data.transactions.map((row) => [row.id, row]),
      );
      for (const entry of state.data.transactions) {
        const type = entry.reversesId
          ? originals.get(entry.reversesId)!.type
          : entry.type;
        const amount = BigInt(entry.amount),
          zero = BigInt(0);
        // Independent control calculation; do not reuse the SQL incremental or
        // rebuild implementation whose persisted output is being checked.
        const delta = [
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
          BigInt(entry.cashReceived),
          BigInt(entry.cashPayout),
          BigInt(entry.creditDelta),
        ];
        const scopes = [
          key(state.branch_id, "VENUE", "", ""),
          key(state.branch_id, "DAY", "", entry.dayId),
        ];
        if (entry.playerId)
          scopes.push(
            key(state.branch_id, "PLAYER", entry.playerId, ""),
            key(state.branch_id, "PLAYER_DAY", entry.playerId, entry.dayId),
          );
        if (entry.tableId)
          scopes.push(
            key(state.branch_id, "TABLE_DAY", entry.tableId, entry.dayId),
          );
        for (const scope of scopes) {
          const totals = expected.get(scope) ?? columns.map(() => BigInt(0));
          for (let index = 0; index < columns.length; index++)
            totals[index] += delta[index];
          expected.set(scope, totals);
        }
      }
    }
    const saved = (
      await connection.query<SummaryRow>(
        `SELECT branch_id,scope,entity_id,day_id,${columns.map((column) => `${column}::text AS ${column}`).join(",")} FROM poker_financial_totals`,
      )
    ).rows;
    if (saved.length !== expected.size)
      throw new DatabaseIntegrityError("FINANCIAL_SUMMARY_MISMATCH");
    for (const row of saved) {
      const totals = expected.get(
        key(row.branch_id, row.scope, row.entity_id, row.day_id),
      );
      if (
        !totals ||
        columns.some(
          (column, index) =>
            !/^-?\d+$/.test(row[column]) ||
            BigInt(row[column]) !== totals[index],
        )
      )
        throw new DatabaseIntegrityError("FINANCIAL_SUMMARY_MISMATCH");
    }
    const sum = (
      collection:
        | "profiles"
        | "tables"
        | "sessions"
        | "days"
        | "approvals"
        | "transactions"
        | "auditLogs",
    ) =>
      backup.payload.states.reduce(
        (total, state) => total + state.data[collection].length,
        0,
      );
    return {
      checkedAt: new Date().toISOString(),
      venueCount: backup.payload.branches.length,
      counts: {
        users: backup.payload.users.length,
        profiles: sum("profiles"),
        tables: sum("tables"),
        sessions: sum("sessions"),
        days: sum("days"),
        approvals: sum("approvals"),
        transactions: sum("transactions"),
        auditEvents: sum("auditLogs"),
        operations: backup.payload.operations.length,
        financialSummaryRows: saved.length,
      },
      checks: [
        "schema-migrations",
        "record-references",
        "financial-postings-and-approvals",
        "reversals-and-credit",
        "business-days-and-closing",
        "independent-financial-summary-parity",
      ],
      elapsedMs: Math.round((performance.now() - started) * 1000) / 1000,
      readOnly: true,
    };
  });
}
