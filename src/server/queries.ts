import "server-only";
import { z } from "zod";
import type {
  ApprovalRequest,
  AuditLog,
  Day,
  Player,
  Profile,
  Session,
  Snapshot,
  Staff,
  Store,
  TableRecord,
  Transaction,
} from "../domain/model";
import type { ReadPage, ReadQuery } from "../domain/read-model";
import { compareReports, rangeMetrics } from "../domain/reporting";
import { emptyStore, playersForDay, totalsForDay } from "../domain/selectors";
import { DomainError } from "../domain/operations";
import { csv as moneyCsv } from "../domain/money";
import { displayName } from "../lib/display-name";
import { requireUser } from "./auth";
import type { Database, SqlConnection } from "./database";
import { checkedTotal, populateReadModel } from "./aggregates";
import type { StorageMetadata } from "./storage";

const text = z.string().trim().max(200).optional();
const id = z.string().min(1).max(100).optional();
const querySchema = z
  .object({
    resource: z.enum([
      "players",
      "requests",
      "transactions",
      "audit",
      "sessions",
      "player",
      "receipt",
      "report",
      "range",
    ]),
    page: z.coerce.number().int().min(0).max(1_000_000).default(0),
    pageSize: z.coerce.number().int().min(1).max(50).default(20),
    query: text,
    dayId: id,
    date: text,
    type: text,
    status: text,
    tag: text,
    staff: text,
    action: text,
    from: text,
    to: text,
    playerId: id,
    id,
  })
  .strict();
export function parseReadQuery(
  input: unknown,
): ReadQuery & { page: number; pageSize: number } {
  const parsed = querySchema.safeParse(input);
  if (!parsed.success)
    throw new DomainError(
      "Choose valid search filters and a page size from 1 to 50.",
    );
  for (const key of ["date", "from", "to"] as const) {
    const value = parsed.data[key];
    if (
      value &&
      (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value) ||
        value.startsWith("0000") ||
        !Number.isFinite(Date.parse(value + "T00:00:00Z")) ||
        new Date(value + "T00:00:00Z").toISOString().slice(0, 10) !== value)
    )
      throw new DomainError("Choose valid calendar dates.");
  }
  return parsed.data;
}
export type SnapshotExtra = {
  playerIds?: string[];
  approvalIds?: string[];
  transactionIds?: string[];
  sessionIds?: string[];
  dayIds?: string[];
  auditIds?: string[];
};
const unique = (values: (string | undefined | null)[]) => [
  ...new Set(values.filter((value): value is string => !!value)),
];
function safeIds(ids: string[] = []) {
  if (ids.length > 200 || ids.some((value) => !value || value.length > 100))
    throw new DomainError("Too many related records requested.");
  return unique(ids);
}
async function records<T>(
  connection: SqlConnection,
  sql: string,
  values: unknown[],
): Promise<T[]> {
  return (await connection.query<{ data: T }>(sql, values)).rows.map(
    (row) => row.data,
  );
}

