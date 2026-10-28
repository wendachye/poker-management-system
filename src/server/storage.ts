import "server-only";
import type { Store, Transaction } from "../domain/model";
import { DomainError } from "../domain/operations";
import type { Database, SqlConnection } from "./database";
import { rebuildLedgerRollups, updateLedgerRollups } from "./ledger-rollups";

export const recordTables = {
  profiles: "poker_profiles",
  tables: "poker_tables",
  sessions: "poker_visits",
  days: "poker_days",
  approvals: "poker_approvals",
  transactions: "poker_ledger",
  auditLogs: "poker_audit",
} as const;
type Collection = keyof typeof recordTables;
const collections = Object.keys(recordTables) as Collection[];
const prepended = new Set<Collection>([
  "approvals",
  "transactions",
  "auditLogs",
]);
type RecordValue = Store[Collection][number];
export type StorageMetadata = {
  schemaVersion: 1;
  storageVersion: 2;
  settings?: Store["settings"];
  currentDayId: string | null;
  concurrencyFloor: number;
};

function revisionValue(value: number) {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error("The storage revision must be a nonnegative safe integer.");
  return value;
}
export function storageMetadata(
  store: Store,
  concurrencyFloor = 0,
): StorageMetadata {
  return {
    schemaVersion: 1,
    storageVersion: 2,
    ...(store.settings === undefined ? {} : { settings: store.settings }),
    currentDayId: store.currentDayId,
    concurrencyFloor: revisionValue(concurrencyFloor),
  };
}
function requireCompleteStore(store: Store) {
  if (
    store.schemaVersion !== 1 ||
    ("readModel" in store && store.readModel !== undefined) ||
    !collections.every((key) => Array.isArray(store[key])) ||
    !(store.currentDayId === null || typeof store.currentDayId === "string")
  )
    throw new Error(
      "An import requires a complete Store without read-model projections.",
    );
}

/** Full reconstruction is reserved for explicit backup/export and verification.
 * One SQL snapshot keeps metadata and every collection internally consistent.
 */
export async function readStore(
  connection: SqlConnection,
  branchId: string,
): Promise<Store> {
  const row = (
    await connection.query<
      { metadata: StorageMetadata } & Pick<Store, Collection>
    >(
      `SELECT s.data AS metadata, ${collections
        .map(
          (key) =>
            `COALESCE((SELECT jsonb_agg(r.data ORDER BY r.order_no,r.id) FROM ${recordTables[key]} r WHERE r.branch_id=s.branch_id),'[]'::jsonb) AS "${key}"`,
        )
        .join(",")}
      FROM poker_branch_state s WHERE s.branch_id=$1`,
      [branchId],
    )
  ).rows[0];
  if (!row) throw new DomainError("Branch has not been initialized.", 503);
  if (row.metadata.storageVersion !== 2)
    throw new DomainError(
      "Apply the indexed storage migration before starting operations.",
      503,
    );
  return {
    schemaVersion: 1,
    ...(row.metadata.settings === undefined
      ? {}
      : { settings: row.metadata.settings }),
    currentDayId: row.metadata.currentDayId,
    ...Object.fromEntries(collections.map((key) => [key, row[key]])),
  } as Store;
}

/** The caller holds the venue coordination lock and commits domain changes,
 * operation IDs and audit records in the same transaction. Omitted scoped rows
 * are deliberately never deleted. Read-model fields are never persisted.
 */
