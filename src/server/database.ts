import "server-only";
import { Pool } from "pg";

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

export function database(): Database {
  if (process.env.POKER_PROTOTYPE_MODE === "1")
    throw new Error(
      "Live database access is disabled in the frontend prototype.",
    );
  if (!process.env.DATABASE_URL)
    throw new Error(
      "DATABASE_URL is not configured. Complete the database setup before signing in.",
    );
  const pool = (globalDatabase.pokerPool ??= new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 5,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 10000,
  }));
  return {
    async query<T>(sql: string, values?: unknown[]) {
      const result = await pool.query(sql, values);
      return { rows: result.rows as T[] };
    },
    async transaction<T>(work: (connection: SqlConnection) => Promise<T>) {
      const client = await pool.connect();
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
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
export async function closeDatabase() {
  await globalDatabase.pokerPool?.end();
  delete globalDatabase.pokerPool;
}