async function operationalSnapshot(
  connection: SqlConnection,
  user: Staff,
  extra: SnapshotExtra = {},
): Promise<Snapshot> {
  const row = (
    await connection.query<{
      revision: number;
      data: StorageMetadata;
      name: string;
      timezone: string;
    }>(
      "SELECT s.revision,s.data,b.name,b.timezone FROM poker_branch_state s JOIN poker_branches b ON b.id=s.branch_id WHERE s.branch_id=$1",
      [user.branchId],
    )
  ).rows[0];
  if (!row || row.data.storageVersion !== 2)
    throw new DomainError(
      "Apply database migrations before starting operations.",
      503,
    );
  const branchId = user.branchId;
  const txIds = safeIds(extra.transactionIds),
    approvalIds = safeIds(extra.approvalIds);
  const initialTx = await records<Transaction>(
    connection,
    "SELECT data FROM poker_ledger WHERE branch_id=$1 AND (id=ANY($2::text[]) OR id IN (SELECT id FROM poker_ledger WHERE branch_id=$1 ORDER BY order_no,id LIMIT 20)) ORDER BY order_no,id",
    [branchId, txIds],
  );
  const approvals = await records<ApprovalRequest>(
    connection,
    "SELECT data FROM poker_approvals WHERE branch_id=$1 AND (id=ANY($2::text[]) OR (status='PENDING' AND reverses_id=ANY($3::text[])) OR id IN (SELECT id FROM poker_approvals WHERE branch_id=$1 AND status='PENDING' ORDER BY order_no,id LIMIT 20)) ORDER BY order_no,id",
    [
      branchId,
      unique([...approvalIds, ...initialTx.map((tx) => tx.approvalId)]),
      initialTx.map((tx) => tx.id),
    ],
  );
  const transactions = await records<Transaction>(
    connection,
    "SELECT data FROM poker_ledger WHERE branch_id=$1 AND (id=ANY($2::text[]) OR approval_id=ANY($3::text[]) OR reverses_id=ANY($4::text[])) ORDER BY order_no,id",
    [
      branchId,
      unique([
        ...initialTx.map((tx) => tx.id),
        ...initialTx.map((tx) => tx.reversesId),
        ...approvals.map((request) => request.reversesId),
      ]),
      approvals.map((request) => request.id),
      unique([
        ...txIds,
        ...initialTx.map((tx) => tx.id),
        ...approvals.map((request) => request.reversesId),
      ]),
    ],
  );
  const requestedPlayers = unique([
    ...safeIds(extra.playerIds),
    ...transactions.map((tx) => tx.playerId),
    ...approvals.map((request) => request.playerId),
  ]);
  const sessionIds = unique([
    ...safeIds(extra.sessionIds),
    ...transactions.map((tx) => tx.sessionId),
    ...approvals.map((request) => request.sessionId),
  ]);
  const sessions = await records<Session>(
    connection,
    `SELECT data FROM poker_visits WHERE branch_id=$1 AND (status='ACTIVE' OR id=ANY($2::text[]) OR id IN (
    SELECT latest.id FROM unnest($3::text[]) AS p(id) CROSS JOIN LATERAL (SELECT id FROM poker_visits WHERE branch_id=$1 AND player_id=p.id ORDER BY order_no DESC,id DESC LIMIT 1) latest
  ) OR id IN (
    SELECT latest.id FROM unnest($3::text[]) AS p(id) CROSS JOIN LATERAL (SELECT id FROM poker_visits WHERE branch_id=$1 AND player_id=p.id AND day_id=$4 ORDER BY order_no DESC,id DESC LIMIT 1) latest
  )) ORDER BY order_no,id`,
    [branchId, sessionIds, requestedPlayers, row.data.currentDayId],
  );
  const playerIds = unique([
    ...requestedPlayers,
    ...sessions.map((session) => session.playerId),
  ]);
  const profiles = playerIds.length
    ? await records<Profile>(
        connection,
        "SELECT data FROM poker_profiles WHERE branch_id=$1 AND id=ANY($2::text[]) ORDER BY order_no,id",
        [branchId, playerIds],
      )
    : [];
  const days = await records<Day>(
    connection,
    "SELECT data FROM poker_days WHERE branch_id=$1 AND (id=ANY($2::text[]) OR id IN(SELECT id FROM poker_days WHERE branch_id=$1 ORDER BY date DESC,id DESC LIMIT 7)) ORDER BY order_no,id",
    [
      branchId,
      unique([
        row.data.currentDayId,
        ...safeIds(extra.dayIds),
        ...sessions.map((session) => session.dayId),
        ...transactions.map((tx) => tx.dayId),
        ...approvals.map((request) => request.dayId),
      ]),
    ],
  );
  const store: Store = {
    ...emptyStore(),
    ...(row.data.settings ? { settings: row.data.settings } : {}),
    currentDayId: row.data.currentDayId,
    profiles,
    sessions,
    days,
    transactions,
    approvals,
    tables: await records<TableRecord>(
      connection,
      "SELECT data FROM poker_tables WHERE branch_id=$1 ORDER BY order_no,id",
      [branchId],
    ),
    auditLogs: extra.auditIds?.length
      ? await records<AuditLog>(
          connection,
          "SELECT data FROM poker_audit WHERE branch_id=$1 AND id=ANY($2::text[]) ORDER BY order_no,id",
          [branchId, safeIds(extra.auditIds)],
        )
      : [],
  };
  await populateReadModel(connection, branchId, store, { user });
  return {
    revision: row.revision,
    branch: {
      id: branchId,
      name: row.name,
      timezone: row.timezone,
      role: user.role,
    },
    user,
    store,
  };
}
export async function readOperationalSnapshot(
  connection: SqlConnection,
  token?: string,
  extra: SnapshotExtra = {},
) {
  return operationalSnapshot(
    connection,
    await requireUser(connection, token),
    extra,
  );
}

