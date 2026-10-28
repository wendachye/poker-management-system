import "server-only";
import { createHash } from "node:crypto";
import { mutationSchema } from "../domain/commands";
import { applyCommand, DomainError } from "../domain/operations";
import type { Branch, Snapshot, Staff } from "../domain/model";
import {
  changedDependencyKeys,
  commandDependencies,
} from "../domain/command-concurrency";
import { requireUser } from "./auth";
import type { Database, SqlConnection } from "./database";
import { readStore, writeStoreDelta, type StorageMetadata } from "./storage";
import { loadCommandStore } from "./command-store";
import { readOperationalSnapshot } from "./queries";

type ResultContext = {
  playerIds?: string[];
  approvalIds?: string[];
  transactionIds?: string[];
};

async function snapshot(
  connection: SqlConnection,
  user: Staff,
): Promise<Snapshot> {
  const result = await connection.query<{
    revision: number;
    name: string;
    timezone: string;
  }>(
    `SELECT s.revision, b.name, b.timezone
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
  return {
    revision: row.revision,
    store: await readStore(connection, user.branchId),
    branch,
    user,
  };
}
export async function readSnapshot(db: SqlConnection, token?: string) {
  if ("transaction" in db && typeof db.transaction === "function")
    return (db as Database).transaction(async (connection) => {
      await connection.query(
        "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      return snapshot(connection, await requireUser(connection, token));
    });
  return snapshot(db, await requireUser(db, token));
}
export async function mutate(
  db: Database,
  token: string | undefined,
  input: unknown,
  options: { compact?: boolean } = {},
): Promise<Snapshot> {
  const parsed = mutationSchema.safeParse(input);
  if (!parsed.success) throw new DomainError("Invalid operation payload.");
  const { branchId, actorId, operationId, revision, command } = parsed.data;
  return db.transaction(async (connection) => {
    const user = await requireUser(connection, token);
    if (actorId !== undefined && actorId !== user.id)
      throw new DomainError(
        "Your signed-in account changed. Reload this page before continuing.",
        409,
      );
    if (branchId !== user.branchId)
      throw new DomainError(
        "Your active branch changed. Reload this page before continuing.",
        409,
      );
    const row = (
      await connection.query<{ revision: number; data: StorageMetadata }>(
        "SELECT revision, data FROM poker_branch_state WHERE branch_id = $1 FOR UPDATE",
        [user.branchId],
      )
    ).rows[0];
    if (!row) throw new DomainError("Branch has not been initialized.", 503);
    // Account/role changes may have committed while this request waited for the branch lock.
    const authorized = await requireUser(connection, token);
    if (
      authorized.id !== user.id ||
      authorized.branchId !== user.branchId ||
      authorized.role !== user.role
    )
      throw new DomainError(
        "Your access changed. Reload this page before continuing.",
        409,
      );
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(command))
      .digest("hex");
    const previous = (
      await connection.query<{
        actor_id: string;
        fingerprint: string;
        result_context: ResultContext;
      }>(
        "SELECT actor_id, fingerprint, result_context FROM poker_operations WHERE branch_id=$1 AND operation_id=$2",
        [user.branchId, operationId],
      )
    ).rows[0];
    if (previous) {
      if (previous.actor_id !== user.id || previous.fingerprint !== fingerprint)
        throw new DomainError("Operation identifier was already used.", 409);
      return options.compact
        ? readOperationalSnapshot(connection, token, previous.result_context)
        : snapshot(connection, user);
    }
    if (revision > row.revision || revision < row.data.concurrencyFloor)
      throw new DomainError(
        "Another staff member updated this branch. Records have been refreshed; review them and try again.",
        409,
      );
    const original = await loadCommandStore(
      connection,
      branchId,
      row.data,
      command,
    );
    const conflicts = await connection.query(
      "SELECT key FROM poker_change_versions WHERE branch_id=$1 AND key=ANY($2::text[]) AND revision>$3 LIMIT 1",
      [branchId, commandDependencies(original, command), revision],
    );
    if (conflicts.rows.length)
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
    const next = applyCommand(original, command, user);
    const resultContext: ResultContext = {
      playerIds: next.profiles.map((value) => value.id),
      approvalIds: next.approvals.map((value) => value.id),
      transactionIds: next.transactions.map((value) => value.id),
    };
    if (command.kind === "UPDATE_SETTINGS")
      await connection.query(
        "UPDATE poker_branches SET name=$1, timezone=$2 WHERE id=$3",
        [command.settings.venueName, command.settings.timezone, user.branchId],
      );
    await writeStoreDelta(
      connection,
      branchId,
      original,
      next,
      row.revision + 1,
    );
    await touchChangeVersions(
      connection,
      branchId,
      changedDependencyKeys(original, next),
      row.revision + 1,
    );
    await connection.query(
      "INSERT INTO poker_operations(branch_id,operation_id,actor_id,fingerprint,revision,result_context) VALUES($1,$2,$3,$4,$5,$6)",
      [
        user.branchId,
        operationId,
        user.id,
        fingerprint,
        row.revision + 1,
        JSON.stringify(resultContext),
      ],
    );
    return options.compact
      ? readOperationalSnapshot(connection, token, resultContext)
      : snapshot(connection, user);
  });
}

export async function touchChangeVersions(
  connection: SqlConnection,
  branchId: string,
  keys: string[],
  revision: number,
) {
  if (!keys.length) return;
  await connection.query(
    "INSERT INTO poker_change_versions(branch_id,key,revision) SELECT $1,unnest($2::text[]),$3 ON CONFLICT(branch_id,key) DO UPDATE SET revision=EXCLUDED.revision",
    [branchId, [...new Set(keys)], revision],
  );
}
