import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { spawnSync } from "node:child_process";
import { DomainError } from "../src/domain/operations";
import { emptyStore } from "../src/domain/selectors";
import { hashPassword, login } from "../src/server/auth";
import { importStore } from "../src/server/storage";
import { readCsv } from "../src/server/queries";
import {
  csvExportBusyDetails,
  withCsvExportWork,
} from "../src/server/csv-export-work";
import type { Database } from "../src/server/database";
import { testDatabase } from "./helpers/database";

const busy = {
  status: 503,
  retryAfterSeconds: 1,
  message: "Another report is being exported. Please try again shortly.",
};
const reference = {
  actorId: "csv-admin",
  branchId: "local",
  role: "ADMIN" as const,
};
const report = { resource: "report", date: "2026-10-29" };
let fixture: Awaited<ReturnType<typeof testDatabase>>;
let token: string;

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function isBusy(error: unknown) {
  assert.deepEqual(csvExportBusyDetails(error), busy);
  return true;
}
function isCancelled(error: unknown) {
  assert.ok(error instanceof DomainError);
  assert.equal(error.status, 408);
  assert.equal(error.message, "Cannot download report. Please try again.");
  return true;
}
before(async () => {
  fixture = await testDatabase();
  const password = "fictional-csv-admission-password";
  await fixture.db.query(
    "INSERT INTO poker_users(id,username,password_hash) VALUES($1,$1,$2)",
    [reference.actorId, await hashPassword(password)],
  );
  await fixture.db.query(
    "INSERT INTO poker_memberships(user_id,branch_id,role) VALUES($1,$2,$3)",
    [reference.actorId, reference.branchId, reference.role],
  );
  const store = emptyStore();
  store.currentDayId = "csv-day";
  store.days.push({
    id: store.currentDayId,
    date: report.date,
    status: "CLOSED",
    openingCash: 0,
    openedAt: "2026-10-29T00:00:00Z",
    closes: [
      {
        actor: reference.actorId,
        time: "2026-10-29T01:00:00Z",
        countedCash: 0,
        expectedCash: 0,
        variance: 0,
        reason: "Fictional empty shift",
      },
    ],
  });
  await importStore(fixture.db, "local", store);
  token = await login(fixture.db, reference.actorId, password);
});
after(async () => fixture.engine.close());

test("one active CSV export rejects additional work immediately without a queue", async () => {
  const held = deferred();
  let starts = 0;
  const first = withCsvExportWork(async () => {
    starts++;
    await held.promise;
    return "first";
  });
  try {
    for (let index = 0; index < 5; index++)
      await assert.rejects(
        withCsvExportWork(async () => {
          starts++;
          return "must-not-run";
        }),
        isBusy,
      );
    assert.equal(starts, 1);
    assert.equal(
      await Promise.race([first, Promise.resolve("caller-stopped-waiting")]),
      "caller-stopped-waiting",
    );
    await assert.rejects(
      withCsvExportWork(() => "still busy"),
      isBusy,
    );
  } finally {
    held.resolve();
  }
  assert.equal(await first, "first");
  assert.equal(await withCsvExportWork(() => "next"), "next");
  assert.equal(starts, 1, "Rejected work is never resumed after release");
});

test("synchronous and asynchronous export failures release admission", async () => {
  await assert.rejects(
    withCsvExportWork(() => {
      throw new Error("controlled sync failure");
    }),
    /controlled sync failure/,
  );
  assert.equal(await withCsvExportWork(() => 1), 1);
  await assert.rejects(
    withCsvExportWork(async () => {
      await Promise.resolve();
      throw new Error("controlled async failure");
    }),
    /controlled async failure/,
  );
  assert.equal(await withCsvExportWork(async () => 2), 2);
});

test("busy recognition samples only stable branded fields and returns a fixed safe message", () => {
  const marker = Symbol.for("poker.csv-export.busy");
  const reads = { marker: 0, status: 0, retry: 0 };
  const duplicate = Object.defineProperties(new Error(), {
    [marker]: {
      get() {
        reads.marker++;
        return true;
      },
    },
    status: {
      get() {
        reads.status++;
        return 503;
      },
    },
    retryAfterSeconds: {
      get() {
        reads.retry++;
        return 1;
      },
    },
    message: {
      get() {
        throw new Error("private-message-must-not-be-read");
      },
    },
  });
  assert.deepEqual(csvExportBusyDetails(duplicate), busy);
  assert.deepEqual(reads, { marker: 1, status: 1, retry: 1 });
  for (const invalid of [
    null,
    {},
    { [marker]: true, status: 503, retryAfterSeconds: 1 },
    new Error("unbranded"),
    Object.assign(new Error(), {
      [marker]: true,
      status: 500,
      retryAfterSeconds: 1,
    }),
    Object.assign(new Error(), {
      [marker]: true,
      status: 503,
      retryAfterSeconds: 5,
    }),
    Object.defineProperty(new Error(), marker, {
      get() {
        throw new Error("private-marker");
      },
    }),
  ])
    assert.equal(csvExportBusyDetails(invalid), null);
});

