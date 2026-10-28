import "server-only";
import { createHash } from "node:crypto";
import type { SqlConnection } from "./database";
import { AuthAdmissionError, createWorkGate } from "./password-work";

export const LOGIN_LIMITS = {
  globalAttempts: 120,
  globalWindowSeconds: 60,
  accountAttempts: 10,
  accountWindowSeconds: 900,
  cleanupBatch: 100,
  anonymousBuckets: 1024,
} as const;

export const LOGIN_WORK_LIMITS = {
  active: 8,
  queued: 64,
  waitMs: 5000,
} as const;
const runtime = globalThis as typeof globalThis & {
  pokerLoginWork?: ReturnType<typeof createWorkGate>;
};
export const withLoginAdmission = (runtime.pokerLoginWork ??=
  createWorkGate(LOGIN_WORK_LIMITS));

export type LoginAttemptClaim = {
  username: string;
  attempts: number;
  windowStart: string;
};
type Attempt = {
  attempts: number;
  retry_after: number;
  window_start: string;
};

function retrySeconds(value: number, maximum: number) {
  return Math.max(1, Math.min(maximum, Math.ceil(value)));
}

/** Persistent quotas are claimed before hashing; successful login never clears global use. */
export async function claimLoginAttempt(
  db: SqlConnection,
  username?: string,
): Promise<LoginAttemptClaim | null> {
  const global = (
    await db.query<Attempt>(
      `INSERT INTO poker_login_budget(id,attempts,window_start) VALUES(1,1,now())
      ON CONFLICT(id) DO UPDATE SET
        attempts=CASE WHEN poker_login_budget.window_start <= now()-interval '60 seconds' THEN 1
          WHEN poker_login_budget.attempts >= 121 THEN 121 ELSE poker_login_budget.attempts+1 END,
        window_start=CASE WHEN poker_login_budget.window_start <= now()-interval '60 seconds' THEN now() ELSE poker_login_budget.window_start END
      RETURNING attempts,window_start::text, GREATEST(1,ceil(extract(epoch FROM window_start+interval '60 seconds'-now())))::integer AS retry_after`,
    )
  ).rows[0];
  if (global.attempts > LOGIN_LIMITS.globalAttempts)
    throw new AuthAdmissionError(
      "Too many sign-in attempts. Try again shortly.",
      429,
      retrySeconds(global.retry_after, LOGIN_LIMITS.globalWindowSeconds),
    );
  const normalized = (username ?? "").trim().toLowerCase();
  const known = (
    await db.query<{ username: string }>(
      "SELECT username FROM poker_users WHERE username=$1 AND active=true",
      [normalized],
    )
  ).rows[0];
  // Unknown identities get the same account-style response without persisting
  // submitted names or allowing arbitrary new rows. App usernames cannot use '!'.
  const bucket =
    createHash("sha256").update(normalized).digest().readUInt32BE(0) %
    LOGIN_LIMITS.anonymousBuckets;
  const key = known?.username ?? `!unknown:${bucket}`;
  const account = (
    await db.query<Attempt>(
      `INSERT INTO poker_login_attempts(username,attempts,window_start)
          VALUES($1,1,now())
          ON CONFLICT(username) DO UPDATE SET
            attempts=CASE WHEN poker_login_attempts.window_start <= now()-interval '15 minutes' THEN 1
              WHEN poker_login_attempts.attempts >= 11 THEN 11 ELSE poker_login_attempts.attempts+1 END,
            window_start=CASE WHEN poker_login_attempts.window_start <= now()-interval '15 minutes' THEN now() ELSE poker_login_attempts.window_start END
          RETURNING attempts,window_start::text, GREATEST(1,ceil(extract(epoch FROM window_start+interval '15 minutes'-now())))::integer AS retry_after`,
      [key],
    )
  ).rows[0];
  if (account && account.attempts > LOGIN_LIMITS.accountAttempts)
    throw new AuthAdmissionError(
      "Too many sign-in attempts. Try again in 15 minutes.",
      429,
      retrySeconds(account.retry_after, LOGIN_LIMITS.accountWindowSeconds),
    );

  // Retention is indexed and bounded. Failed and unknown-account attempts also
  // make progress; an old history cannot force one login to delete every row.
  await db.query(
    `WITH expired AS (
      SELECT username FROM poker_login_attempts WHERE window_start <= now()-interval '15 minutes'
      ORDER BY window_start,username LIMIT 100 FOR UPDATE SKIP LOCKED
    ) DELETE FROM poker_login_attempts WHERE username IN (SELECT username FROM expired)`,
  );
  await db.query(
    `WITH expired AS (
      SELECT token_hash FROM poker_sessions WHERE expires_at <= now()
      ORDER BY expires_at,token_hash LIMIT 100 FOR UPDATE SKIP LOCKED
    ) DELETE FROM poker_sessions WHERE token_hash IN (SELECT token_hash FROM expired)`,
  );
  return known
    ? {
        username: known.username,
        attempts: account.attempts,
        windowStart: account.window_start,
      }
    : null;
}

/** Do not erase a newer concurrent failure when an earlier successful attempt finishes. */
export async function clearSuccessfulLoginAttempt(
  db: SqlConnection,
  claim: LoginAttemptClaim | null,
) {
  if (claim)
    await db.query(
      "DELETE FROM poker_login_attempts WHERE username=$1 AND attempts=$2 AND window_start=$3::timestamptz",
      [claim.username, claim.attempts, claim.windowStart],
    );
}
