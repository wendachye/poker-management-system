import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { sealBackup } from "../src/server/backup";
import { emptyStore } from "../src/domain/selectors";
import {
  createBackupFileAccess,
  MAX_BACKUP_FILE_BYTES,
  readBackupFile,
  writeBackupFile,
  writeRecoverySnapshotFile,
} from "../scripts/backup-files";

const backup = () =>
  sealBackup({
    format: "poker-local-backup",
    version: 1,
    createdAt: "2026-10-29T00:00:00Z",
    branches: [],
    users: [],
    memberships: [],
    states: [],
    operations: [],
  });
async function directory(work: (path: string) => Promise<void>) {
  const path = await fs.mkdtemp(join(tmpdir(), "poker-backup-files-"));
  try {
    await work(path);
  } finally {
    // Only files created in this test-owned directory; no recursive deletion.
    for (const entry of await fs.readdir(path))
      await fs.unlink(join(path, entry));
    await fs.rmdir(path);
  }
}
function wrappedHandle(
  handle: FileHandle,
  overrides: Partial<FileHandle>,
): FileHandle {
  return new Proxy(handle, {
    get(target, key) {
      const value =
        key in overrides
          ? Reflect.get(overrides, key)
          : Reflect.get(target, key);
      return typeof value === "function"
        ? value.bind(key in overrides ? overrides : target)
        : value;
    },
  });
}

test("completed backup files round-trip without changing their checksum or overwriting an existing file", async () =>
  directory(async (path) => {
    const value = backup(),
      target = join(path, "full.json");
    const result = await writeBackupFile(target, value);
    assert.equal(result.bytes, (await fs.stat(target)).size);
    assert.deepEqual(await readBackupFile(target), value);
    await assert.rejects(writeBackupFile(target, value), { code: "EEXIST" });
    assert.deepEqual(await readBackupFile(target), value);
    assert.deepEqual(await fs.readdir(path), ["full.json"]);
  }));

test("concurrent writers publish one complete backup and cannot overwrite the winner", async () =>
  directory(async (path) => {
    const first = backup(),
      second = backup();
    second.payload.createdAt = "2026-10-29T01:00:00Z";
    const resealed = sealBackup(second.payload),
      target = join(path, "shared.json");
    const outcomes = await Promise.allSettled([
      writeBackupFile(target, first),
      writeBackupFile(target, resealed),
    ]);
    assert.equal(
      outcomes.filter((value) => value.status === "fulfilled").length,
      1,
    );
    const saved = await readBackupFile(target);
    assert.ok([first.checksum, resealed.checksum].includes(saved.checksum));
    assert.deepEqual(await fs.readdir(path), ["shared.json"]);
  }));

test("the same UTF-8 size budget applies before publishing and while reading", async () =>
  directory(async (path) => {
    const payload = backup().payload;
    payload.branches.push({
      id: "local",
      name: "棋".repeat(500),
      timezone: "Asia/Kuala_Lumpur",
    });
    payload.states.push({
      branch_id: "local",
      revision: 0,
      data: emptyStore(),
    });
    const value = sealBackup(payload),
      encoded = JSON.stringify(value, null, 2) + "\n";
    const limit = encoded.length;
    assert.ok(Buffer.byteLength(encoded, "utf8") > limit);
    const files = createBackupFileAccess(fs, limit),
      target = join(path, "oversize.json");
    await assert.rejects(files.write(target, value), /size.limit/);
    assert.deepEqual(await fs.readdir(path), []);
    await fs.writeFile(target, encoded);
    await assert.rejects(files.read(target), /size.limit/);
    for (const invalid of [0, -1, 1.2, MAX_BACKUP_FILE_BYTES + 1])
      assert.throws(() => createBackupFileAccess(fs, invalid));
  }));

