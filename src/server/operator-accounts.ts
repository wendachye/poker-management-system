import "server-only";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Role } from "../domain/model";
import { DomainError } from "../domain/operations";
import { emptyStore } from "../domain/selectors";
import { hashPassword } from "./auth";
import type { Database, SqlConnection } from "./database";
import { touchChangeVersions } from "./repository";
import { writeStoreDelta, type StorageMetadata } from "./storage";
import {
  assertStaffAccountMutable,
  keepActiveAdmins,
  lockStaffAccounts,
  revokeStaffSessions,
} from "./staff-safety";

const username = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[-a-z0-9_.@]{3,100}$/);
const branchId = z.string().min(1).max(100);
const role = z.enum(["ADMIN", "MANAGER", "CASHIER", "DEALER"]);
const password = z.string().min(12).max(128);
const inputSchema = z
  .object({
    operationId: z.uuid(),
    operator: z
      .string()
      .trim()
      .min(3)
      .max(100)
      .regex(/^[^\p{Cc}\p{Cf}]+$/u),
    reason: z.string().trim().min(3).max(500),
    command: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("CREATE"),
          username,
          password,
          branchId,
          role,
        })
        .strict(),
      z.object({ kind: z.literal("GRANT"), username, branchId, role }).strict(),
      z
        .object({
          kind: z.literal("PASSWORD"),
          username,
          password,
          enable: z.boolean(),
        })
        .strict(),
      z.object({ kind: z.literal("DISABLE"), username }).strict(),
    ]),
  })
  .strict();

export type OperatorAccountInput = z.infer<typeof inputSchema>;
export type OperatorAccountCommand = OperatorAccountInput["command"];
export type OperatorAccountResult = {
  operationId: string;
  userId: string;
  username: string;
  branchIds: string[];
  replayed: boolean;
};
type Account = { id: string; username: string; active: boolean };
type Membership = { branch_id: string; role: Role };

async function operatorActor(connection: SqlConnection) {
  const principal = (
    await connection.query<{ principal: string }>(
      "SELECT session_user::text AS principal",
    )
  ).rows[0]?.principal;
  if (!principal)
    throw new Error("The database operator identity could not be read.");
  const digest = createHash("sha256").update(principal).digest("hex");
  const id = "operator:" + digest;
  const username = "!operator:" + digest;
  // A random, non-password key supports secret-safe retry fingerprints. This
  // identity is disabled and has no venue membership, so it cannot sign in.
  await connection.query(
    `INSERT INTO poker_users(id,username,password_hash,active) VALUES($1,$2,$3,false)
    ON CONFLICT(id) DO NOTHING`,
    [id, username, "operator-key:" + randomBytes(32).toString("hex")],
  );
  const actor = (
    await connection.query<{
      id: string;
      username: string;
      active: boolean;
      password_hash: string;
      memberships: string;
    }>(
      `SELECT u.id,u.username,u.active,u.password_hash,
      (SELECT count(*)::text FROM poker_memberships WHERE user_id=u.id) AS memberships
      FROM poker_users u WHERE u.id=$1`,
      [id],
    )
  ).rows[0];
  if (
    !actor ||
    actor.username !== username ||
    actor.active ||
    actor.memberships !== "0" ||
    !/^operator-key:[a-f0-9]{64}$/.test(actor.password_hash)
  )
    throw new DomainError(
      "The reserved operator audit identity is invalid. Stop and investigate.",
      503,
    );
  return { id, key: actor.password_hash, principal };
}

function safeAccount(
  account: Account | undefined,
  memberships: Membership[],
  venue: string,
) {
  if (!account) return undefined;
  return JSON.stringify({
    id: account.id,
    username: account.username,
    active: account.active,
    role: memberships.find((entry) => entry.branch_id === venue)?.role ?? null,
  });
}

/** Privileged database-operator changes; never exposed through a staff HTTP route.
 * The database principal is authoritative; operator is an explicit human label.
 * A retry uses its original operationId, label, reason and complete command.
 */