export async function writeStoreDelta(
  connection: SqlConnection,
  branchId: string,
  before: Store,
  after: Store,
  revision: number,
) {
  revisionValue(revision);
  const metadata = (
    await connection.query<{ data: StorageMetadata }>(
      "SELECT data FROM poker_branch_state WHERE branch_id=$1",
      [branchId],
    )
  ).rows[0]?.data;
  if (!metadata || metadata.storageVersion !== 2)
    throw new DomainError(
      "Branch has not been initialized for indexed storage.",
      503,
    );
  for (const key of collections) {
    const table = recordTables[key];
    const existing = new Map<string, RecordValue>(
      before[key].map((row) => [row.id, row]),
    );
    const added = after[key].filter((row) => !existing.has(row.id));
    let nextOrder = 0;
    if (added.length) {
      const range = (
        await connection.query<{ low: string | null; high: string | null }>(
          `SELECT min(order_no)::text AS low,max(order_no)::text AS high FROM ${table} WHERE branch_id=$1`,
          [branchId],
        )
      ).rows[0];
      const low = Number(range.low ?? 1),
        high = Number(range.high ?? 0);
      nextOrder = prepended.has(key) ? low - added.length : high + 1;
      if (
        !Number.isSafeInteger(nextOrder) ||
        !Number.isSafeInteger(nextOrder + added.length)
      )
        throw new Error("The record ordering exceeds the supported range.");
    }
    for (const row of after[key]) {
      const previous = existing.get(row.id);
      const data = JSON.stringify(row);
      if (previous) {
        if (data === JSON.stringify(previous)) continue;
        if (key === "transactions")
          throw new DomainError(
            "Posted transactions are immutable. Request a reversal instead.",
            409,
          );
        const changed = await connection.query(
          `UPDATE ${table} SET data=$1,last_revision=$2 WHERE branch_id=$3 AND id=$4 RETURNING id`,
          [data, revision, branchId, row.id],
        );
        if (!changed.rows.length)
          throw new DomainError(
            "The record changed. Refresh records and try again.",
            409,
          );
      } else {
        await connection.query(
          `INSERT INTO ${table}(branch_id,id,data,order_no,last_revision) VALUES($1,$2,$3,$4,$5)`,
          [branchId, row.id, data, nextOrder++, revision],
        );
        if (key === "transactions") {
          const transaction = row as Transaction;
          let originalType = transaction.type;
          if (transaction.reversesId) {
            const original = (
              await connection.query<{ type: Transaction["type"] }>(
                "SELECT type FROM poker_ledger WHERE branch_id=$1 AND id=$2",
                [branchId, transaction.reversesId],
              )
            ).rows[0];
            if (!original)
              throw new Error("The original ledger entry was not found.");
            originalType = original.type;
          }
          await updateLedgerRollups(
            connection,
            branchId,
            transaction,
            originalType,
          );
        }
      }
    }
  }
  await connection.query(
    "UPDATE poker_branch_state SET data=$1,revision=$2 WHERE branch_id=$3",
    [
      JSON.stringify(storageMetadata(after, metadata.concurrencyFloor ?? 0)),
      revision,
      branchId,
    ],
  );
}

/** Explicit full import/restore. The caller must wrap this in a transaction. */
export async function replaceStore(
  connection: SqlConnection,
  branchId: string,
  store: Store,
  revision?: number,
) {
  requireCompleteStore(store);
  const current = (
    await connection.query<{ revision: number }>(
      "SELECT revision FROM poker_branch_state WHERE branch_id=$1 FOR UPDATE",
      [branchId],
    )
  ).rows[0];
  const nextRevision = revisionValue(revision ?? current?.revision ?? 0);
  await connection.query("SET CONSTRAINTS ALL DEFERRED");
  await connection.query(
    "DELETE FROM poker_financial_totals WHERE branch_id=$1",
    [branchId],
  );
  for (const key of collections)
    await connection.query(
      `DELETE FROM ${recordTables[key]} WHERE branch_id=$1`,
      [branchId],
    );
  await connection.query(
    "DELETE FROM poker_change_versions WHERE branch_id=$1",
    [branchId],
  );
  await connection.query(
    `INSERT INTO poker_branch_state(branch_id,revision,data) VALUES($1,$2,$3)
     ON CONFLICT(branch_id) DO UPDATE SET revision=excluded.revision,data=excluded.data`,
    [
      branchId,
      nextRevision,
      JSON.stringify(storageMetadata(store, nextRevision)),
    ],
  );
  for (const key of collections)
    if (store[key].length)
      await connection.query(
        `INSERT INTO ${recordTables[key]}(branch_id,id,data,order_no,last_revision)
         SELECT $1,value->>'id',value,ordinality,$3
         FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY AS item(value,ordinality)`,
        [branchId, JSON.stringify(store[key]), nextRevision],
      );
  await rebuildLedgerRollups(connection, branchId);
}

export async function importStore(
  db: Database,
  branchId: string,
  store: Store,
  revision?: number,
) {
  return db.transaction((connection) =>
    replaceStore(connection, branchId, store, revision),
  );
}
