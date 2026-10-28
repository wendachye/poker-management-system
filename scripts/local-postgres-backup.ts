import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { Database } from "../src/server/database";
import { captureBackup, backupSummary } from "../src/server/backup";
import { schemaMigrationStatus } from "../src/server/schema";
import { readBackupFile, writeBackupFile } from "./backup-files";
import { verifyBackup } from "./verify-backup";
import { NATIVE_DATABASE, NATIVE_SCHEMA } from "./local-postgres-setup";

/** Maintenance read through the restricted app identity. No setup, migrations,
 * grants, imports or live restore occur on this path.
 */
export async function backupNativeSamples(
  db: Database,
  directory: string,
  workspace: string,
  databaseName = NATIVE_DATABASE,
) {
  const backup = await db.transaction(async (connection) => {
    await connection.query(
      "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    const target = (
      await connection.query<{ database: string; schema: string }>(
        "SELECT current_database() AS database,current_schema() AS schema",
      )
    ).rows[0];
    if (target?.database !== databaseName || target.schema !== NATIVE_SCHEMA)
      throw new Error(
        "Backup requires the initialized native local sample database and its runtime schema.",
      );
    const marker = (
      await connection.query<{ present: boolean }>(
        "SELECT to_regclass($1) IS NOT NULL AS present",
        [`${NATIVE_SCHEMA}.poker_local_runtime`],
      )
    ).rows[0]?.present;
    if (!marker)
      throw new Error(
        "Native local samples are not initialized. Start npm run local:postgres first; backup never initializes records.",
      );
    const stored = (
      await connection.query<{ value: string }>(
        "SELECT value FROM poker_local_runtime WHERE key='workspace'",
      )
    ).rows[0]?.value;
    if (stored !== workspace)
      throw new Error(
        "The sample database belongs to another workspace. Backup was refused.",
      );
    if (!(await schemaMigrationStatus(connection)).ready)
      throw new Error(
        "Native sample migrations are not ready. Backup does not apply migrations; review the local launcher first.",
      );
    return captureBackup(connection);
  });
  const folder = resolve(directory);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const filename = resolve(
    folder,
    `native-full-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}.json`,
  );
  const { bytes } = await writeBackupFile(filename, backup);
  try {
    // Verify the actual published file, not just the in-memory source object.
    await verifyBackup(await readBackupFile(filename));
  } catch {
    throw new Error(
      `The private backup was saved at ${filename}, but isolated restore verification failed. Preserve and investigate the file before relying on it. The running database was not restored or changed.`,
    );
  }
  return {
    status: "verified" as const,
    filename,
    bytes,
    checksum: backup.checksum,
    ...backupSummary(backup),
    readOnlyCapture: true,
    isolatedRestoreVerified: true,
  };
}
