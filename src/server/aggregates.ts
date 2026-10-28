import "server-only";
import type { Day, Staff, Store, Totals } from "../domain/model";
import { DomainError } from "../domain/operations";
import type { SqlConnection } from "./database";

/** PostgreSQL bigint/numeric results stay strings until their safe-sen check. */
export function checkedTotal(value: unknown): number {
  if (typeof value !== "number" && typeof value !== "string")
    throw new DomainError("A financial total could not be read safely.", 503);
  if (typeof value === "string" && !/^-?\d+$/.test(value))
    throw new DomainError("A financial total could not be read safely.", 503);
  const result = Number(value);
  if (!Number.isSafeInteger(result))
    throw new DomainError("Financial total exceeds the supported amount.", 503);
  return result;
}

export function dayTotals(day: Day, row: Record<string, unknown> = {}): Totals {
  const sums = Object.fromEntries(
    [
      "cashReceived",
      "cashPayout",
      "buyInTotal",
      "cashOutTotal",
      "rake",
      "tips",
      "insurance",
      "jackpot",
    ].map((key) => [key, checkedTotal(row[key] ?? 0)]),
  ) as Pick<
    Totals,
    | "cashReceived"
    | "cashPayout"
    | "buyInTotal"
    | "cashOutTotal"
    | "rake"
    | "tips"
    | "insurance"
    | "jackpot"
  >;
  const net = BigInt(sums.cashReceived) - BigInt(sums.cashPayout);
  checkedTotal(net.toString());
  const expectedCash = checkedTotal((BigInt(day.openingCash) + net).toString());
  const countedCash =
    day.status === "CLOSED" ? (day.closes.at(-1)?.countedCash ?? null) : null;
  return {
    ...sums,
    openingCash: day.openingCash,
    expectedCash,
    countedCash,
    variance:
      countedCash === null
        ? null
        : checkedTotal((BigInt(countedCash) - BigInt(expectedCash)).toString()),
  };
}

