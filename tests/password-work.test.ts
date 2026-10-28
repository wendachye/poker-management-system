import test from "node:test";
import assert from "node:assert/strict";
import { scryptSync } from "node:crypto";
import { hashPassword, login, verifyPassword } from "../src/server/auth";
import {
  AuthAdmissionError,
  authAdmissionRetryAfter,
  createWorkGate,
  PASSWORD_WORK_LIMITS,
  withPasswordWork,
} from "../src/server/password-work";
import {
  LOGIN_WORK_LIMITS,
  withLoginAdmission,
} from "../src/server/login-admission";
import type { Database } from "../src/server/database";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test("password work bounds active jobs and queue size, preserves FIFO, and recovers after failure", async () => {
  const run = createWorkGate({ active: 2, queued: 2, waitMs: 1000 });
  const first = deferred(),
    second = deferred();
  const started: number[] = [];
  const one = run(async () => {
    started.push(1);
    await first.promise;
    return 1;
  });
  const two = run(async () => {
    started.push(2);
    await second.promise;
    throw new Error("controlled failure");
  });
  const failed = assert.rejects(two, /controlled failure/);
  const three = run(async () => {
    started.push(3);
    return 3;
  });
  const four = run(async () => {
    started.push(4);
    return 4;
  });
  await assert.rejects(
    run(async () => 5),
    (error: unknown) =>
      error instanceof AuthAdmissionError &&
      error.status === 503 &&
      authAdmissionRetryAfter(error) === 5,
  );
  assert.deepEqual(started, [1, 2]);
  first.resolve();
  assert.equal(await one, 1);
  assert.equal(await three, 3);
  assert.equal(await four, 4);
  assert.deepEqual(started, [1, 2, 3, 4]);
  second.resolve();
  await failed;
  assert.equal(await run(async () => "recovered"), "recovered");
});

test("queue timeouts discard waiting work without releasing an unfinished native job", async () => {
  const run = createWorkGate({ active: 1, queued: 1, waitMs: 100 });
  const held = deferred();
  let executed = 0;
  const native = run(async () => {
    await held.promise;
    return "done";
  });
  await assert.rejects(
    run(async () => {
      executed++;
    }),
    AuthAdmissionError,
  );
  assert.equal(executed, 0);
  const next = run(async () => {
    executed++;
    return "next";
  });
  await Promise.resolve();
  assert.equal(executed, 0, "A timed-out waiter must not free running work");
  held.resolve();
  assert.equal(await native, "done");
  assert.equal(await next, "next");
  assert.equal(executed, 1);
  assert.equal(await run(async () => "free"), "free");
});

test("late timer delivery cannot start queued work after its admission deadline", async () => {
  const run = createWorkGate({ active: 1, queued: 1, waitMs: 10 });
  const held = deferred();
  let executed = false;
  const native = run(() => held.promise);
  const waiting = assert.rejects(
    run(async () => {
      executed = true;
    }),
    AuthAdmissionError,
  );
  await Promise.resolve();
  const until = performance.now() + 25;
  while (performance.now() < until) {
    // Deliberately delay timer delivery while the admission deadline elapses.
  }
  held.resolve();
  await native;
  await waiting;
  assert.equal(executed, false);
  assert.equal(await run(async () => "available"), "available");
});

test("login admission precedes database work and the shared KDF gate covers password verification", async () => {
  assert.deepEqual(LOGIN_WORK_LIMITS, { active: 8, queued: 64, waitMs: 5000 });
  assert.deepEqual(PASSWORD_WORK_LIMITS, {
    active: 4,
    queued: 64,
    waitMs: 5000,
  });
  const held = deferred();
  const loginHolders = Array.from({ length: 8 }, () =>
    withLoginAdmission(() => held.promise),
  );
  let queries = 0;
  const db: Database = {
    async query() {
      queries++;
      throw new Error("Controlled database stop");
    },
    async transaction() {
      throw new Error("Must not start a transaction");
    },
  };
  const attempt = login(db, "known", "local");
  const stopped = assert.rejects(attempt, /Controlled database stop/);
  await Promise.resolve();
  assert.equal(queries, 0, "Queued login must not enter the database");
  held.resolve();
  await Promise.all(loginHolders);
  await stopped;
  assert.equal(queries, 1);

  const native = deferred();
  const workers = Array.from({ length: 4 }, () =>
    withPasswordWork(() => native.promise),
  );
  let completed = 0;
  const checks = [
    undefined,
    "unsupported:salt:digest",
    "scrypt:not-a-valid-hash",
  ].map((encoded) =>
    verifyPassword("local", encoded).then((value) => {
      completed++;
      return value;
    }),
  );
  await Promise.resolve();
  assert.equal(
    completed,
    0,
    "Missing and malformed hashes must perform queued dummy work",
  );
  assert.equal(
    await verifyPassword("x".repeat(129)),
    false,
    "Oversized passwords never consume KDF work",
  );
  native.resolve();
  await Promise.all(workers);
  assert.deepEqual(await Promise.all(checks), [false, false, false]);
});

test("only exact current password hashes authenticate while existing short local passwords still verify", async () => {
  const encoded = await hashPassword("test-password-parser");
  assert.equal(await verifyPassword("test-password-parser", encoded), true);
  assert.equal(await verifyPassword("wrong-password", encoded), false);
  for (const invalid of [
    encoded.replace(/^scrypt:/, "unsupported:"),
    encoded + "\n",
    encoded + ":extra",
    encoded.toUpperCase(),
    "scrypt:" + "a".repeat(200_000),
  ])
    assert.equal(await verifyPassword("test-password-parser", invalid), false);
  const salt = "0123456789abcdef0123456789abcdef";
  const short = `scrypt:${salt}:${scryptSync("admin", salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString("hex")}`;
  assert.equal(await verifyPassword("admin", short), true);
  assert.equal(await verifyPassword("", short), false);
  await assert.rejects(hashPassword("admin"), /between 12 and 128/);
});

test("retry advice is bounded and reserved to authentication admission errors", () => {
  assert.equal(authAdmissionRetryAfter(new Error("ordinary")), null);
  assert.equal(
    authAdmissionRetryAfter({ status: 429, retryAfterSeconds: 12 }),
    null,
  );
  assert.equal(
    authAdmissionRetryAfter(new AuthAdmissionError("quota", 429, 60)),
    60,
  );
  for (const retry of [0, -1, 901, Number.NaN, Number.POSITIVE_INFINITY, 1.2])
    assert.equal(
      authAdmissionRetryAfter(new AuthAdmissionError("bad", 429, retry)),
      null,
    );
  for (const invalid of [
    { active: 0, queued: 1, waitMs: 1 },
    { active: 1, queued: -1, waitMs: 1 },
    { active: 1, queued: 1, waitMs: 0 },
  ])
    assert.throws(() => createWorkGate(invalid));
});