type Where = { clauses: string[]; values: unknown[] };
function where(branchId: string, alias: string): Where {
  return { clauses: [`${alias}.branch_id=$1`], values: [branchId] };
}
function condition(target: Where, expression: string, value: unknown) {
  target.values.push(value);
  target.clauses.push(expression.replaceAll("?", `$${target.values.length}`));
}
function search(
  target: Where,
  query: string | undefined,
  fields: string[],
  phones: string[] = [],
) {
  if (!query?.trim()) return;
  const normalized = query
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .trim();
  const normalizedFields = fields.map(
    (field) =>
      `regexp_replace(normalize(lower(COALESCE(${field},'')),NFD),'[̀-ͯ]','','g')`,
  );
  if (
    /^[+\d\s().-]+$/.test(query) &&
    query.replace(/\D/g, "").length >= 3 &&
    phones.length
  ) {
    target.values.push(query.replace(/\D/g, ""));
    const phoneParameter = `$${target.values.length}`;
    condition(
      target,
      `(${phones.map((phone) => `strpos(regexp_replace(${phone},'[^0-9]','','g'),${phoneParameter})>0`).join(" OR ")} OR ${normalizedFields.map((field) => `strpos(${field},?)>0`).join(" OR ")})`,
      normalized,
    );
    return;
  }
  for (const term of normalized.split(/\s+/).slice(0, 12))
    condition(
      target,
      `(${normalizedFields.map((field) => `strpos(${field},?)>0`).join(" OR ")})`,
      term,
    );
}
function sqlWhere(target: Where) {
  return target.clauses.join(" AND ");
}
async function paged<T>(
  connection: SqlConnection,
  source: string,
  select: string,
  target: Where,
  order: string,
  page: number,
  pageSize: number,
) {
  const total = checkedTotal(
    (
      await connection.query<{ total: string }>(
        `SELECT count(*)::text AS total FROM ${source} WHERE ${sqlWhere(target)}`,
        target.values,
      )
    ).rows[0].total,
  );
  const current = Math.min(page, Math.max(0, Math.ceil(total / pageSize) - 1));
  const result = await connection.query<T>(
    `SELECT ${select} FROM ${source} WHERE ${sqlWhere(target)} ORDER BY ${order} LIMIT $${target.values.length + 1} OFFSET $${target.values.length + 2}`,
    [...target.values, pageSize, current * pageSize],
  );
  return { rows: result.rows, total, page: current, pageSize };
}
function pageNumbers(page: { total: number; page: number; pageSize: number }) {
  return { total: page.total, page: page.page, pageSize: page.pageSize };
}
const profileSource = (dayRef: string) =>
  `poker_profiles p LEFT JOIN LATERAL(SELECT data,status FROM poker_visits WHERE branch_id=p.branch_id AND player_id=p.id AND day_id=${dayRef} ORDER BY order_no DESC,id DESC LIMIT 1) visit ON true`;
function playerFilters(target: Where, query: ReadQuery) {
  if (query.type) {
    if (!["CASH", "CREDIT"].includes(query.type))
      throw new DomainError("Choose a valid player type.");
    condition(target, "p.type=?", query.type);
  }
  if (query.tag) {
    if (!["VIP", "Risk", "Banned"].includes(query.tag))
      throw new DomainError("Choose a valid player tag.");
    condition(
      target,
      "p.data->'tags' @> ?::jsonb",
      JSON.stringify([query.tag]),
    );
  }
  if (query.status && query.status !== "ALL") {
    if (query.status === "OWING")
      target.clauses.push(
        "p.type='CREDIT' AND EXISTS(SELECT 1 FROM poker_financial_totals debt WHERE debt.branch_id=p.branch_id AND debt.scope='PLAYER' AND debt.entity_id=p.id AND debt.day_id='' AND debt.credit_delta>0)",
      );
    else if (["ACTIVE", "OUT"].includes(query.status))
      condition(target, "COALESCE(visit.status,'OUT')=?", query.status);
    else throw new DomainError("Choose a valid player status.");
  }
  search(target, query.query, ["p.name", "p.phone", "p.id"], ["p.phone"]);
}
function requestFilters(target: Where, query: ReadQuery) {
  if (query.dayId) condition(target, "r.day_id=?", query.dayId);
  if (query.type) condition(target, "r.type=?", query.type);
  if (query.playerId) condition(target, "r.player_id=?", query.playerId);
  search(
    target,
    query.query,
    [
      "r.id",
      "r.type",
      "r.data->>'staff'",
      "r.data->>'requestedBy'",
      "r.data->>'decidedBy'",
      "r.data->>'note'",
      "r.data->>'rejectionReason'",
      "(r.data->'votes')::text",
      "p.name",
      "p.phone",
      "t.name",
      "receipt.id",
    ],
    ["p.phone"],
  );
}
const requestSource =
  "poker_approvals r LEFT JOIN poker_profiles p ON p.branch_id=r.branch_id AND p.id=r.player_id LEFT JOIN poker_tables t ON t.branch_id=r.branch_id AND t.id=r.table_id LEFT JOIN poker_ledger receipt ON receipt.branch_id=r.branch_id AND receipt.approval_id=r.id";
