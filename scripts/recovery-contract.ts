import { createHash } from "node:crypto";
import type { Backup, BackupPayload } from "../src/server/backup";
import type { Store } from "../src/domain/model";
import { capacityDatabaseTarget } from "../src/server/capacity-target";

type Environment = Readonly<Record<string, string | undefined>>;

/** A recovery drill owns its fixtures; it never falls back to an operations URL. */
export function recoveryDrillTarget(env: Environment = process.env) {
  if (env.PGOPTIONS?.trim())
    throw new Error(
      "PGOPTIONS must be unset for the disposable recovery drill.",
    );
  const target = capacityDatabaseTarget(env.POSTGRES_TEST_DATABASE_URL);
  if (target.port < 1 || target.port > 65535)
    throw new Error(
      "POSTGRES_TEST_DATABASE_URL must select a valid PostgreSQL port.",
    );
  return target;
}

export function recoveryResourceName(
  suffix: string,
  kind:
    | "source"
    | "destination"
    | "source_owner"
    | "source_app"
    | "destination_owner"
    | "destination_app",
) {
  if (
    !/^[a-f0-9]{16}$/.test(suffix) ||
    ![
      "source",
      "destination",
      "source_owner",
      "source_app",
      "destination_owner",
      "destination_app",
    ].includes(kind)
  )
    throw new Error("Invalid recovery resource identity.");
  const name = `poker_test_recovery_${suffix}_${kind}`;
  if (Buffer.byteLength(name) > 63)
    throw new Error("Recovery resource identity exceeds PostgreSQL's limit.");
  return name;
}

function normalized(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalized);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([first], [second]) => first.localeCompare(second, "en"))
        .map(([key, item]) => [key, normalized(item)]),
    );
  return value;
}

/** Object key order is irrelevant; record/array order remains part of parity. */
export function recoveryDigest(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(normalized(value)))
    .digest("hex");
}

export function backupRecoveryDigest(backup: Backup) {
  return recoveryDigest({ ...backup.payload, createdAt: "" });
}

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
export type RecoveryFinancialRow = {
  branch_id: string;
  scope: string;
  entity_id: string;
  day_id: string;
} & Record<(typeof columns)[number], string>;

/** Independent integer arithmetic for the drill, not the SQL projection builder. */
export function expectedRecoveryFinancialRows(
  states: ReadonlyArray<{ branch_id: string; data: Store }>,
): RecoveryFinancialRow[] {
  const result = new Map<string, RecoveryFinancialRow>();
  for (const state of states) {
    const originals = new Map(
      state.data.transactions.map((entry) => [entry.id, entry]),
    );
    for (const entry of state.data.transactions) {
      const type = entry.reversesId
        ? originals.get(entry.reversesId)?.type
        : entry.type;
      if (!type || type === "Reversal")
        throw new Error("Recovery fixture has an unresolved reversal.");
      const amount = BigInt(entry.amount);
      const values = [
        type === "Buy-in" ? amount : BigInt(0),
        type === "Cash-out" ? amount : BigInt(0),
        type === "Rake" ? amount : BigInt(0),
        type === "Tips" ? amount : BigInt(0),
        type === "Insurance Premium"
          ? amount
          : type === "Insurance Payout"
            ? -amount
            : BigInt(0),
        type === "Jackpot Contribution"
          ? amount
          : type === "Jackpot Payout"
            ? -amount
            : BigInt(0),
        BigInt(entry.cashReceived),
        BigInt(entry.cashPayout),
        BigInt(entry.creditDelta),
      ];
      const scopes = [
        ["VENUE", "", ""],
        ["DAY", "", entry.dayId],
        ...(entry.playerId
          ? [
              ["PLAYER", entry.playerId, ""],
              ["PLAYER_DAY", entry.playerId, entry.dayId],
            ]
          : []),
        ...(entry.tableId ? [["TABLE_DAY", entry.tableId, entry.dayId]] : []),
      ];
      for (const [scope, entity, day] of scopes) {
        const key = JSON.stringify([state.branch_id, scope, entity, day]);
        let row = result.get(key);
        if (!row) {
          row = {
            branch_id: state.branch_id,
            scope,
            entity_id: entity,
            day_id: day,
            ...Object.fromEntries(columns.map((column) => [column, "0"])),
          } as RecoveryFinancialRow;
          result.set(key, row);
        }
        columns.forEach((column, index) => {
          row[column] = (BigInt(row[column]) + values[index]).toString();
        });
      }
    }
  }
  return [...result.values()].sort((first, second) =>
    financialRowKey(first).localeCompare(financialRowKey(second), "en"),
  );
}

export function financialRowKey(row: RecoveryFinancialRow) {
  return JSON.stringify([row.branch_id, row.scope, row.entity_id, row.day_id]);
}

export function recoveryRecordCounts(payload: BackupPayload) {
  const collections = [
    "profiles",
    "tables",
    "sessions",
    "days",
    "approvals",
    "transactions",
    "auditLogs",
  ] as const;
  return {
    branches: payload.branches.length,
    users: payload.users.length,
    memberships: payload.memberships.length,
    operations: payload.operations.length,
    ...(Object.fromEntries(
      collections.map((key) => [
        key,
        payload.states.reduce((sum, state) => sum + state.data[key].length, 0),
      ]),
    ) as Record<(typeof collections)[number], number>),
  };
}
