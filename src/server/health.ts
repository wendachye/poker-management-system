import "server-only";
import { randomUUID } from "node:crypto";
import { database, type SqlConnection } from "./database";
import { databasePoolErrorCode } from "./database-options";
import { logOperationalEvent } from "./operational-events";
import { validateProductionConfig } from "./production-config";
import { schemaMigrationStatus } from "./schema";

export type HealthEnvironment = Readonly<Record<string, string | undefined>>;
export type HealthFailureReason =
  | "CONFIGURATION"
  | "DATABASE"
  | "SCHEMA"
  | "PROTOTYPE_FLAGS"
  | "PROBE_TIMEOUT"
  | "PROBE_BUSY";
export type HealthOutcome =
  | { readonly ready: true; readonly mode: "prototype" | "operations" }
  | {
      readonly ready: false;
      readonly mode: "prototype" | "operations";
      readonly reason: HealthFailureReason;
      readonly code?: string;
    };
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

/** Each caller gets a fresh receipt and correlation ID, including cached checks. */
export function healthOutcomeResponse(outcome: HealthOutcome) {
  const requestId = randomUUID();
  if (!outcome.ready)
    logOperationalEvent({
      event: "readiness_failed",
      requestId,
      reason: outcome.reason,
      ...(outcome.code === undefined ? {} : { code: outcome.code }),
    });
  return Response.json(
    { status: outcome.ready ? "ok" : "unavailable", mode: outcome.mode },
    {
      status: outcome.ready ? 200 : 503,
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Request-ID": requestId,
      },
    },
  );
}

/** Fast gates must run even when the database outcome is cached. */
export function healthPreflight(
  env: HealthEnvironment,
): HealthOutcome | undefined {
  try {
    const publicDemo = env.NEXT_PUBLIC_POKER_PROTOTYPE === "1";
    const serverDemo = env.POKER_PROTOTYPE_MODE === "1";
    if (publicDemo || serverDemo)
      return publicDemo && serverDemo
        ? { ready: true, mode: "prototype" }
        : { ready: false, mode: "prototype", reason: "PROTOTYPE_FLAGS" };
    if (env.NODE_ENV === "production") validateProductionConfig(env);
  } catch (error) {
    return {
      ready: false,
      mode: "operations",
      reason: "CONFIGURATION",
      code: databasePoolErrorCode(error),
    };
  }
}

/** Probe only connectivity/schema metadata; retain no venue records or receipt. */
export async function probeHealth(
  connect: () => SqlConnection = database,
  env: HealthEnvironment = process.env,
): Promise<HealthOutcome> {
  const preflight = healthPreflight(env);
  if (preflight) return preflight;
  let stage: "DATABASE" | "SCHEMA" = "DATABASE";
  try {
    const db = connect();
    await db.query("SELECT 1");
    stage = "SCHEMA";
    if (!(await schemaMigrationStatus(db)).ready)
      return { ready: false, mode: "operations", reason: "SCHEMA" };
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
    return ready
      ? { ready: true, mode: "operations" }
      : { ready: false, mode: "operations", reason: "SCHEMA" };
  } catch (error) {
    return {
      ready: false,
      mode: "operations",
      reason: stage,
      code: databasePoolErrorCode(error),
    };
  }
}

/** Fresh uncached checks remain available for maintenance and isolated tests. */
export async function healthResponse(
  connect: () => SqlConnection = database,
  env: HealthEnvironment = process.env,
) {
  return healthOutcomeResponse(await probeHealth(connect, env));
}
