import "server-only";
import { Pool } from "pg";
import { databasePoolErrorCode, databasePoolOptions } from "./database-options";
import { validateProductionConfig } from "./production-config";
import { logOperationalEvent } from "./operational-events";
import { databasePoolIdentity } from "./database-identity";

export interface SqlConnection {
  query<T = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>;
}
export interface Database extends SqlConnection {
  transaction<T>(work: (connection: SqlConnection) => Promise<T>): Promise<T>;
}
const globalDatabase = globalThis as typeof globalThis & {
  pokerPool?: Pool;
  pokerPoolIdentity?: { pool: Pool; signature: string };
};

type QueryResult = { rows: unknown[] };
interface ConnectionPool {
  query(sql: string, values?: unknown[]): Promise<QueryResult>;
  connect(): Promise<{
    query(sql: string, values?: unknown[]): Promise<QueryResult>;
    release(destroy?: boolean): void;
  }>;
}

/** The same adapter supports the real pool and isolated failure/recovery tests. */
export function databaseFromPool(
  pool: ConnectionPool,
  verify?: () => void,
): Database {
  return {
    async query<T>(sql: string, values?: unknown[]) {
      if (!verify) {
        const result = await pool.query(sql, values);
        return { rows: result.rows as T[] };
      }
      verify();
      const client = await pool.connect();
      let discard = false;
      try {
        // A queued acquisition can finish after environment/pool replacement.
        verify();
        const result = await client.query(sql, values);
        return { rows: result.rows as T[] };
      } catch (error) {
        discard = true;
        throw error;
      } finally {
        if (discard) client.release(true);
        else client.release();
      }
    },
    async transaction<T>(work: (connection: SqlConnection) => Promise<T>) {
      verify?.();
      const client = await pool.connect();
      let discard = false;
      let beginAttempted = false;
      const check = () => {
        try {
          verify?.();
        } catch (error) {
          discard = true;
          throw error;
        }
      };
      try {
        check();
        beginAttempted = true;
        await client.query("BEGIN");
        const result = await work({
          async query<R>(sql: string, values?: unknown[]) {
            check();
            const result = await client.query(sql, values);
            return { rows: result.rows as R[] };
          },
        });
        check();
        await client.query("COMMIT");
        return result;
      } catch (error) {
        try {
          verify?.();
        } catch {
          discard = true;
        }
        if (beginAttempted) {
          try {
            // Cleanup must remain possible after the identity guard has failed.
            await client.query("ROLLBACK");
          } catch {
            // A failed rollback leaves the connection unsafe for the next caller.
            discard = true;
          }
        }
        throw error;
      } finally {
        if (discard) client.release(true);
        else client.release();
      }
    },
  };
}

export function database(): Database {
  if (
    process.env.POKER_PROTOTYPE_MODE === "1" ||
    process.env.NEXT_PUBLIC_POKER_PROTOTYPE === "1"
  )
    throw new Error(
      "Live database access is disabled in the frontend prototype.",
    );
  if (process.env.NODE_ENV === "production")
    validateProductionConfig(process.env);
  if (!process.env.DATABASE_URL)
    throw new Error(
      "DATABASE_URL is not configured. Complete the database setup before signing in.",
    );
  const identity = databasePoolIdentity();
  if (
    globalDatabase.pokerPool &&
    (globalDatabase.pokerPoolIdentity?.pool !== globalDatabase.pokerPool ||
      globalDatabase.pokerPoolIdentity?.signature !== identity)
  )
    throw new Error(
      "Database connection configuration changed or its existing pool cannot be verified. Restart the application before continuing.",
    );
  if (!globalDatabase.pokerPool) {
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ...databasePoolOptions(process.env),
    });
    pool.on("error", (error) => {
      logOperationalEvent({
        event: "database_pool_error",
        code: databasePoolErrorCode(error),
      });
    });
    globalDatabase.pokerPool = pool;
    globalDatabase.pokerPoolIdentity = { pool, signature: identity };
  }
  const pool = globalDatabase.pokerPool;
  return databaseFromPool(pool, () => {
    if (
      process.env.POKER_PROTOTYPE_MODE === "1" ||
      process.env.NEXT_PUBLIC_POKER_PROTOTYPE === "1"
    )
      throw new Error(
        "Live database access is disabled in the frontend prototype.",
      );
    if (process.env.NODE_ENV === "production")
      validateProductionConfig(process.env);
    if (
      globalDatabase.pokerPool !== pool ||
      globalDatabase.pokerPoolIdentity?.pool !== pool ||
      globalDatabase.pokerPoolIdentity?.signature !== identity ||
      databasePoolIdentity() !== identity
    )
      throw new Error(
        "Database connection configuration changed or its existing pool cannot be verified. Restart the application before continuing.",
      );
  });
}
export async function closeDatabase() {
  const pool = globalDatabase.pokerPool;
  try {
    await pool?.end();
  } finally {
    if (globalDatabase.pokerPool === pool) {
      delete globalDatabase.pokerPool;
      delete globalDatabase.pokerPoolIdentity;
    }
  }
}