test("growth after the initial file check cannot bypass the read budget", async () =>
  directory(async (path) => {
    const target = join(path, "growing.json");
    await fs.writeFile(target, "x".repeat(1025));
    let bytesRead = 0;
    const files = createBackupFileAccess(
      {
        ...fs,
        open: async (...args) => {
          const handle = await fs.open(...args);
          return wrappedHandle(handle, {
            stat: (async () =>
              Object.assign(await handle.stat(), {
                size: 1,
              })) as FileHandle["stat"],
            read: (async (...readArgs: Parameters<FileHandle["read"]>) => {
              const result = await handle.read(...readArgs);
              bytesRead += result.bytesRead;
              return result;
            }) as FileHandle["read"],
          });
        },
      },
      1024,
    );
    await assert.rejects(files.read(target), /size.limit/);
    assert.equal(bytesRead, 1025);
  }));

test("an incomplete disk write or failed file flush never appears as a completed backup", async () =>
  directory(async (path) => {
    for (const failure of ["writeFile", "sync"] as const) {
      const files = createBackupFileAccess({
        ...fs,
        open: async (...args) => {
          const handle = await fs.open(...args);
          return wrappedHandle(handle, {
            [failure]: async () => {
              if (failure === "writeFile") await handle.writeFile("partial");
              throw new Error("synthetic disk failure");
            },
          });
        },
      });
      await assert.rejects(
        files.write(join(path, "incomplete.json"), backup()),
        /synthetic disk failure/,
      );
      assert.deepEqual(await fs.readdir(path), []);
    }
  }));

test("truncated, invalid UTF-8 and checksum-damaged files cannot be restored", async () =>
  directory(async (path) => {
    const target = join(path, "invalid.json");
    await fs.writeFile(target, '{"payload":');
    await assert.rejects(readBackupFile(target), /complete valid JSON/);
    await fs.writeFile(target, Buffer.from([0xff]));
    await assert.rejects(readBackupFile(target), /UTF-8/);
    const value = backup();
    value.payload.createdAt = "2026-10-29T02:00:00Z";
    await fs.writeFile(target, JSON.stringify(value));
    await assert.rejects(readBackupFile(target), /checksum/);
  }));

test("an unverified recovery snapshot preserves bad current data without claiming it is restorable", async () =>
  directory(async (path) => {
    const payload = backup().payload;
    payload.branches.push({
      id: "local",
      name: "Local",
      timezone: "Asia/Kuala_Lumpur",
    });
    payload.states.push({
      branch_id: "local",
      revision: 0,
      data: { ...emptyStore(), currentDayId: "missing-day" },
    });
    const unsafe = sealBackup(payload),
      target = join(path, "before-restore-unverified.json");
    await assert.rejects(writeBackupFile(target, unsafe), /reference/);
    await writeRecoverySnapshotFile(target, unsafe);
    assert.deepEqual(JSON.parse(await fs.readFile(target, "utf8")), unsafe);
    await assert.rejects(readBackupFile(target), /reference/);
  }));

test("offline verification works with production flags and an unusable configured database", async () =>
  directory(async (path) => {
    const target = join(path, "offline.json");
    await writeBackupFile(target, backup());
    const result = await promisify(execFile)(
      process.execPath,
      [
        "--conditions=react-server",
        "--import",
        "tsx",
        resolve("scripts/backup-local.ts"),
        "verify",
        target,
      ],
      {
        env: {
          ...process.env,
          NODE_ENV: "production",
          DATABASE_URL: "intentionally-not-a-database-url",
          APP_ORIGIN: "not-an-origin",
          NEXT_PUBLIC_POKER_PROTOTYPE: "1",
          POKER_PROTOTYPE_MODE: "1",
        },
        windowsHide: true,
        timeout: 30000,
      },
    );
    assert.match(
      result.stdout,
      /Restore verified in an isolated in-memory database/,
    );
    assert.match(result.stdout, /No configured database connection was opened/);
    assert.equal(result.stderr, "");
  }));
