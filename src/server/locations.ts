import "server-only";
import { z } from "zod";
import { createHash, randomUUID } from "node:crypto";
import { locationCommandSchema } from "../domain/locations";
import { emptyStore } from "../domain/selectors";
import type { Snapshot } from "../domain/model";
import { DomainError } from "../domain/operations";
import { branchesForUser, requireUser } from "./auth";
import { readSnapshot, touchChangeVersions } from "./repository";
import {
  storageMetadata,
  writeStoreDelta,
  type StorageMetadata,
} from "./storage";
import { readOperationalSnapshot } from "./queries";
import { assertOperationNotCancelled } from "./operation-recovery";
import type { Database } from "./database";
const schema = z
  .object({
    branchId: z.string().min(1),
    actorId: z.string().min(1).max(100).optional(),
    operationId: z.uuid(),
    revision: z.number().int().nonnegative(),
    command: locationCommandSchema,
  })
  .strict();

export async function listLocations(db: Database, token?: string) {
  const user = await requireUser(db, token);
  return { branches: await branchesForUser(db, user.id) };
}
export async function createLocation(
  db: Database,
  token: string | undefined,
  input: unknown,
  options: { compact?: boolean } = {},
): Promise<Snapshot> {
  const parsed = schema.safeParse(input);
  if (!parsed.success)
    throw new DomainError("Check the location code, name, and time zone.");
  const { branchId, actorId, operationId, revision, command } = parsed.data;
  return db.transaction(async (connection) => {
    await connection.query(
      "LOCK TABLE poker_users,poker_memberships IN SHARE ROW EXCLUSIVE MODE",
    );
    const user = await requireUser(connection, token);
    if (user.role !== "ADMIN")
      throw new DomainError("Only an admin can create locations.", 403);
    if (actorId !== undefined && actorId !== user.id)
      throw new DomainError(
        "Your signed-in account changed. Reload this page before continuing.",
        409,
      );
    if (user.branchId !== branchId)
      throw new DomainError(
        "Your active branch changed. Reload this page before continuing.",
        409,
      );
    const row = (
      await connection.query<{ data: StorageMetadata; revision: number }>(
        "SELECT data,revision FROM poker_branch_state WHERE branch_id=$1 FOR UPDATE",
        [branchId],
      )
    ).rows[0];
    if (!row) throw new DomainError("Branch has not been initialized.", 503);
    // Session changes do not take the account-management table locks above.
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
      await connection.query<{ actor_id: string; fingerprint: string }>(
        "SELECT actor_id,fingerprint FROM poker_operations WHERE branch_id=$1 AND operation_id=$2",
        [branchId, operationId],
      )
    ).rows[0];
    if (previous) {
      assertOperationNotCancelled(previous.fingerprint);
      if (previous.actor_id !== user.id || previous.fingerprint !== fingerprint)
        throw new DomainError("Operation identifier was already used.", 409);
      return options.compact
        ? readOperationalSnapshot(connection, token)
        : readSnapshot(connection, token);
    }
    if (revision !== row.revision)
      throw new DomainError(
        "Another staff member updated this branch. Records have been refreshed; review them and try again.",
        409,
      );
    if (
      (
        await connection.query("SELECT id FROM poker_branches WHERE id=$1", [
          command.id,
        ])
      ).rows.length
    )
      throw new DomainError("That location code is already in use.", 409);
    await connection.query(
      "INSERT INTO poker_branches(id,name,timezone) VALUES($1,$2,$3)",
      [command.id, command.name, command.timezone],
    );
    await connection.query(
      "INSERT INTO poker_branch_state(branch_id,data) VALUES($1,$2)",
      [command.id, JSON.stringify(storageMetadata(emptyStore()))],
    );
    await connection.query(
      "INSERT INTO poker_memberships(user_id,branch_id,role) VALUES($1,$2,'ADMIN')",
      [user.id, command.id],
    );
    const original = {
      ...emptyStore(),
      settings: row.data.settings,
      currentDayId: row.data.currentDayId,
    };
    const next = structuredClone(original);
    next.auditLogs.unshift({
      id: randomUUID(),
      time: new Date().toISOString(),
      actor: user.username,
      actorId: user.id,
      action: "Created location",
      entity: command.id,
      reason: command.name,
      after: JSON.stringify({ name: command.name, timezone: command.timezone }),
    });
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
      ["venue:all"],
      row.revision + 1,
    );
    await connection.query(
      "INSERT INTO poker_operations(branch_id,operation_id,actor_id,fingerprint,revision) VALUES($1,$2,$3,$4,$5)",
      [branchId, operationId, user.id, fingerprint, row.revision + 1],
    );
    return options.compact
      ? readOperationalSnapshot(connection, token)
      : readSnapshot(connection, token);
  });
}
