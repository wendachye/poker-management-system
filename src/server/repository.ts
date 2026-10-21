import "server-only";
import { createHash } from "node:crypto";
import { mutationSchema } from "../domain/commands";
import { applyCommand, DomainError } from "../domain/operations";
import type { Branch, Snapshot, Staff, Store } from "../domain/model";
import { requireUser } from "./auth";
import type { Database, SqlConnection } from "./database";

async function snapshot(
  connection: SqlConnection,
  user: Staff,
): Promise<Snapshot> {
  const result = await connection.query<{
    revision: number;
    data: Store;
    name: string;
    timezone: string;
  }>(
    `SELECT s.revision, s.data, b.name, b.timezone
    FROM poker_branch_state s JOIN poker_branches b ON b.id = s.branch_id WHERE s.branch_id = $1`,
    [user.branchId],
  );
  const row = result.rows[0];
  if (!row) throw new DomainError("Branch has not been initialized.", 503);
  const branch: Branch = {
    id: user.branchId,
    name: row.name,
    timezone: row.timezone,
    role: user.role,
  };
  return { revision: row.revision, store: row.data, branch, user };
}
export async function readSnapshot(db: SqlConnection, token?: string) {
  return snapshot(db, await requireUser(db, token));
}
export async function mutate(
  db: Database,
  token: string | undefined,
  input: unknown,
) {
  const parsed = mutationSchema.safeParse(input);
  if (!parsed.success) throw new DomainError("Invalid operation payload.");
  const { branchId, operationId, revision, command } = parsed.data;
  return db.transaction(async (connection) => {
    const user = await requireUser(connection, token);
    if (branchId !== user.branchId)
      throw new DomainError(
        "Your active branch changed. Reload this page before continuing.",
        409,
      );
    const row = (
      await connection.query<{ revision: number; data: Store }>(
        "SELECT revision, data FROM poker_branch_state WHERE branch_id = $1 FOR UPDATE",
        [user.branchId],
      )
    ).rows[0];
    if (!row) throw new DomainError("Branch has not been initialized.", 503);
    // Account/role changes may have committed while this request waited for the branch lock.
    const authorized = await requireUser(connection, token);
    if (authorized.branchId !== user.branchId || authorized.role !== user.role)
      throw new DomainError(
        "Your access changed. Reload this page before continuing.",
        409,
      );
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(command))
      .digest("hex");
    const previous = (
      await connection.query<{ actor_id: string; fingerprint: string }>(
        "SELECT actor_id, fingerprint FROM poker_operations WHERE branch_id=$1 AND operation_id=$2",
        [user.branchId, operationId],
      )
    ).rows[0];
    if (previous) {
      if (previous.actor_id !== user.id || previous.fingerprint !== fingerprint)
        throw new DomainError("Operation identifier was already used.", 409);
      return snapshot(connection, user);
    }
    if (revision !== row.revision)
      throw new DomainError(
        "Another staff member updated this branch. Records have been refreshed; review them and try again.",
        409,
      );
    if (command.kind === "COMPLETE_SETUP") {
      if (user.role !== "ADMIN")
        throw new DomainError(
          "Only an administrator can complete venue setup.",
          403,
        );
      const staff = (
        await connection.query<{ user_id: string; role: Staff["role"] }>(
          `SELECT m.user_id, m.role FROM poker_memberships m
           JOIN poker_users u ON u.id = m.user_id
           WHERE m.branch_id = $1 AND u.active = true`,
          [user.branchId],
        )
      ).rows;
      if (
        !staff.some(
          (member) => member.role === "CASHIER" || member.role === "MANAGER",
        )
      )
        throw new DomainError(
          "Add an active cashier or manager before completing setup.",
        );
      const operators = staff.filter(
        (member) => member.role === "CASHIER" || member.role === "MANAGER",
      );
      if (
        !operators.some((operator) =>
          staff.some(
            (reviewer) =>
              reviewer.user_id !== operator.user_id &&
              (reviewer.role === "MANAGER" || reviewer.role === "ADMIN"),
          ),
        )
      )
        throw new DomainError(
          "Add an independent manager or administrator to review transactions before completing setup.",
        );
    }
    const next = applyCommand(row.data, command, user);
    if (command.kind === "UPDATE_SETTINGS")
      await connection.query(
        "UPDATE poker_branches SET name=$1, timezone=$2 WHERE id=$3",
        [command.settings.venueName, command.settings.timezone, user.branchId],
      );
    await connection.query(
      "UPDATE poker_branch_state SET data=$1, revision=revision+1 WHERE branch_id=$2",
      [JSON.stringify(next), user.branchId],
    );
    await connection.query(
      "INSERT INTO poker_operations(branch_id,operation_id,actor_id,fingerprint,revision) VALUES($1,$2,$3,$4,$5)",
      [user.branchId, operationId, user.id, fingerprint, row.revision + 1],
    );
    return snapshot(connection, user);
  });
}
