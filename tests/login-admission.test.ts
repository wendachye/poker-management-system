import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "./helpers/database";
import {
  claimLoginAttempt,
  clearSuccessfulLoginAttempt,
  LOGIN_LIMITS,
} from "../src/server/login-admission";
import { AuthAdmissionError } from "../src/server/password-work";
import { login } from "../src/server/auth";

async function fixture() {
  const result = await testDatabase();
  await result.db.query(
    "INSERT INTO poker_users(id,username,password_hash) VALUES('known','known','not-a-login-hash')",
  );
  return result;
}

test("global admission counts rotating names and all outcomes before password work, then resets its fixed window", async () => {
  const { db, engine } = await fixture();
  try {
    assert.equal(LOGIN_LIMITS.anonymousBuckets, 1024);
    for (let index = 0; index < 120; index++)
      assert.equal(
        await claimLoginAttempt(db, `private-unknown-${index}`),
        null,
      );
    const anonymous = (
      await db.query<{ username: string; attempts: number }>(
        "SELECT username,attempts FROM poker_login_attempts",
      )
    ).rows;
    assert.ok(anonymous.length > 0 && anonymous.length <= 1024);
    assert.ok(
      anonymous.every(
        (row) =>
          /^!unknown:\d+$/.test(row.username) &&
          Number(row.username.split(":")[1]) < 1024,
      ),
    );
    assert.equal(JSON.stringify(anonymous).includes("private-unknown"), false);
    await assert.rejects(
      login(db, "known", "anything"),
      (error: unknown) =>
        error instanceof AuthAdmissionError &&
        error.status === 429 &&
        error.retryAfterSeconds >= 1 &&
        error.retryAfterSeconds <= 60,
    );
    await assert.rejects(claimLoginAttempt(db, "another"), AuthAdmissionError);
    assert.equal(
      (
        await db.query<{ attempts: number }>(
          "SELECT attempts FROM poker_login_budget",
        )
      ).rows[0].attempts,
      121,
    );
    await db.query(
      "UPDATE poker_login_budget SET window_start=now()-interval '61 seconds'",
    );
    const claim = await claimLoginAttempt(db, "  KNOWN ");
    assert.equal(claim?.username, "known");
    assert.equal(
      (
        await db.query<{ attempts: number }>(
          "SELECT attempts FROM poker_login_budget",
        )
      ).rows[0].attempts,
      1,
    );
  } finally {
    await engine.close();
  }
});

test("known and anonymous account quotas have matching responses, saturate, and reset without persisting unknown names", async () => {
  const { db, engine } = await fixture();
  try {
    for (const username of ["known", "private-unknown"]) {
      for (let count = 1; count <= 10; count++)
        await claimLoginAttempt(db, username);
      for (let repeat = 0; repeat < 3; repeat++)
        await assert.rejects(
          claimLoginAttempt(db, username),
          (error: unknown) =>
            error instanceof AuthAdmissionError &&
            error.status === 429 &&
            error.message.includes("15 minutes") &&
            error.retryAfterSeconds >= 1 &&
            error.retryAfterSeconds <= 900,
        );
    }
    const rows = (
      await db.query<{ username: string; attempts: number }>(
        "SELECT username,attempts FROM poker_login_attempts ORDER BY username",
      )
    ).rows;
    assert.equal(rows.length, 2);
    assert.ok(rows.every((row) => row.attempts === 11));
    assert.equal(
      rows.some((row) => row.username === "private-unknown"),
      false,
    );
    await db.query(
      "UPDATE poker_login_attempts SET window_start=now()-interval '16 minutes'",
    );
    assert.equal((await claimLoginAttempt(db, "known"))?.attempts, 1);
    assert.equal(await claimLoginAttempt(db, "private-unknown"), null);
    assert.ok(
      (
        await db.query<{ attempts: number }>(
          "SELECT attempts FROM poker_login_attempts",
        )
      ).rows.every((row) => row.attempts === 1),
    );
    await assert.rejects(
      db.query("UPDATE poker_login_attempts SET attempts=12"),
    );
    await assert.rejects(
      db.query(
        "INSERT INTO poker_users(id,username,password_hash) VALUES('reserved','!unknown:1','not-login')",
      ),
    );
  } finally {
    await engine.close();
  }
});

test("successful completion clears only its unchanged known-account claim and never resets global or anonymous budgets", async () => {
  const { db, engine } = await fixture();
  try {
    const first = await claimLoginAttempt(db, "known");
    const second = await claimLoginAttempt(db, "known");
    await clearSuccessfulLoginAttempt(db, first);
    assert.equal(
      (
        await db.query<{ attempts: number }>(
          "SELECT attempts FROM poker_login_attempts WHERE username='known'",
        )
      ).rows[0].attempts,
      2,
    );
    await clearSuccessfulLoginAttempt(db, second);
    assert.equal(
      (
        await db.query(
          "SELECT * FROM poker_login_attempts WHERE username='known'",
        )
      ).rows.length,
      0,
    );
    const anonymous = await claimLoginAttempt(db, "another-private-name");
    assert.equal(anonymous, null);
    await clearSuccessfulLoginAttempt(db, anonymous);
    assert.equal(
      (await db.query("SELECT * FROM poker_login_attempts")).rows.length,
      1,
    );
    assert.equal(
      (
        await db.query<{ attempts: number }>(
          "SELECT attempts FROM poker_login_budget",
        )
      ).rows[0].attempts,
      3,
    );
  } finally {
    await engine.close();
  }
});

test("expired throttle and session retention is indexed and limited to one hundred records per batch", async () => {
  const { db, engine } = await fixture();
  try {
    await db.query(
      "INSERT INTO poker_login_attempts(username,attempts,window_start) SELECT 'expired-'||value,1,now()-interval '1 hour' FROM generate_series(1,250) value",
    );
    await db.query(
      "INSERT INTO poker_login_attempts(username,attempts,window_start) VALUES('still-current',1,now())",
    );
    await db.query(
      "INSERT INTO poker_sessions(token_hash,user_id,branch_id,expires_at) SELECT 'expired-'||value,'known','local',now()-interval '1 hour' FROM generate_series(1,250) value",
    );
    await db.query(
      "INSERT INTO poker_sessions(token_hash,user_id,branch_id,expires_at) VALUES('still-current','known','local',now()+interval '1 hour')",
    );
    await claimLoginAttempt(db, "known");
    assert.equal(
      (
        await db.query(
          "SELECT * FROM poker_login_attempts WHERE username LIKE 'expired-%'",
        )
      ).rows.length,
      150,
    );
    assert.equal(
      (
        await db.query(
          "SELECT * FROM poker_sessions WHERE token_hash LIKE 'expired-%'",
        )
      ).rows.length,
      150,
    );
    assert.equal(
      (
        await db.query(
          "SELECT * FROM poker_login_attempts WHERE username='still-current'",
        )
      ).rows.length,
      1,
    );
    assert.equal(
      (
        await db.query(
          "SELECT * FROM poker_sessions WHERE token_hash='still-current'",
        )
      ).rows.length,
      1,
    );
    const indexes = (
      await db.query<{ indexname: string }>(
        "SELECT indexname FROM pg_indexes WHERE indexname IN ('poker_login_attempts_expiry','poker_sessions_expiry','poker_sessions_user')",
      )
    ).rows;
    assert.equal(indexes.length, 3);
  } finally {
    await engine.close();
  }
});