async function requestCounts(
  connection: SqlConnection,
  target: Where,
  user: Staff,
) {
  const row = (
    await connection.query<{
      pending: string;
      approved: string;
      rejected: string;
      mine: string;
    }>(
      `SELECT count(*) FILTER(WHERE r.status='PENDING')::text AS pending,count(*) FILTER(WHERE r.status='APPROVED')::text AS approved,count(*) FILTER(WHERE r.status='REJECTED')::text AS rejected,count(*) FILTER(WHERE r.requested_by_id=$${target.values.length + 1})::text AS mine FROM ${requestSource} WHERE ${sqlWhere(target)}`,
      [...target.values, user.id],
    )
  ).rows[0];
  return {
    PENDING: checkedTotal(row.pending),
    APPROVED: checkedTotal(row.approved),
    REJECTED: checkedTotal(row.rejected),
    MINE: checkedTotal(row.mine),
  };
}
function playerExtra(ids: string[], dayId?: string | null): SnapshotExtra {
  return { playerIds: ids, dayIds: dayId ? [dayId] : [] };
}

async function readPageWithin(
  connection: SqlConnection,
  user: Staff,
  query: ReadQuery & { page: number; pageSize: number },
): Promise<ReadPage> {
  const branchId = user.branchId;
  const metadata = (
    await connection.query<{ data: StorageMetadata }>(
      "SELECT data FROM poker_branch_state WHERE branch_id=$1",
      [branchId],
    )
  ).rows[0]?.data;
  if (!metadata || metadata.storageVersion !== 2)
    throw new DomainError(
      "Apply database migrations before starting operations.",
      503,
    );
  const dayId = query.dayId ?? metadata.currentDayId;
  const base = {
    branchId,
    revision: 0,
    items: [],
    total: 0,
    page: query.page,
    pageSize: query.pageSize,
    counts: {},
  };
  if (
    query.resource === "players" ||
    query.resource === "player" ||
    query.resource === "report"
  ) {
    let day: Day | undefined;
    if (query.resource === "report") {
      day = (
        await records<Day>(
          connection,
          query.date
            ? "SELECT data FROM poker_days WHERE branch_id=$1 AND date=$2"
            : "SELECT data FROM poker_days WHERE branch_id=$1 AND id=$2",
          [branchId, query.date || dayId],
        )
      )[0];
      if (!day) throw new DomainError("Business day not found.", 404);
    }
    const target = where(branchId, "p");
    target.values.push(day?.id ?? dayId);
    const source = profileSource("$2");
    if (query.resource === "player") {
      const selected = query.playerId ?? query.id;
      if (!selected) throw new DomainError("Choose a player.");
      condition(target, "p.id=?", selected);
    }
    if (day)
      condition(
        target,
        "EXISTS(SELECT 1 FROM poker_visits participant WHERE participant.branch_id=p.branch_id AND participant.player_id=p.id AND participant.day_id=?)",
        day.id,
      );
    const countTarget = {
      clauses: [...target.clauses],
      values: [...target.values],
    };
    playerFilters(countTarget, { ...query, status: undefined });
    playerFilters(target, query);
    const page = await paged<{ id: string }>(
      connection,
      source,
      "p.id",
      target,
      "p.order_no,p.id",
      query.page,
      query.pageSize,
    );
    if (query.resource === "player" && !page.total)
      throw new DomainError("Player not found.", 404);
    const ids = page.rows.map((row) => row.id);
    const selectedDay = day?.id ?? dayId;
    const selectedVisits =
      selectedDay && ids.length
        ? await records<Session>(
            connection,
            `SELECT v.data FROM unnest($2::text[]) p(id) CROSS JOIN LATERAL(SELECT data,order_no,id FROM poker_visits WHERE branch_id=$1 AND player_id=p.id AND day_id=$3 ORDER BY order_no DESC,id DESC LIMIT 1) v ORDER BY v.order_no,v.id`,
            [branchId, ids, selectedDay],
          )
        : [];
    const context = await operationalSnapshot(connection, user, {
      ...playerExtra(ids, selectedDay),
      sessionIds: selectedVisits.map((visit) => visit.id),
    });
    const players = playersForDay(context.store, selectedDay).filter((player) =>
      ids.includes(player.id),
    );
    const items = ids
      .map((id) => players.find((player) => player.id === id)!)
      .filter(Boolean);
    const counts = (
      await connection.query<{ all: string; active: string; out: string }>(
        `SELECT count(*)::text AS all,count(*) FILTER(WHERE visit.status='ACTIVE')::text AS active,count(*) FILTER(WHERE COALESCE(visit.status,'OUT')='OUT')::text AS out FROM ${source} WHERE ${sqlWhere(countTarget)}`,
        countTarget.values,
      )
    ).rows[0];
    return {
      ...base,
      ...pageNumbers(page),
      items,
      context,
      revision: context.revision,
      counts: {
        ALL: checkedTotal(counts.all),
        ACTIVE: checkedTotal(counts.active),
        OUT: checkedTotal(counts.out),
      },
      ...(day ? { day, totals: totalsForDay(context.store, day.id) } : {}),
    };
  }
  if (
    query.resource === "requests" ||
    query.resource === "transactions" ||
    query.resource === "receipt"
  ) {
    const target = where(branchId, "r");
    requestFilters(target, query);
    const counts = await requestCounts(connection, target, user);
    if (query.resource === "requests") {
      if (query.id) condition(target, "r.id=?", query.id);
      else if (query.status === "MINE")
        condition(target, "r.requested_by_id=?", user.id);
      else if (query.status) {
        if (!["PENDING", "APPROVED", "REJECTED"].includes(query.status))
          throw new DomainError("Choose a valid request status.");
        condition(target, "r.status=?", query.status);
      }
      const page = await paged<{ data: ApprovalRequest }>(
        connection,
        requestSource,
        "r.data",
        target,
        "r.order_no,r.id",
        query.page,
        query.pageSize,
      );
      if (query.id && !page.total)
        throw new DomainError("Request not found.", 404);
      const items = page.rows.map((row) => row.data);
      const context = await operationalSnapshot(connection, user, {
        approvalIds: items.map((row) => row.id),
      });
      return {
        ...base,
        ...pageNumbers(page),
        items,
        context,
        revision: context.revision,
        counts,
      };
    }
    target.clauses.push("receipt.id IS NOT NULL");
    if (query.resource === "receipt") {
      if (!query.id) throw new DomainError("Choose a receipt.");
      condition(target, "receipt.id=?", query.id);
    }
    const page = await paged<{ data: Transaction }>(
      connection,
      requestSource,
      "receipt.data",
      target,
      "receipt.order_no,receipt.id",
      query.page,
      query.pageSize,
    );
    if (query.resource === "receipt" && !page.total)
      throw new DomainError("Receipt not found.", 404);
    const items = page.rows.map((row) => row.data),
      context = await operationalSnapshot(connection, user, {
        transactionIds: items.map((row) => row.id),
      });
    return {
      ...base,
      ...pageNumbers(page),
      items,
      context,
      revision: context.revision,
      counts,
    };
  }
  if (query.resource === "audit") {
    if (!["ADMIN", "MANAGER"].includes(user.role))
      throw new DomainError("Manager or admin access required.", 403);
    const target = where(branchId, "a");
    if (query.staff) condition(target, "a.actor=?", query.staff);
    if (query.action) condition(target, "a.action=?", query.action);
    const localDate =
      "(a.time::timestamptz AT TIME ZONE (SELECT timezone FROM poker_branches WHERE id=$1))::date";
    if (query.from) condition(target, localDate + ">=?::date", query.from);
    if (query.to) condition(target, localDate + "<=?::date", query.to);
    search(target, query.query, [
      "a.id",
      "a.actor",
      "a.action",
      "a.entity",
      "a.reason",
    ]);
    const page = await paged<{ data: AuditLog }>(
      connection,
      "poker_audit a",
      "a.data",
      target,
      "a.order_no,a.id",
      query.page,
      query.pageSize,
    );
    const items = page.rows.map((row) => row.data),
      context = await operationalSnapshot(connection, user, {
        auditIds: items.map((row) => row.id),
      });
    const staff = (
      await connection.query<{ actor: string }>(
        "SELECT DISTINCT actor FROM poker_audit WHERE branch_id=$1 ORDER BY actor LIMIT 200",
        [branchId],
      )
    ).rows.map((row) => row.actor);
    const actions = (
      await connection.query<{ action: string }>(
        "SELECT DISTINCT action FROM poker_audit WHERE branch_id=$1 ORDER BY action LIMIT 200",
        [branchId],
      )
    ).rows.map((row) => row.action);
    return {
      ...base,
      ...pageNumbers(page),
      items,
      context,
      revision: context.revision,
      options: { staff, actions },
    };
  }
  if (query.resource === "sessions") {
    if (!query.playerId) throw new DomainError("Choose a player.");
    const target = where(branchId, "v");
    condition(target, "v.player_id=?", query.playerId);
    if (query.status) {
      if (!["ACTIVE", "OUT"].includes(query.status))
        throw new DomainError("Choose a valid visit status.");
      condition(target, "v.status=?", query.status);
    }
    search(target, query.query, ["d.date", "t.name", "v.id"]);
    const page = await paged<{ data: Session }>(
      connection,
      "poker_visits v JOIN poker_days d ON d.branch_id=v.branch_id AND d.id=v.day_id JOIN poker_tables t ON t.branch_id=v.branch_id AND t.id=v.table_id",
      "v.data",
      target,
      "v.order_no DESC,v.id DESC",
      query.page,
      query.pageSize,
    );
    const items = page.rows.map((row) => row.data),
      context = await operationalSnapshot(connection, user, {
        playerIds: [query.playerId],
        sessionIds: items.map((row) => row.id),
      });
    return {
      ...base,
      ...pageNumbers(page),
      items,
      context,
      revision: context.revision,
    };
  }
  if (query.resource === "range") {
    if (!query.from || !query.to)
      throw new DomainError("Choose valid start and end dates.");
    // Validate and bound the range before querying; include the matching prior period.
    let emptyComparison;
    try {
      emptyComparison = compareReports(emptyStore(), query.from, query.to);
    } catch (error) {
      throw new DomainError(
        error instanceof Error ? error.message : "Choose valid dates.",
      );
    }
    const days = await records<Day>(
      connection,
      "SELECT data FROM poker_days WHERE branch_id=$1 AND date>=$2 AND date<=$3 ORDER BY date,id",
      [branchId, emptyComparison.previous.from, query.to],
    );
    const rangeStore = { ...emptyStore(), days };
    await populateReadModel(connection, branchId, rangeStore, {
      playerTotals: false,
      tableTotals: false,
      user,
    });
    const report = compareReports(rangeStore, query.from, query.to);
    const matching = report.current.days.filter(
      (day) =>
        (!query.status || day.status === query.status) &&
        (!query.query || day.date.includes(query.query.trim())),
    );
    const page = Math.min(
      query.page,
      Math.max(0, Math.ceil(matching.length / query.pageSize) - 1),
    );
    const context = await operationalSnapshot(connection, user);
    return {
      ...base,
      items: matching.slice(page * query.pageSize, (page + 1) * query.pageSize),
      total: matching.length,
      page,
      context,
      revision: context.revision,
      report,
    };
  }
  throw new DomainError("Unknown record list.");
}

