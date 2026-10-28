import type { Command } from "../domain/commands";
import type {
  ApprovalRequest,
  Session,
  Store,
  Transaction,
} from "../domain/model";
import { normalizePhone } from "../domain/operations";
import { emptyStore } from "../domain/selectors";
import type { SqlConnection } from "./database";
import { populateReadModel } from "./aggregates";

/** Load only the records a command validates or changes, with exact SQL totals. */
export async function loadCommandStore(
  connection: SqlConnection,
  branchId: string,
  metadata: Pick<Store, "settings" | "currentDayId">,
  command: Command,
): Promise<Store> {
  const store = { ...emptyStore(), ...metadata };
  async function records<T>(
    table: string,
    predicate: string,
    values: unknown[] = [],
    order = "order_no ASC",
    limit?: number,
  ) {
    const result = await connection.query<{ data: T }>(
      `SELECT data FROM ${table} WHERE branch_id=$1 AND (${predicate}) ORDER BY ${order}${limit ? ` LIMIT ${limit}` : ""}`,
      [branchId, ...values],
    );
    return result.rows.map((row) => row.data);
  }
  store.days = await records(
    "poker_days",
    "id=$2 OR id=(SELECT id FROM poker_days WHERE branch_id=$1 ORDER BY date DESC,id DESC LIMIT 1)",
    [store.currentDayId],
  );
  // Rules validation may inspect inherited overrides. Table configurations are
  // physical venue resources, rather than ledger/history-sized collections.
  store.tables = await records("poker_tables", "true");
  const playerIds = new Set<string>();
  const sessionIds = new Set<string>();
  const originalIds = new Set<string>();
  const approvalIds = new Set<string>();
  const seats: { tableId: string; seat: number }[] = [];
  const addPlayer = (id?: string) => {
    if (id) playerIds.add(id);
  };
  const addSession = (id?: string) => {
    if (id) sessionIds.add(id);
  };
  const addOriginal = (id?: string) => {
    if (id) originalIds.add(id);
  };
  if ("playerId" in command) addPlayer(command.playerId);
  if (command.kind === "SWAP_SEATS")
    for (const participant of [command.first, command.second]) {
      addPlayer(participant.playerId);
      addSession(participant.sessionId);
      seats.push({ tableId: participant.tableId, seat: participant.seat });
    }
  if (command.kind === "CHECK_IN" || command.kind === "MOVE")
    seats.push({ tableId: command.tableId, seat: command.seat });
  if (command.kind === "CORRECT") addOriginal(command.transactionId);
  if (command.kind === "DECIDE") {
    approvalIds.add(command.approvalId);
    store.approvals = await records<ApprovalRequest>(
      "poker_approvals",
      "id=$2",
      [command.approvalId],
    );
    const request = store.approvals[0];
    addPlayer(request?.playerId);
    addSession(request?.sessionId);
    addOriginal(request?.reversesId);
  }
  if (originalIds.size || approvalIds.size) {
    store.transactions = await records<Transaction>(
      "poker_ledger",
      "id=ANY($2::text[]) OR reverses_id=ANY($2::text[]) OR approval_id=ANY($3::text[])",
      [[...originalIds], [...approvalIds]],
      "order_no DESC",
    );
    for (const transaction of store.transactions) {
      addPlayer(transaction.playerId);
      addSession(transaction.sessionId);
    }
  }
  if (command.kind === "CHECK_IN") {
    store.profiles = await records(
      "poker_profiles",
      "id=ANY($2::text[]) OR phone=$3",
      [[...playerIds], normalizePhone(command.phone)],
    );
    for (const player of store.profiles) addPlayer(player.id);
  } else if (playerIds.size)
    store.profiles = await records("poker_profiles", "id=ANY($2::text[])", [
      [...playerIds],
    ]);

  if (sessionIds.size) {
    store.sessions = await records<Session>(
      "poker_visits",
      "id=ANY($2::text[])",
      [[...sessionIds]],
    );
    // A reversal of a cash-out reopens its original seat only if still empty.
    if (command.kind === "CORRECT" || command.kind === "DECIDE")
      for (const session of store.sessions)
        seats.push({ tableId: session.tableId, seat: session.seat });
  }
  if (playerIds.size || seats.length) {
    const conditions = seats.map(
      (_, index) => `(table_id=$${index * 2 + 5} AND seat=$${index * 2 + 6})`,
    );
    const visits = await records<Session>(
      "poker_visits",
      `id=ANY($2::text[]) OR (status='ACTIVE' AND (player_id=ANY($3::text[])${conditions.length ? ` OR ${conditions.join(" OR ")}` : ""})) OR id IN (SELECT DISTINCT ON (player_id) id FROM poker_visits WHERE branch_id=$1 AND player_id=ANY($3::text[]) AND NOT(id=ANY($4::text[])) ORDER BY player_id,session_start DESC,order_no DESC)`,
      [
        [...sessionIds],
        [...playerIds],
        [...sessionIds],
        ...seats.flatMap((value) => [value.tableId, value.seat]),
      ],
    );
    store.sessions = visits;
  }
  async function blocker(predicate: string, values: unknown[] = []) {
    const rows = await records<ApprovalRequest>(
      "poker_approvals",
      `status='PENDING' AND (${predicate}) AND NOT(id=ANY($${values.length + 2}::text[]))`,
      [...values, [...approvalIds]],
      "order_no DESC",
      1,
    );
    for (const value of rows)
      if (!store.approvals.some((existing) => existing.id === value.id))
        store.approvals.push(value);
  }
  if (command.kind === "CLOSE_DAY") {
    store.sessions = await records(
      "poker_visits",
      "status='ACTIVE'",
      [],
      "order_no ASC",
      1,
    );
    await blocker("true");
  } else if (
    command.kind === "TABLE" &&
    command.status === "CLOSED" &&
    command.tableId
  ) {
    store.sessions = await records(
      "poker_visits",
      "status='ACTIVE' AND table_id=$2",
      [command.tableId],
      "order_no ASC",
      1,
    );
    await blocker("table_id=$2", [command.tableId]);
  } else if (command.kind === "MOVE") {
    await blocker("session_id=ANY($2::text[])", [
      store.sessions
        .filter(
          (value) => playerIds.has(value.playerId) && value.status === "ACTIVE",
        )
        .map((value) => value.id),
    ]);
  } else if (command.kind === "SWAP_SEATS") {
    await blocker("player_id=ANY($2::text[]) OR session_id=ANY($3::text[])", [
      [...playerIds],
      store.sessions
        .filter((value) => playerIds.has(value.playerId))
        .map((value) => value.id),
    ]);
  } else if (command.kind === "REQUEST" && command.type === "Buy-in") {
    await blocker("player_id=$2 AND type='Cash-out'", [command.playerId]);
  } else if (
    (command.kind === "REQUEST" && command.type === "Cash-out") ||
    (command.kind === "DECIDE" && store.approvals[0]?.type === "Cash-out")
  ) {
    const sessionId =
      command.kind === "DECIDE"
        ? store.approvals[0]?.sessionId
        : store.sessions.find(
            (value) =>
              value.playerId === command.playerId && value.status === "ACTIVE",
          )?.id;
    await blocker("session_id=$2", [sessionId]);
  }
  if (command.kind === "CORRECT")
    await blocker("reverses_id=$2", [command.transactionId]);
  return populateReadModel(connection, branchId, store, {
    summary: false,
    dayTotals: command.kind === "CLOSE_DAY",
    playerTotals: false,
    tableTotals: false,
  });
}