test("duplicated server module instances share the process slot and busy marker", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--conditions=react-server",
      "--import",
      "tsx",
      "--eval",
      `(async()=>{
    const assert=require('node:assert/strict');
    const path=require.resolve('./src/server/csv-export-work.ts');
    const first=require(path);let release;
    const held=first.withCsvExportWork(()=>new Promise(resolve=>release=resolve));
    delete require.cache[path];const second=require(path);
    assert.equal(second.withCsvExportWork,first.withCsvExportWork);
    let blocked;try{await second.withCsvExportWork(()=>{throw Error('must not start')})}catch(error){blocked=second.csvExportBusyDetails(error)}
    assert.equal(blocked.status,503);assert.equal(blocked.retryAfterSeconds,1);
    release('released');await held;
    assert.equal(await second.withCsvExportWork(()=>true),true);
    console.log(JSON.stringify({shared:true,blocked,recovered:true}));
  })().catch(()=>{process.exitCode=1})`,
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 20000,
      env: {
        ...process.env,
        NODE_ENV: "test",
        NEXT_PUBLIC_POKER_PROTOTYPE: "0",
        POKER_PROTOTYPE_MODE: "0",
      },
    },
  );
  assert.equal(result.status, 0, result.stderr || String(result.error ?? ""));
  assert.deepEqual(JSON.parse(result.stdout.trim()), {
    shared: true,
    blocked: busy,
    recovered: true,
  });
});

test("busy readCsv never invokes another database transaction", async () => {
  const entered = deferred(),
    release = deferred();
  let acquisitions = 0;
  const held: Database = {
    ...fixture.db,
    async transaction(work) {
      acquisitions++;
      entered.resolve();
      await release.promise;
      return fixture.db.transaction(work);
    },
  };
  const first = readCsv(held, token, report, reference);
  try {
    await entered.promise;
    await assert.rejects(readCsv(held, token, report, reference), isBusy);
    await assert.rejects(
      readCsv(
        held,
        token,
        { resource: "range", from: report.date, to: report.date },
        reference,
      ),
      isBusy,
    );
    assert.equal(acquisitions, 1);
  } finally {
    release.resolve();
  }
  assert.ok((await first).value.includes('"Business date","2026-10-29"'));
  assert.deepEqual(
    (await readCsv(fixture.db, token, report, reference)).access,
    reference,
  );
});

test("an already cancelled CSV request does not acquire the database or retain admission", async () => {
  let acquisitions = 0;
  const unreachable: Database = {
    async query() {
      throw new Error("Must not query");
    },
    async transaction() {
      acquisitions++;
      throw new Error("Must not acquire");
    },
  };
  const abort = new AbortController();
  abort.abort(new Error("private-client-abort"));
  await assert.rejects(
    readCsv(unreachable, token, report, reference, abort.signal),
    isCancelled,
  );
  assert.equal(acquisitions, 0);
  assert.deepEqual(
    (await readCsv(fixture.db, token, report, reference)).access,
    reference,
  );
});

test("cancellation waits for the in-flight SQL and rollback cleanup before releasing admission", async () => {
  const entered = deferred(),
    releaseQuery = deferred(),
    rollingBack = deferred(),
    releaseCleanup = deferred();
  const abort = new AbortController();
  let acquisitions = 0;
  const statements: string[] = [];
  const held: Database = {
    ...fixture.db,
    async transaction(work) {
      acquisitions++;
      try {
        return await fixture.db.transaction((connection) =>
          work({
            async query<T>(sql: string, values?: unknown[]) {
              statements.push(sql);
              const result = await connection.query<T>(sql, values);
              if (sql.includes("SET TRANSACTION")) {
                entered.resolve();
                await releaseQuery.promise;
              }
              return result;
            },
          }),
        );
      } catch (error) {
        rollingBack.resolve();
        await releaseCleanup.promise;
        throw error;
      }
    },
  };
  const first = assert.rejects(
    readCsv(held, token, report, reference, abort.signal),
    isCancelled,
  );
  try {
    await entered.promise;
    abort.abort("private-cancellation-detail");
    await assert.rejects(readCsv(held, token, report, reference), isBusy);
    assert.equal(acquisitions, 1);
    releaseQuery.resolve();
    await rollingBack.promise;
    await assert.rejects(readCsv(held, token, report, reference), isBusy);
    assert.equal(acquisitions, 1);
    assert.equal(
      statements.length,
      1,
      "Abort is checked after SET and before any authentication/report SQL",
    );
  } finally {
    releaseQuery.resolve();
    releaseCleanup.resolve();
  }
  await first;
  assert.deepEqual(
    (await readCsv(fixture.db, token, report, reference)).access,
    reference,
  );
});

for (const cancel of [false, true])
  test(`CSV admission waits for complete transaction finalization${cancel ? " even after client abort" : ""}`, async () => {
    const finalizing = deferred(),
      released = deferred(),
      abort = new AbortController();
    const held: Database = {
      ...fixture.db,
      async transaction(work) {
        const value = await fixture.db.transaction(work);
        finalizing.resolve();
        await released.promise;
        return value;
      },
    };
    const operation = readCsv(held, token, report, reference, abort.signal);
    const result = cancel ? assert.rejects(operation, isCancelled) : operation;
    try {
      await finalizing.promise;
      if (cancel) abort.abort("private-finalization-abort");
      await assert.rejects(
        readCsv(fixture.db, token, report, reference),
        isBusy,
      );
    } finally {
      released.resolve();
    }
    await result;
    assert.deepEqual(
      (await readCsv(fixture.db, token, report, reference)).access,
      reference,
    );
  });

test("failed authentication or binding releases the slot for a matching retry", async () => {
  await assert.rejects(
    readCsv(fixture.db, "forged", report, reference),
    (error: unknown) => error instanceof DomainError && error.status === 401,
  );
  await assert.rejects(
    readCsv(fixture.db, token, report, { ...reference, branchId: "other" }),
    (error: unknown) => error instanceof DomainError && error.status === 409,
  );
  assert.deepEqual(
    (await readCsv(fixture.db, token, report, reference)).access,
    reference,
  );
});