export async function readPage(
  db: Database,
  token: string | undefined,
  input: unknown,
): Promise<ReadPage> {
  const query = parseReadQuery(input);
  return db.transaction(async (connection) => {
    await connection.query(
      "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    return readPageWithin(
      connection,
      await requireUser(connection, token),
      query,
    );
  });
}

function csv(rows: (string | number)[][]) {
  return "\uFEFF" + moneyCsv(rows);
}
export async function readCsv(
  db: Database,
  token: string | undefined,
  input: unknown,
) {
  const query = parseReadQuery(input);
  if (!["report", "range"].includes(query.resource))
    throw new DomainError("Choose a daily or period report.");
  return db.transaction(async (connection) => {
    await connection.query(
      "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    const user = await requireUser(connection, token);
    const completeQuery = {
      ...query,
      query: undefined,
      status: undefined,
      type: undefined,
      tag: undefined,
      staff: undefined,
      action: undefined,
      playerId: undefined,
      id: undefined,
      page: 0,
      pageSize: 50,
    };
    const first = await readPageWithin(connection, user, completeQuery);
    let rows: (string | number)[][] = [];
    let filename = "report.csv";
    if (query.resource === "range") {
      const { current, previous } = first.report!;
      rows = [
        ["Branch", displayName(first.context.branch.name)],
        ["Currency", "MYR"],
        ["Period", current.from, current.to],
        ["Comparison period", previous.from, previous.to],
        [
          "Recorded days",
          current.days.length,
          "Comparison recorded days",
          previous.days.length,
        ],
        [
          "Open days",
          current.openDays,
          "Comparison open days",
          previous.openDays,
        ],
        [
          "Pending requests (excluded from totals)",
          current.pendingRequests,
          "Comparison pending",
          previous.pendingRequests,
        ],
        [
          "Unrecorded dates are not verified zero activity. Totals contain posted entries only.",
        ],
        ["Metric", "Selected period", "Previous period", "Change"],
        ...rangeMetrics.map(([key, label]) => [
          label,
          current.totals[key] / 100,
          previous.days.length ? previous.totals[key] / 100 : "",
          current.days.length && previous.days.length
            ? (current.totals[key] - previous.totals[key]) / 100
            : "",
        ]),
        [
          "Closed-day variance",
          current.variance === null ? "" : current.variance / 100,
          previous.variance === null ? "" : previous.variance / 100,
        ],
        [],
        [
          "Daily balances are individual snapshots and must not be added together.",
        ],
        [
          "Business date",
          "Status",
          "Cash received",
          "Cash payout",
          "Opening cash",
          "Expected cash",
          "Counted cash",
          "Variance",
        ],
        ...current.days.map((day) => [
          day.date,
          day.status,
          day.totals.cashReceived / 100,
          day.totals.cashPayout / 100,
          day.openingCash / 100,
          day.totals.expectedCash / 100,
          day.totals.countedCash === null ? "" : day.totals.countedCash / 100,
          day.totals.variance === null ? "" : day.totals.variance / 100,
        ]),
      ];
      filename = `period-report-${query.from}-${query.to}.csv`;
    } else {
      const totals = first.totals!,
        day = first.day!;
      rows = [
        ["Branch", displayName(first.context.branch.name)],
        ["Business date", day.date],
        ["Currency", "MYR"],
        ["Metric", "Amount"],
        ["Opening cash", totals.openingCash / 100],
        ["Cash received", totals.cashReceived / 100],
        ["Cash payout", totals.cashPayout / 100],
        ["Expected cash", totals.expectedCash / 100],
        [
          "Counted cash",
          totals.countedCash === null ? "" : totals.countedCash / 100,
        ],
        ["Variance", totals.variance === null ? "" : totals.variance / 100],
        [],
        ["Player", "Buy-in", "Cash-out", "Settled P/L", "Status"],
      ];
      // Explicit export is separate from routine reads. It stays snapshot-consistent
      // and bounded; refuse an oversized file rather than returning a partial CSV.
      if (first.total > 50_000)
        throw new DomainError(
          "This report export is too large. Contact an administrator for a database export.",
        );
      for (let page = 0; page < Math.ceil(first.total / 50); page++) {
        const result =
          page === 0
            ? first
            : await readPageWithin(connection, user, {
                ...completeQuery,
                page,
              });
        rows.push(
          ...(result.items as Player[]).map((player) => [
            displayName(player.name),
            player.buyIn / 100,
            player.cashOut / 100,
            player.status === "ACTIVE"
              ? "Unsettled"
              : (player.cashOut - player.buyIn) / 100,
            player.status,
          ]),
        );
      }
      filename = `daily-close-${day.date}.csv`;
    }
    const value = csv(rows);
    if (Buffer.byteLength(value, "utf8") > 4_000_000)
      throw new DomainError(
        "This report export is too large. Contact an administrator for a database export.",
      );
    return { value, filename };
  });
}
