import "server-only";
import { Pool } from "pg";
import { databasePoolErrorCode, databasePoolOptions } from "./database-options";
import { validateProductionConfig } from "./production-config";
import { logOperationalEvent } from "./operational-events";

export interface SqlConnection {
  query<T = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>;
}
export interface Database extends SqlConnection {
  transaction<T>(work: (connection: SqlConnection) => Promise<T>): Promise<T>;
}
const globalDatabase = globalThis as typeof globalThis & { pokerPool?: Pool };

type QueryResult = { rows: unknown[] };
interface ConnectionPool {
  query(sql: string, values?: unknown[]): Promise<QueryResult>;
  connect(): Promise<{
    query(sql: string, values?: unknown[]): Promise<QueryResult>;
    release(destroy?: boolean): void;
  }>;
}

/** The same adapter supports the real pool and isolated failure/recovery tests. */
export function databaseFromPool(pool: ConnectionPool): Database {
  return {
    async query<T>(sql: string, values?: unknown[]) {
      const result = await pool.query(sql, values);
      return { rows: result.rows as T[] };
    },
    async transaction<T>(work: (connection: SqlConnection) => Promise<T>) {
      const client = await pool.connect();
      let discard = false;
      try {
        await client.query("BEGIN");
        const result = await work({
          async query<R>(sql: string, values?: unknown[]) {
            const result = await client.query(sql, values);
            return { rows: result.rows as R[] };
          },
        });
        await client.query("COMMIT");
        return result;
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // A failed rollback leaves the connection unsafe for the next caller.
          discard = true;
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
  }
  return databaseFromPool(globalDatabase.pokerPool);
}
export async function closeDatabase() {
  await globalDatabase.pokerPool?.end();
  delete globalDatabase.pokerPool;
}
