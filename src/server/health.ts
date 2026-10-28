import "server-only";
import { database, type SqlConnection } from "./database";
import { validateProductionConfig } from "./production-config";
import { schemaMigrationStatus } from "./schema";

type Environment = Readonly<Record<string, string | undefined>>;
const requiredColumns: Record<string, string[]> = {
  poker_branches: ["id", "name", "timezone"],
  poker_users: ["id", "username", "password_hash", "active"],
  poker_memberships: ["user_id", "branch_id", "role"],
  poker_sessions: ["token_hash", "user_id", "branch_id", "expires_at"],
  poker_login_attempts: ["username", "attempts", "window_start"],
  poker_login_budget: ["id", "attempts", "window_start"],
  poker_branch_state: ["branch_id", "revision", "data", "current_day_id"],
  poker_operations: [
    "branch_id",
    "operation_id",
    "actor_id",
    "fingerprint",
    "revision",
    "created_at",
    "result_context",
  ],
  poker_profiles: [
    "branch_id",
    "id",
    "data",
    "order_no",
    "last_revision",
    "name",
    "phone",
    "type",
    "credit_limit",
  ],
  poker_tables: [
    "branch_id",
    "id",
    "data",
    "order_no",
    "last_revision",
    "name",
    "status",
  ],
  poker_visits: [
    "branch_id",
    "id",
    "data",
    "order_no",
    "last_revision",
    "player_id",
    "day_id",
    "table_id",
    "seat",
    "status",
    "session_start",
  ],
  poker_days: [
    "branch_id",
    "id",
    "data",
    "order_no",
    "last_revision",
    "date",
    "status",
  ],
  poker_approvals: [
    "branch_id",
    "id",
    "data",
    "order_no",
    "last_revision",
    "player_id",
    "day_id",
    "session_id",
    "table_id",
    "status",
    "type",
    "created_at",
    "requested_by_id",
    "approval_level",
    "reverses_id",
  ],
  poker_ledger: [
    "branch_id",
    "id",
    "data",
    "order_no",
    "last_revision",
    "player_id",
    "day_id",
    "session_id",
    "table_id",
    "type",
    "amount",
    "cash_received",
    "cash_payout",
    "credit_delta",
    "time",
    "approval_id",
    "reverses_id",
  ],
  poker_audit: [
    "branch_id",
    "id",
    "data",
    "order_no",
    "last_revision",
    "time",
    "actor",
    "action",
    "entity",
    "reason",
  ],
  poker_change_versions: ["branch_id", "key", "revision"],
  poker_financial_totals: [
    "branch_id",
    "scope",
    "entity_id",
    "day_id",
    "buy_in",
    "cash_out",
    "rake",
    "tips",
    "insurance",
    "jackpot",
    "cash_received",
    "cash_payout",
    "credit_delta",
  ],
};

function response(ready: boolean, mode: "prototype" | "operations") {
  return Response.json(
    { status: ready ? "ok" : "unavailable", mode },
    {
      status: ready ? 200 : 503,
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}

/** Checks only connectivity and schema metadata; never reads venue records. */
export async function healthResponse(
  connect: () => SqlConnection = database,
  env: Environment = process.env,
) {
  const publicDemo = env.NEXT_PUBLIC_POKER_PROTOTYPE === "1";
  const serverDemo = env.POKER_PROTOTYPE_MODE === "1";
  if (publicDemo || serverDemo)
    return response(publicDemo && serverDemo, "prototype");
  try {
    if (env.NODE_ENV === "production") validateProductionConfig(env);
    const db = connect();
    await db.query("SELECT 1");
    if (!(await schemaMigrationStatus(db)).ready)
      return response(false, "operations");
    const columns = await db.query<{
      table_name: string;
      column_name: string;
    }>(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = ANY($1::text[])`,
      [Object.keys(requiredColumns)],
    );
    const present = new Set(
      columns.rows.map(
        (column) => `${column.table_name}.${column.column_name}`,
      ),
    );
    const ready = Object.entries(requiredColumns).every(([table, fields]) =>
      fields.every((field) => present.has(`${table}.${field}`)),
    );
    return response(ready, "operations");
  } catch {
    return response(false, "operations");
  }
}
