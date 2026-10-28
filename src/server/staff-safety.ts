import "server-only";
import { DomainError } from "../domain/operations";
import type { SqlConnection } from "./database";

/** UI and operator changes must acquire this before reading account coverage. */
export async function lockStaffAccounts(connection: SqlConnection) {
  await connection.query(
    "LOCK TABLE poker_users,poker_memberships IN SHARE ROW EXCLUSIVE MODE",
  );
}

/** Technical audit actors are never staff accounts, even if bad data adds access. */
export function assertStaffAccountMutable(account: {
  id: string;
  username: string;
}) {
  if (
    account.username.startsWith("!operator:") ||
    account.id.startsWith("operator:")
  )
    throw new DomainError(
      "Operator audit identities cannot be changed as staff.",
      403,
    );
}

/** The caller holds lockStaffAccounts; branchIds are the active admin roles removed. */
export async function keepActiveAdmins(
  connection: SqlConnection,
  userId: string,
  branchIds: string[],
) {
  if (!branchIds.length) return;
  const { rows } = await connection.query<{ branch_id: string }>(
    `SELECT removed.branch_id FROM unnest($2::text[]) AS removed(branch_id)
    WHERE NOT EXISTS (
      SELECT 1 FROM poker_memberships m JOIN poker_users u ON u.id=m.user_id
      WHERE m.branch_id=removed.branch_id AND m.role='ADMIN' AND u.active=true AND u.id<>$1
    ) ORDER BY removed.branch_id`,
    [userId, [...new Set(branchIds)]],
  );
  if (rows.length)
    throw new DomainError(
      branchIds.length === 1
        ? "Keep at least one active admin in this branch."
        : "Keep at least one active admin in every affected branch.",
      409,
    );
}

export async function revokeStaffSessions(
  connection: SqlConnection,
  userId: string,
  username: string,
) {
  await connection.query("DELETE FROM poker_sessions WHERE user_id=$1", [
    userId,
  ]);
  await connection.query("DELETE FROM poker_login_attempts WHERE username=$1", [
    username,
  ]);
}
