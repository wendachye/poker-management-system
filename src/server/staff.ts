import "server-only";
import { createHmac, randomUUID } from "node:crypto";
import { staffMutationSchema, type StaffAccount } from "../domain/staff";
import type { Store } from "../domain/model";
import { DomainError } from "../domain/operations";
import { hashPassword, requireUser } from "./auth";
import type { Database, SqlConnection } from "./database";
import { readSnapshot } from "./repository";

async function admin(connection: SqlConnection, token: string | undefined) {
  const user = await requireUser(connection, token);
  if (user.role !== "ADMIN")
    throw new DomainError("Only an admin can manage staff.", 403);
  return user;
}

export async function listStaff(db: Database, token: string | undefined) {
  const user = await admin(db, token);
  const { rows } = await db.query<StaffAccount>(
    `SELECT u.id,u.username,u.active,m.role,
    (SELECT count(*) > 1 FROM poker_memberships WHERE user_id=u.id) AS "sharedAccount"
    FROM poker_users u JOIN poker_memberships m ON m.user_id=u.id
    WHERE m.branch_id=$1 ORDER BY u.active DESC,u.username`,
    [user.branchId],
  );
  return { branchId: user.branchId, accounts: rows };
}

export async function manageStaff(
  db: Database,
  token: string | undefined,
  input: unknown,
) {
  const parsed = staffMutationSchema.safeParse(input);
  if (!parsed.success)
    throw new DomainError("Check the username, password, role, and reason.");
  const { branchId, operationId, revision, command } = parsed.data;
  await admin(db, token);
  return db.transaction(async (connection) => {
    // Serialize account changes across venues before checking access and admin coverage.
    await connection.query(
      "LOCK TABLE poker_users, poker_memberships IN SHARE ROW EXCLUSIVE MODE",
    );
    const actor = await admin(connection, token);
    if (actor.branchId !== branchId)
      throw new DomainError(
        "Your active branch changed. Reload this page before continuing.",
        409,
      );
    const row = (
      await connection.query<{ data: Store; revision: number }>(
        "SELECT data,revision FROM poker_branch_state WHERE branch_id=$1 FOR UPDATE",
        [branchId],
      )
    ).rows[0];
    if (!row) throw new DomainError("Branch has not been initialized.", 503);
    // Key the retry fingerprint so it does not expose a plain password digest.
    const key = (
      await connection.query<{ password_hash: string }>(
        "SELECT password_hash FROM poker_users WHERE id=$1",
        [actor.id],
      )
    ).rows[0].password_hash;
    const fingerprint = createHmac("sha256", key)
      .update(JSON.stringify(command))
      .digest("hex");
    const previous = (
      await connection.query<{ actor_id: string; fingerprint: string }>(
        "SELECT actor_id,fingerprint FROM poker_operations WHERE branch_id=$1 AND operation_id=$2",
        [branchId, operationId],
      )
    ).rows[0];
    if (previous) {
      if (
        previous.actor_id !== actor.id ||
        previous.fingerprint !== fingerprint
      )
        throw new DomainError("Operation identifier was already used.", 409);
      return readSnapshot(connection, token);
    }
    if (revision !== row.revision)
      throw new DomainError(
        "Another staff member updated this branch. Records have been refreshed; review them and try again.",
        409,
      );
    let target: {
      id: string;
      username: string;
      active: boolean;
      role: StaffAccount["role"];
    };
    let before: string | undefined;
    let action: string;
    if (command.kind === "STAFF_CREATE") {
      if (
        (
          await connection.query(
            "SELECT id FROM poker_users WHERE username=$1",
            [command.username],
          )
        ).rows.length
      )
        throw new DomainError(
          "That username is unavailable. Choose another username.",
          409,
        );
      target = {
        id: randomUUID(),
        username: command.username,
        active: true,
        role: command.role,
      };
      await connection.query(
        "INSERT INTO poker_users(id,username,password_hash) VALUES($1,$2,$3)",
        [target.id, target.username, await hashPassword(command.password)],
      );
      await connection.query(
        "INSERT INTO poker_memberships(user_id,branch_id,role) VALUES($1,$2,$3)",
        [target.id, branchId, target.role],
      );
      action = "Created staff account";
    } else {
      const found = (
        await connection.query<typeof target>(
          `SELECT u.id,u.username,u.active,m.role FROM poker_users u
        JOIN poker_memberships m ON m.user_id=u.id WHERE u.id=$1 AND m.branch_id=$2`,
          [command.userId, branchId],
        )
      ).rows[0];
      if (!found)
        throw new DomainError(
          "Staff account was not found in this branch.",
          404,
        );
      target = found;
      if (target.id === actor.id)
        throw new DomainError(
          "Ask another admin to change your own account.",
          403,
        );
      before = JSON.stringify(target);
      if (command.kind !== "STAFF_ROLE") {
        const memberships = (
          await connection.query(
            "SELECT branch_id FROM poker_memberships WHERE user_id=$1",
            [target.id],
          )
        ).rows;
        if (memberships.length !== 1)
          throw new DomainError(
            "This account belongs to multiple locations. Use the operator account commands for password and access changes.",
            403,
          );
      }
      if (
        target.active &&
        target.role === "ADMIN" &&
        (command.kind === "STAFF_DISABLE" ||
          (command.kind === "STAFF_ROLE" && command.role !== "ADMIN"))
      ) {
        const others = (
          await connection.query(
            `SELECT u.id FROM poker_users u JOIN poker_memberships m ON m.user_id=u.id
          WHERE m.branch_id=$1 AND m.role='ADMIN' AND u.active=true AND u.id<>$2`,
            [branchId, target.id],
          )
        ).rows;
        if (!others.length)
          throw new DomainError(
            "Keep at least one active admin in this branch.",
            409,
          );
      }
      if (command.kind === "STAFF_ROLE") {
        await connection.query(
          "UPDATE poker_memberships SET role=$1 WHERE user_id=$2 AND branch_id=$3",
          [command.role, target.id, branchId],
        );
        target.role = command.role;
        action = "Changed staff role";
      } else if (command.kind === "STAFF_PASSWORD") {
        await connection.query(
          "UPDATE poker_users SET password_hash=$1,active=$2 WHERE id=$3",
          [
            await hashPassword(command.password),
            command.enable || target.active,
            target.id,
          ],
        );
        target.active = command.enable || target.active;
        action = command.enable
          ? "Enabled staff account"
          : "Reset staff password";
      } else {
        await connection.query(
          "UPDATE poker_users SET active=false WHERE id=$1",
          [target.id],
        );
        target.active = false;
        action = "Disabled staff account";
      }
      await connection.query("DELETE FROM poker_sessions WHERE user_id=$1", [
        target.id,
      ]);
      await connection.query(
        "DELETE FROM poker_login_attempts WHERE username=$1",
        [target.username],
      );
    }
    row.data.auditLogs.unshift({
      id: randomUUID(),
      time: new Date().toISOString(),
      actor: actor.username,
      actorId: actor.id,
      action,
      entity: target.id,
      reason: command.reason,
      before,
      after: JSON.stringify(target),
    });
    await connection.query(
      "UPDATE poker_branch_state SET data=$1,revision=revision+1 WHERE branch_id=$2",
      [JSON.stringify(row.data), branchId],
    );
    await connection.query(
      "INSERT INTO poker_operations(branch_id,operation_id,actor_id,fingerprint,revision) VALUES($1,$2,$3,$4,$5)",
      [branchId, operationId, actor.id, fingerprint, revision + 1],
    );
    return readSnapshot(connection, token);
  });
}