/** Exact aggregate context for the records in this scoped store, never a ledger slice. */
export async function populateReadModel(
  connection: SqlConnection,
  branchId: string,
  store: Store,
  options: {
    summary?: boolean;
    dayTotals?: boolean;
    playerTotals?: boolean;
    tableTotals?: boolean;
    user?: Staff;
  } = {},
): Promise<Store> {
  const ids = store.profiles.map((p) => p.id);
  const days = store.days.map((d) => d.id);
  const balances: Record<string, number> = Object.fromEntries(
    ids.map((id) => [id, 0]),
  );
  const playerDay: Record<string, { buyIn: number; cashOut: number }> = {};
  const wantsSummary = options.summary !== false,
    wantsDays = options.dayTotals !== false,
    wantsPlayers = options.playerTotals !== false,
    wantsTables = options.tableTotals !== false;
  // The authoritative ledger and these exact summaries commit together. Routine
  // reads use indexed summary keys, independent of retained ledger length.
  const summaryRows = await connection.query<Record<string, unknown>>(
    `SELECT scope,entity_id,day_id,buy_in::text AS "buyInTotal",cash_out::text AS "cashOutTotal",cash_received::text AS "cashReceived",cash_payout::text AS "cashPayout",credit_delta::text AS balance,rake::text,tips::text,insurance::text,jackpot::text
    FROM poker_financial_totals WHERE branch_id=$1 AND (
      ($4::boolean AND scope='VENUE') OR
      (scope='PLAYER' AND entity_id=ANY($2::text[])) OR
      ($5::boolean AND scope='DAY' AND day_id=ANY($3::text[])) OR
      ($6::boolean AND scope='PLAYER_DAY' AND entity_id=ANY($2::text[]) AND day_id=ANY($3::text[])) OR
      ($7::boolean AND scope='TABLE_DAY' AND day_id=$8)
    )`,
    [
      branchId,
      ids,
      days,
      wantsSummary,
      wantsDays,
      wantsPlayers,
      wantsTables,
      store.currentDayId,
    ],
  );
  for (const row of summaryRows.rows) {
    if (row.scope === "PLAYER")
      balances[String(row.entity_id)] = checkedTotal(row.balance);
    if (row.scope === "PLAYER_DAY")
      playerDay[`${row.day_id}:${row.entity_id}`] = {
        buyIn: checkedTotal(row.buyInTotal),
        cashOut: checkedTotal(row.cashOutTotal),
      };
  }
  const totalRows = summaryRows.rows.filter((row) => row.scope === "DAY");
  const totals = Object.fromEntries(
    store.days.map((day) => [
      day.id,
      dayTotals(
        day,
        totalRows.find((row) => row.day_id === day.id),
      ),
    ]),
  );
  const tableTotals = Object.fromEntries(
    store.tables.map((table) => [
      table.id,
      { rake: 0, insurance: 0, jackpot: 0 },
    ]),
  );
  if (store.currentDayId && wantsTables) {
    for (const row of summaryRows.rows.filter(
      (row) => row.scope === "TABLE_DAY",
    ))
      tableTotals[String(row.entity_id)] = {
        rake: checkedTotal(row.rake),
        insurance: checkedTotal(row.insurance),
        jackpot: checkedTotal(row.jackpot),
      };
  }
  const pendingRows = await connection.query<{
    player_id: string | null;
    count: string;
    reserved: string;
  }>(
    "SELECT player_id,count(*)::text AS count,COALESCE(sum((data->>'amount')::bigint) FILTER(WHERE type='Buy-in'),0)::text AS reserved FROM poker_approvals WHERE branch_id=$1 AND status='PENDING' AND player_id=ANY($2::text[]) GROUP BY player_id",
    [branchId, ids],
  );
  const pendingPlayers: Record<string, number> = Object.fromEntries(
    ids.map((id) => [id, 0]),
  );
  const reservedCredit: Record<string, number> = Object.fromEntries(
    ids.map((id) => [id, 0]),
  );
  for (const row of pendingRows.rows)
    if (row.player_id) {
      pendingPlayers[row.player_id] = checkedTotal(row.count);
      reservedCredit[row.player_id] = checkedTotal(row.reserved);
    }
  const counts =
    options.summary === false
      ? { total: 0, current: 0, admin: 0, reviewable: 0 }
      : (
          await connection.query<{
            total: string;
            current: string;
            admin: string;
            reviewable: string;
          }>(
            `SELECT count(*)::text AS total,count(*) FILTER(WHERE day_id=$2)::text AS current,count(*) FILTER(WHERE day_id=$2 AND approval_level<>'MANAGER')::text AS admin,
    count(*) FILTER(WHERE day_id=$2 AND $4::text IN ('ADMIN','MANAGER') AND requested_by_id<>$3 AND (approval_level<>'ADMIN' OR $4='ADMIN') AND NOT (data->'votes' @> jsonb_build_array(jsonb_build_object('staffId',$3::text))) AND EXISTS(SELECT 1 FROM poker_days WHERE branch_id=$1 AND id=$2 AND status='OPEN'))::text AS reviewable
    FROM poker_approvals WHERE branch_id=$1 AND status='PENDING'`,
            [
              branchId,
              store.currentDayId,
              options.user?.id ?? "",
              options.user?.role ?? "",
            ],
          )
        ).rows[0];
  const outstanding = {
    value: summaryRows.rows.find((row) => row.scope === "VENUE")?.balance ?? 0,
  };
  const pendingDays =
    options.summary === false
      ? {}
      : Object.fromEntries(
          (
            await connection.query<{ day_id: string; count: string }>(
              "SELECT day_id,count(*)::text AS count FROM poker_approvals WHERE branch_id=$1 AND status='PENDING' AND day_id=ANY($2::text[]) GROUP BY day_id",
              [branchId, days],
            )
          ).rows.map((row) => [row.day_id, checkedTotal(row.count)]),
        );
  const pendingTables =
    options.summary === false
      ? {}
      : Object.fromEntries(
          (
            await connection.query<{ table_id: string; count: string }>(
              "SELECT table_id,count(*)::text AS count FROM poker_approvals WHERE branch_id=$1 AND status='PENDING' AND table_id IS NOT NULL GROUP BY table_id",
              [branchId],
            )
          ).rows.map((row) => [row.table_id, checkedTotal(row.count)]),
        );
  store.readModel = {
    server: true,
    balances,
    playerDay,
    totals,
    tableTotals,
    outstandingCredit: checkedTotal(outstanding.value),
    pendingTotal: checkedTotal(counts.total),
    pendingCurrent: checkedTotal(counts.current),
    adminReview: checkedTotal(counts.admin),
    reviewable: checkedTotal(counts.reviewable),
    pendingPlayers,
    reservedCredit,
    pendingDays,
    pendingTables,
  };
  return store;
}
