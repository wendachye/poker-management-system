import { loadEnvConfig } from "@next/env";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { verifyBackup } from "./verify-backup";
import { database, closeDatabase } from "../src/server/database";
import {
  backupSummary,
  createBackup,
  restoreBackup,
  type Backup,
} from "../src/server/backup";
import {
  readBackupFile,
  writeBackupFile,
  writeRecoverySnapshotFile,
} from "./backup-files";

async function save(backup: Backup, prefix: string, recoverySnapshot = false) {
  const directory = resolve(process.cwd(), ".local", "backups");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const filename = resolve(
    directory,
    `${prefix}-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}.json`,
  );
  if (recoverySnapshot) await writeRecoverySnapshotFile(filename, backup);
  else await writeBackupFile(filename, backup);
  console.log(
    (recoverySnapshot
      ? "Unverified pre-restore safety snapshot saved: "
      : "Backup saved: ") + filename,
  );
  return filename;
}
async function main() {
  const [mode, ...args] = process.argv.slice(2);
  // Offline verification must neither load .env nor require any local/cloud URL.
  if (mode === "verify") {
    if (args.length !== 1)
      throw new Error(
        'Use npm run local:verify-backup -- "path-to-full-backup.json"',
      );
    const backup = await readBackupFile(args[0]);
    console.log(JSON.stringify(backupSummary(backup), null, 2));
    await verifyBackup(backup);
    console.log(
      "Restore verified in an isolated in-memory database. Every backed-up record matches. No configured database connection was opened.",
    );
    return;
  }
  loadEnvConfig(process.cwd(), true);
  if (
    process.env.NODE_ENV === "production" ||
    process.env.DATABASE_URL !==
      "postgresql://postgres:postgres@127.0.0.1:55432/postgres"
  )
    throw new Error(
      "This command only supports the persistent local development database.",
    );
  if (mode === "backup" && !args.length) {
    const backup = await createBackup(database());
    await save(backup, "full");
    console.log(JSON.stringify(backupSummary(backup), null, 2));
    console.log(
      "This file contains account password hashes and venue records. Keep it private. Sessions are not included.",
    );
  } else if (
    mode === "restore" &&
    args[0] &&
    args.length <= 2 &&
    (!args[1] || args[1] === "--confirm")
  ) {
    const filename = resolve(args[0]);
    const backup = await readBackupFile(filename);
    console.log("Validated backup: " + filename);
    console.log(JSON.stringify(backupSummary(backup), null, 2));
    if (args[1] !== "--confirm") {
      console.log(
        "PREVIEW ONLY: no data changed. To replace ALL local branches and accounts, repeat this command with --confirm. An unverified pre-restore safety snapshot is saved automatically. All sessions will be signed out.",
      );
      return;
    }
    await restoreBackup(database(), backup, async (before) => {
      await save(before, "before-restore-unverified", true);
    });
    console.log(
      "Restore completed. All staff must sign in again using the restored accounts and passwords. The credentials.txt file is not updated by restore.",
    );
  } else
    throw new Error(
      'Use npm run local:backup OR npm run local:restore -- "path-to-full-backup.json" [--confirm]',
    );
}
main()
  .catch((error) => {
    console.error(
      error instanceof Error && "code" in error && error.code === "ECONNREFUSED"
        ? "The local database is not running. Start npm run local (or npm run local:db) in another terminal, then retry."
        : error instanceof Error
          ? error.message
          : "Local backup operation failed.",
    );
    process.exitCode = 1;
  })
  .finally(closeDatabase);
