import "server-only";
import type { Transaction } from "../domain/model";
import type { SqlConnection } from "./database";
import { financialColumns, financialTotalsInsertSql } from "./rollup-schema";

/** Called once after the immutable ledger INSERT, inside its transaction. */
export async function updateLedgerRollups(
  connection: SqlConnection,
  branchId: string,
  transaction: Transaction,
  originalType: Transaction["type"],
) {
  for (const value of [
    transaction.amount,
    transaction.cashReceived,
    transaction.cashPayout,
    transaction.creditDelta,
  ])
    if (!Number.isSafeInteger(value))
      throw new Error("A ledger amount cannot be aggregated safely.");
  const type = transaction.reversesId ? originalType : transaction.type;
  if (type === "Reversal")
    throw new Error("A reversal requires its original ledger entry type.");
  const amount = transaction.amount;
  const values = [
    type === "Buy-in" ? amount : 0,
    type === "Cash-out" ? amount : 0,
    type === "Rake" ? amount : 0,
    type === "Tips" ? amount : 0,
    type === "Insurance Premium"
      ? amount
      : type === "Insurance Payout"
        ? -amount
        : 0,
    type === "Jackpot Contribution"
      ? amount
      : type === "Jackpot Payout"
        ? -amount
        : 0,
    transaction.cashReceived,
    transaction.cashPayout,
    transaction.creditDelta,
  ];
  const scopes = [
    { scope: "VENUE", entity_id: "", day_id: "" },
    { scope: "DAY", entity_id: "", day_id: transaction.dayId },
  ];
  if (transaction.playerId)
    scopes.push(
      { scope: "PLAYER", entity_id: transaction.playerId, day_id: "" },
      {
        scope: "PLAYER_DAY",
        entity_id: transaction.playerId,
        day_id: transaction.dayId,
      },
    );
  if (transaction.tableId)
    scopes.push({
      scope: "TABLE_DAY",
      entity_id: transaction.tableId,
      day_id: transaction.dayId,
    });
  await connection.query(
    `INSERT INTO poker_financial_totals(branch_id,scope,entity_id,day_id,${financialColumns.join(",")})
     SELECT $1,bucket.scope,bucket.entity_id,bucket.day_id,${values.map((_, index) => `$${index + 3}::numeric`).join(",")}
     FROM jsonb_to_recordset($2::jsonb) AS bucket(scope text,entity_id text,day_id text)
     ON CONFLICT(branch_id,scope,entity_id,day_id) DO UPDATE SET
       ${financialColumns.map((column) => `${column}=poker_financial_totals.${column}+EXCLUDED.${column}`).join(",")}`,
    [branchId, JSON.stringify(scopes), ...values.map(String)],
  );
}

/** Imports/restores run once after all referenced ledger records are present. */
export async function rebuildLedgerRollups(
  connection: SqlConnection,
  branchId: string,
) {
  await connection.query(
    "DELETE FROM poker_financial_totals WHERE branch_id=$1",
    [branchId],
  );
  await connection.query(financialTotalsInsertSql(true), [branchId]);
}
