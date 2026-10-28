import type { PoolConfig } from "pg";

type DatabaseEnvironment = Record<string, string | undefined>;

const connectionOverrides = new Set([
  "options",
  "statement_timeout",
  "lock_timeout",
  "idle_in_transaction_session_timeout",
  "query_timeout",
]);

function boundedInteger(
  env: DatabaseEnvironment,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const value = env[name];
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/.test(value))
    throw new Error(
      `${name} must be an integer from ${minimum} to ${maximum}.`,
    );
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum)
    throw new Error(
      `${name} must be an integer from ${minimum} to ${maximum}.`,
    );
  return parsed;
}

/** Connection strings and PGOPTIONS must not override the application's budgets. */
export function databasePoolOptions(env: DatabaseEnvironment): PoolConfig {
  if (env.PGOPTIONS?.trim())
    throw new Error(
      "PGOPTIONS is not supported. Configure database timeouts with DATABASE_* settings.",
    );
  if (env.DATABASE_URL) {
    let connection: URL;
    try {
      connection = new URL(env.DATABASE_URL);
    } catch {
      throw new Error("DATABASE_URL must be a valid connection URL.");
    }
    for (const key of connection.searchParams.keys())
      if (connectionOverrides.has(key.toLowerCase()))
        throw new Error(
          "DATABASE_URL cannot override database timeout or startup options. Use DATABASE_* settings.",
        );
  }
  const statementTimeout = boundedInteger(
    env,
    "DATABASE_STATEMENT_TIMEOUT_MS",
    15_000,
    100,
    300_000,
  );
  const lockTimeout = boundedInteger(
    env,
    "DATABASE_LOCK_TIMEOUT_MS",
    5_000,
    100,
    60_000,
  );
  if (lockTimeout > statementTimeout)
    throw new Error(
      "DATABASE_LOCK_TIMEOUT_MS must not exceed DATABASE_STATEMENT_TIMEOUT_MS.",
    );
  return {
    max: boundedInteger(env, "DATABASE_POOL_MAX", 5, 1, 50),
    connectionTimeoutMillis: boundedInteger(
      env,
      "DATABASE_CONNECTION_TIMEOUT_MS",
      5_000,
      100,
      60_000,
    ),
    idleTimeoutMillis: boundedInteger(
      env,
      "DATABASE_IDLE_TIMEOUT_MS",
      10_000,
      1_000,
      300_000,
    ),
    statement_timeout: statementTimeout,
    lock_timeout: lockTimeout,
    idle_in_transaction_session_timeout: boundedInteger(
      env,
      "DATABASE_IDLE_TRANSACTION_TIMEOUT_MS",
      15_000,
      1_000,
      300_000,
    ),
    // Allow the server to report cancellation before the client abandons a query.
    query_timeout: statementTimeout + 5_000,
  };
}

/** Report a useful category without exposing connection strings or server details. */
export function databasePoolErrorCode(error: unknown): string {
  if (error instanceof Error) {
    const timeout = new Map([
      ["timeout exceeded when trying to connect", "POOL_ACQUIRE_TIMEOUT"],
      ["Connection terminated due to connection timeout", "CONNECTION_TIMEOUT"],
      ["Query read timeout", "QUERY_READ_TIMEOUT"],
    ]).get(error.message);
    if (timeout) return timeout;
  }
  const knownCodes = new Set([
    "ECONNRESET",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "EPIPE",
    "ENOTFOUND",
    "EAI_AGAIN",
    "57P01",
    "57P02",
    "57P03",
    "53300",
    "23503",
    "23505",
    "40001",
    "40P01",
    "55P03",
    "57014",
  ]);
  const code =
    error && typeof error === "object" && "code" in error ? error.code : null;
  return typeof code === "string" && knownCodes.has(code) ? code : "UNKNOWN";
}
