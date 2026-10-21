import { loadEnvConfig } from "@next/env";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { verifyBackup } from "./verify-backup";
import { database, closeDatabase } from "../src/server/database";
import {
  backupSummary,
  createBackup,
  parseBackup,
  restoreBackup,
  type Backup,
} from "../src/server/backup";

loadEnvConfig(process.cwd(), true);
async function save(backup: Backup, prefix: string) {
  const directory = resolve(process.cwd(), ".local", "backups");
  await mkdir(directory, { recursive: true });
  const filename = resolve(
    directory,
    `${prefix}-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}.json`,
  );
  await writeFile(filename, JSON.stringify(backup, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  console.log("Backup saved: " + filename);
  return filename;
}
async function main() {
  if (
    process.env.NODE_ENV === "production" ||
    process.env.DATABASE_URL !==
      "postgresql://postgres:postgres@127.0.0.1:55432/postgres"
  )
    throw new Error(
      "This command only supports the persistent local development database.",
    );
  const [mode, ...args] = process.argv.slice(2);
  if (mode === "backup" && !args.length) {
    const backup = await createBackup(database());
    await save(backup, "full");
    console.log(JSON.stringify(backupSummary(backup), null, 2));
    console.log(
      "This file contains account password hashes and venue records. Keep it private. Sessions are not included.",
    );
  } else if (
    (mode === "restore" || mode === "verify") &&
    args[0] &&
    args.length <= 2 &&
    (!args[1] || args[1] === "--confirm")
  ) {
    const filename = resolve(args[0]);
    if ((await stat(filename)).size > 100 * 1024 * 1024)
      throw new Error("Backup exceeds the 100 MB local restore limit.");
    const backup = parseBackup(JSON.parse(await readFile(filename, "utf8")));
    console.log("Validated backup: " + filename);
    console.log(JSON.stringify(backupSummary(backup), null, 2));
    if (mode === "verify") {
      await verifyBackup(backup);
      console.log(
        "Restore verified in an isolated in-memory database. Every backed-up record matches. Your persistent local database was not changed.",
      );
      return;
    }
    if (args[1] !== "--confirm") {
      console.log(
        "PREVIEW ONLY: no data changed. To replace ALL local branches and accounts, repeat this command with --confirm. A full pre-restore backup is saved automatically. All sessions will be signed out.",
      );
      return;
    }
    await restoreBackup(database(), backup, async (before) => {
      await save(before, "before-restore");
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
