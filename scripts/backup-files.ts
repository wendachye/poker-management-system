import { createHash, randomUUID } from "node:crypto";
import * as filesystem from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { parseBackup, type Backup } from "../src/server/backup";

export const MAX_BACKUP_FILE_BYTES = 100 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
type FileAccess = Pick<typeof filesystem, "open" | "link" | "unlink">;

function tooLarge() {
  return new Error(
    "Backup exceeds the supported file-size limit. No partial backup is published.",
  );
}

/** A narrow filesystem seam permits real disk-failure tests. Production exports
 * below always use the shared 100 MiB budget; callers can only lower this limit.
 */
export function createBackupFileAccess(
  io: FileAccess = filesystem,
  limit = MAX_BACKUP_FILE_BYTES,
) {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_BACKUP_FILE_BYTES
  )
    throw new Error(
      "Use a positive backup-file budget no greater than 100 MiB.",
    );

  async function write(
    path: string,
    backup: Backup,
    recoverySnapshot: boolean,
  ) {
    if (recoverySnapshot) {
      // This is deliberately not a restorable-data assertion. Recovery must
      // retain a forensic copy of corrupt current records before replacing them.
      if (
        !backup ||
        !/^[a-f0-9]{64}$/.test(backup.checksum) ||
        createHash("sha256")
          .update(JSON.stringify(backup.payload))
          .digest("hex") !== backup.checksum
      )
        throw new Error("Recovery snapshot checksum is invalid.");
    } else parseBackup(backup);
    const encoded = Buffer.from(JSON.stringify(backup, null, 2) + "\n", "utf8");
    if (encoded.length > limit) throw tooLarge();
    const target = resolve(path);
    const temporary = join(
      dirname(target),
      `.${basename(target)}.${randomUUID()}.partial`,
    );
    let staged = false;
    let published = false;
    try {
      const handle = await io.open(temporary, "wx", 0o600);
      staged = true;
      try {
        await handle.writeFile(encoded);
        await handle.sync();
      } finally {
        await handle.close();
      }
      // A hard-link publishes a complete file atomically and, unlike rename,
      // cannot replace an existing backup even when two writers race.
      await io.link(temporary, target);
      published = true;
      await io.unlink(temporary);
      staged = false;
      if (process.platform !== "win32") {
        const directory = await io.open(dirname(target), "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
      return { bytes: encoded.length };
    } catch (error) {
      if (staged) {
        try {
          await io.unlink(temporary);
        } catch {
          /* The incomplete staging name is never a ready .json backup. */
        }
      }
      if (published)
        throw new Error(
          "The complete backup was published, but final cleanup or directory sync failed. Verify the saved file before retrying.",
          { cause: error },
        );
      throw error;
    }
  }

  async function read(path: string): Promise<Backup> {
    const handle = await io.open(resolve(path), "r");
    try {
      const details = await handle.stat();
      if (!details.isFile()) throw new Error("Choose a regular backup file.");
      if (details.size > limit) throw tooLarge();
      const chunks: Buffer[] = [];
      const buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, limit + 1));
      let total = 0;
      while (true) {
        const length = Math.min(buffer.length, limit - total + 1);
        const { bytesRead } = await handle.read(buffer, 0, length, null);
        if (!bytesRead) break;
        total += bytesRead;
        if (total > limit) throw tooLarge();
        chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
      }
      let decoded: string;
      try {
        decoded = new TextDecoder("utf-8", { fatal: true }).decode(
          Buffer.concat(chunks, total),
        );
      } catch {
        throw new Error("Backup file is not valid UTF-8.");
      }
      let input: unknown;
      try {
        input = JSON.parse(decoded);
      } catch {
        throw new Error("Backup file is not complete valid JSON.");
      }
      return parseBackup(input);
    } finally {
      await handle.close();
    }
  }
  return {
    read,
    write: (path: string, backup: Backup) => write(path, backup, false),
    writeRecoverySnapshot: (path: string, backup: Backup) =>
      write(path, backup, true),
  };
}

const files = createBackupFileAccess();
export const readBackupFile = files.read;
export const writeBackupFile = files.write;
/** Quarantined safety copy only; readBackupFile still requires valid financial data. */
export const writeRecoverySnapshotFile = files.writeRecoverySnapshot;
