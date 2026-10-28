import "server-only";
import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { DomainError } from "../domain/operations";
import type { Branch, Staff } from "../domain/model";
import type { Database, SqlConnection } from "./database";
import {
  claimLoginAttempt,
  clearSuccessfulLoginAttempt,
  withLoginAdmission,
} from "./login-admission";
import { withPasswordWork } from "./password-work";

export const SESSION_COOKIE = "poker_session";
export const SESSION_SECONDS = 8 * 60 * 60;
const hashToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");
function derive(password: string, salt: string): Promise<Buffer> {
  return withPasswordWork(
    () =>
      new Promise((resolve, reject) =>
        scrypt(
          password,
          salt,
          64,
          { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
          (error, key) => (error ? reject(error) : resolve(key)),
        ),
      ),
  );
}
export async function hashPassword(password: string) {
  if (password.length < 12 || password.length > 128)
    throw new DomainError("Use a password between 12 and 128 characters.");
  const salt = randomBytes(16).toString("hex");
  return `scrypt:${salt}:${(await derive(password, salt)).toString("hex")}`;
}
export async function verifyPassword(password: string, encoded?: string) {
  // Existing short local passwords still verify; new passwords retain the
  // stricter creation policy. Invalid inputs never submit oversized KDF work.
  if (password.length < 1 || password.length > 128) return false;
  const match =
    encoded?.length === 168
      ? /^scrypt:([a-f0-9]{32}):([a-f0-9]{128})$/.exec(encoded)
      : null;
  const salt = match?.[1] ?? "00000000000000000000000000000000";
  const hash = match?.[2] ?? "00".repeat(64);
  const actual = await derive(password, salt);
  const expected = Buffer.from(hash, "hex");
  const equal = timingSafeEqual(actual, expected);
  return !!match && equal;
}
export async function sessionUser(
  connection: SqlConnection,
  token?: string,
): Promise<Staff | null> {
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const result = await connection.query<Staff>(
    `SELECT u.id, u.username, m.role, s.branch_id AS "branchId"
    FROM poker_sessions s JOIN poker_users u ON u.id = s.user_id
    JOIN poker_memberships m ON m.user_id = u.id AND m.branch_id = s.branch_id
    WHERE s.token_hash = $1 AND s.expires_at > now() AND u.active = true`,
    [hashToken(token)],
  );
  return result.rows[0] ?? null;
}
export async function requireUser(connection: SqlConnection, token?: string) {
  const user = await sessionUser(connection, token);
  if (!user)
    throw new DomainError("Your session has expired. Sign in again.", 401);
  return user;
}
export async function branchesForUser(
  connection: SqlConnection,
  userId: string,
) {
  return (
    await connection.query<Branch>(
      `SELECT b.id, b.name, b.timezone, m.role FROM poker_branches b
    JOIN poker_memberships m ON m.branch_id = b.id WHERE m.user_id = $1 ORDER BY b.name`,
      [userId],
    )
  ).rows;
}
export async function login(db: Database, username: string, password: string) {
  return withLoginAdmission(async () => {
    const key = username.trim().toLowerCase();
    const claim = await claimLoginAttempt(
      db,
      key.length <= 100 ? key : undefined,
    );
    if (
      !key ||
      key.length > 100 ||
      password.length < 1 ||
      password.length > 128
    )
      throw new DomainError("Invalid username or password.", 401);
    const found = (
      await db.query<{ id: string; password_hash: string }>(
        "SELECT id, password_hash FROM poker_users WHERE username = $1 AND active = true",
        [key],
      )
    ).rows[0];
    if (!(await verifyPassword(password, found?.password_hash)) || !found)
      throw new DomainError("Invalid username or password.", 401);
    const branches = await branchesForUser(db, found.id);
    if (!branches.length)
      throw new DomainError("This account has no branch access.", 403);
    const token = randomBytes(32).toString("hex");
    await db.transaction(async (connection) => {
      const current = (
        await connection.query<{ password_hash: string; active: boolean }>(
          "SELECT password_hash,active FROM poker_users WHERE id=$1 FOR SHARE",
          [found.id],
        )
      ).rows[0];
      if (!current?.active || current.password_hash !== found.password_hash)
        throw new DomainError("Invalid username or password.", 401);
      await connection.query(
        "INSERT INTO poker_sessions(token_hash,user_id,branch_id,expires_at) VALUES($1,$2,$3,$4)",
        [
          hashToken(token),
          found.id,
          branches[0].id,
          new Date(Date.now() + SESSION_SECONDS * 1000),
        ],
      );
      await clearSuccessfulLoginAttempt(connection, claim);
    });
    return token;
  });
}
export async function logout(connection: SqlConnection, token?: string) {
  if (token)
    await connection.query("DELETE FROM poker_sessions WHERE token_hash = $1", [
      hashToken(token),
    ]);
}
export async function changeBranch(
  db: Database,
  token: string,
  branchId: string,
) {
  await db.transaction(async (connection) => {
    const user = await requireUser(connection, token);
    if (
      !(await branchesForUser(connection, user.id)).some(
        (branch) => branch.id === branchId,
      )
    )
      throw new DomainError("You do not have access to that branch.", 403);
    await connection.query(
      "UPDATE poker_sessions SET branch_id = $1 WHERE token_hash = $2",
      [branchId, hashToken(token)],
    );
  });
}
