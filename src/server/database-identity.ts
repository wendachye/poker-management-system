import "server-only";
import { createHash } from "node:crypto";

/** Inputs consumed by databasePoolOptions, node-postgres and its TLS/credential
 * defaults. Retain only their digest; these values must never become diagnostics.
 */
export const DATABASE_IDENTITY_KEYS = Object.freeze([
  "NODE_ENV",
  "DATABASE_URL",
  "PGOPTIONS",
  "PGSSLMODE",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "DATABASE_POOL_MAX",
  "DATABASE_CONNECTION_TIMEOUT_MS",
  "DATABASE_IDLE_TIMEOUT_MS",
  "DATABASE_STATEMENT_TIMEOUT_MS",
  "DATABASE_LOCK_TIMEOUT_MS",
  "DATABASE_IDLE_TRANSACTION_TIMEOUT_MS",
  "PGHOST",
  "PGPORT",
  "PGUSER",
  "PGPASSWORD",
  "PGDATABASE",
  "PGAPPNAME",
  "PGCONNECT_TIMEOUT",
  "PGSSLNEGOTIATION",
  "PGCLIENT_ENCODING",
  "PGBINARY",
  "PGREPLICATION",
  "PGPASSFILE",
  "APPDATA",
  "HOME",
  "USER",
  "USERNAME",
  "NODE_EXTRA_CA_CERTS",
  "NODE_USE_SYSTEM_CA",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
] as const);

export function databasePoolIdentity(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  try {
    const selected = DATABASE_IDENTITY_KEYS.map((key) => {
      const value = env[key];
      if (value !== undefined && typeof value !== "string") throw new Error();
      return [key, value ?? null];
    });
    return createHash("sha256").update(JSON.stringify(selected)).digest("hex");
  } catch {
    throw new Error(
      "Database connection configuration could not be verified. Restart the application before continuing.",
    );
  }
}
