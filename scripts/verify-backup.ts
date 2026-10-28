import { PGlite } from "@electric-sql/pglite";
import { isDeepStrictEqual } from "node:util";
import type { Database, SqlConnection } from "../src/server/database";
import { migrate } from "../src/server/schema";
import {
  createBackup,
  restoreBackup,
  type Backup,
  type BackupPayload,
} from "../src/server/backup";

function comparable(payload: BackupPayload) {
  return {
    ...payload,
    createdAt: "",
    // Older format-v1 backups predate bounded retry contexts. Restore deliberately
    // materializes their database default; no authoritative history is changed.
    operations: payload.operations.map((operation) => ({
      ...operation,
      result_context: operation.result_context ?? {},
    })),
  };
}

/** Exercise the real restore against a disposable in-memory database, never the local socket. */
export async function verifyBackup(backup: Backup) {
  const engine = await PGlite.create();
  const adapt = (connection: Pick<PGlite, "query">): SqlConnection => ({
    async query<T>(sql: string, values?: unknown[]) {
      return { rows: (await connection.query<T>(sql, values)).rows };
    },
  });
  const db: Database = {
    ...adapt(engine),
    transaction: (work) =>
      engine.transaction((tx) => work(adapt(tx as unknown as PGlite))),
  };
  try {
    await migrate(db);
    await restoreBackup(db, backup, async () => {});
    const restored = await createBackup(db);
    if (
      !isDeepStrictEqual(
        comparable(restored.payload),
        comparable(backup.payload),
      )
    )
      throw new Error("Restored records do not match the backup.");
  } finally {
    await engine.close();
  }
}