export async function manageOperatorAccount(
  db: Database,
  input: unknown,
): Promise<OperatorAccountResult> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success)
    throw new DomainError(
      "Provide a valid operator label, reason, operation ID and staff account command.",
    );
  const { operationId, operator, reason, command } = parsed.data;
  return db.transaction(async (connection) => {
    await lockStaffAccounts(connection);
    let target = (
      await connection.query<Account>(
        "SELECT id,username,active FROM poker_users WHERE username=$1",
        [command.username],
      )
    ).rows[0];
    if (target) assertStaffAccountMutable(target);
    const beforeAccount = target ? { ...target } : undefined;
    const beforeMemberships = target
      ? (
          await connection.query<Membership>(
            "SELECT branch_id,role FROM poker_memberships WHERE user_id=$1 ORDER BY branch_id",
            [target.id],
          )
        ).rows
      : [];
    const venues = [
      ...new Set([
        ...beforeMemberships.map((entry) => entry.branch_id),
        ...("branchId" in command ? [command.branchId] : []),
      ]),
    ].sort();
    if (!target && command.kind !== "CREATE")
      throw new DomainError("Staff account was not found.", 404);
    if (!venues.length)
      throw new DomainError(
        "Grant this account venue access before changing its credentials or status.",
        409,
      );
    const actor = await operatorActor(connection);
    const fingerprint = createHmac("sha256", actor.key)
      .update(JSON.stringify(parsed.data))
      .digest("hex");
    const previous = (
      await connection.query<{
        branch_id: string;
        actor_id: string;
        fingerprint: string;
      }>(
        `SELECT branch_id,actor_id,fingerprint FROM poker_operations
        WHERE branch_id=ANY($1::text[]) AND operation_id=$2 ORDER BY branch_id`,
        [venues, operationId],
      )
    ).rows;
    if (previous.length) {
      if (
        !target ||
        previous.some(
          (saved) =>
            saved.actor_id !== actor.id || saved.fingerprint !== fingerprint,
        )
      )
        throw new DomainError("Operation identifier was already used.", 409);
      return {
        operationId,
        userId: target.id,
        username: target.username,
        branchIds: previous.map((saved) => saved.branch_id),
        replayed: true,
      };
    }
    const states = (
      await connection.query<{
        branch_id: string;
        revision: number;
        data: StorageMetadata;
      }>(
        "SELECT branch_id,revision,data FROM poker_branch_state WHERE branch_id=ANY($1::text[]) ORDER BY branch_id FOR UPDATE",
        [venues],
      )
    ).rows;
    if (states.length !== venues.length)
      throw new DomainError(
        "Every affected branch must exist and have initialized storage.",
        404,
      );
    let action: string;
    if (command.kind === "CREATE") {
      if (target)
        throw new DomainError(
          "Account exists. Use the explicit grant-existing command to change venue access.",
          409,
        );
      target = { id: randomUUID(), username: command.username, active: true };
      await connection.query(
        "INSERT INTO poker_users(id,username,password_hash,active) VALUES($1,$2,$3,true)",
        [target.id, target.username, await hashPassword(command.password)],
      );
      await connection.query(
        "INSERT INTO poker_memberships(user_id,branch_id,role) VALUES($1,$2,$3)",
        [target.id, command.branchId, command.role],
      );
      action = "Created staff account by operator";
    } else if (command.kind === "GRANT") {
      const current = beforeMemberships.find(
        (entry) => entry.branch_id === command.branchId,
      );
      if (
        target!.active &&
        current?.role === "ADMIN" &&
        command.role !== "ADMIN"
      )
        await keepActiveAdmins(connection, target!.id, [command.branchId]);
      await connection.query(
        `INSERT INTO poker_memberships(user_id,branch_id,role) VALUES($1,$2,$3)
        ON CONFLICT(user_id,branch_id) DO UPDATE SET role=EXCLUDED.role`,
        [target!.id, command.branchId, command.role],
      );
      action = "Changed staff access by operator";
    } else if (command.kind === "PASSWORD") {
      await connection.query(
        "UPDATE poker_users SET password_hash=$1,active=$2 WHERE id=$3",
        [
          await hashPassword(command.password),
          command.enable || target!.active,
          target!.id,
        ],
      );
      action =
        command.enable && !target!.active
          ? "Enabled staff account by operator"
          : "Reset staff password by operator";
      target!.active = command.enable || target!.active;
    } else {
      if (target!.active)
        await keepActiveAdmins(
          connection,
          target!.id,
          beforeMemberships
            .filter((entry) => entry.role === "ADMIN")
            .map((entry) => entry.branch_id),
        );
      await connection.query(
        "UPDATE poker_users SET active=false WHERE id=$1",
        [target!.id],
      );
      target!.active = false;
      action = "Disabled staff account by operator";
    }
    // Target exists after every successful branch above. Credentials and role
    // changes invalidate sessions in all venues, including shared accounts.
    const changed = target!;
    await revokeStaffSessions(connection, changed.id, changed.username);
    const afterMemberships = (
      await connection.query<Membership>(
        "SELECT branch_id,role FROM poker_memberships WHERE user_id=$1 ORDER BY branch_id",
        [changed.id],
      )
    ).rows;
    for (const state of states) {
      const original = {
        ...emptyStore(),
        settings: state.data.settings,
        currentDayId: state.data.currentDayId,
      };
      const next = structuredClone(original);
      next.auditLogs.push({
        id: randomUUID(),
        time: new Date().toISOString(),
        actor: `Operator: ${operator} (${actor.principal})`,
        actorId: actor.id,
        action,
        entity: changed.id,
        reason,
        before: safeAccount(beforeAccount, beforeMemberships, state.branch_id),
        after: safeAccount(changed, afterMemberships, state.branch_id),
      });
      await writeStoreDelta(
        connection,
        state.branch_id,
        original,
        next,
        state.revision + 1,
      );
      await touchChangeVersions(
        connection,
        state.branch_id,
        ["venue:all"],
        state.revision + 1,
      );
      await connection.query(
        "INSERT INTO poker_operations(branch_id,operation_id,actor_id,fingerprint,revision) VALUES($1,$2,$3,$4,$5)",
        [
          state.branch_id,
          operationId,
          actor.id,
          fingerprint,
          state.revision + 1,
        ],
      );
    }
    return {
      operationId,
      userId: changed.id,
      username: changed.username,
      branchIds: venues,
      replayed: false,
    };
  });
}
