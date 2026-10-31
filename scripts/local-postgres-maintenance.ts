import type { PoolConfig } from "pg";
import {
  databasePoolErrorCode,
  databasePoolOptions,
} from "../src/server/database-options";

/** Startup performs migrations and full-history verification, so it receives a
 * deliberate longer statement budget than routine application queries. Only
 * the guarded launcher's supplied connection is used; global DATABASE_* values
 * cannot change these limits. Nonempty PGOPTIONS is refused, and explicit
 * startup options also prevent pg from inheriting a later PGOPTIONS value.
 */
export function maintenancePoolOptions(connectionString: string): PoolConfig {
  if (!connectionString)
    throw new Error(
      "Native local maintenance requires its guarded database connection.",
    );
  return {
    ...databasePoolOptions({
      DATABASE_URL: connectionString,
      PGOPTIONS: process.env.PGOPTIONS,
      DATABASE_POOL_MAX: "1",
      DATABASE_CONNECTION_TIMEOUT_MS: "5000",
      DATABASE_IDLE_TIMEOUT_MS: "10000",
      DATABASE_STATEMENT_TIMEOUT_MS: "60000",
      DATABASE_LOCK_TIMEOUT_MS: "5000",
      DATABASE_IDLE_TRANSACTION_TIMEOUT_MS: "15000",
    }),
    // A truthy value is intentional: pg treats options:"" as absent and then
    // reads PGOPTIONS. These options preserve each role's default search_path.
    options:
      "-c statement_timeout=60000 -c lock_timeout=5000 -c idle_in_transaction_session_timeout=15000",
  };
}

/** Fixed maintenance feedback only. Unknown failures keep the launcher's
 * existing fallback; driver messages, URLs and arbitrary error accessors are
 * never interpolated into a recognized timeout message.
 */
export function nativeMaintenanceMessage(error: unknown): string | null {
  switch (databasePoolErrorCode(error)) {
    case "55P03":
      return "Local PostgreSQL maintenance could not acquire a database lock within five seconds. Let the other operation finish, then retry the launcher. Preserve the existing volume and private configuration.";
    case "57014":
      return "Local PostgreSQL maintenance was cancelled or exceeded its statement budget. Review database activity, then retry the launcher. Preserve the existing volume and private configuration.";
    case "QUERY_READ_TIMEOUT":
      return "Local PostgreSQL maintenance could not confirm a query result within its deadline. Review database activity before retrying the launcher. Preserve the existing volume and private configuration.";
    case "POOL_ACQUIRE_TIMEOUT":
    case "CONNECTION_TIMEOUT":
    case "ECONNREFUSED":
    case "ETIMEDOUT":
    case "57P03":
      return "Local PostgreSQL maintenance could not establish its database connection. Check Docker Desktop and the owned database, then retry the launcher. Preserve the existing volume and private configuration.";
    default:
      return null;
  }
}
