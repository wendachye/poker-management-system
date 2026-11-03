import "server-only";
import { createHmac, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  staffMutationSchema,
  type StaffAccount,
  type StaffListResult,
} from "../domain/staff";
import { validListSort } from "../domain/list-sort";
import { emptyStore } from "../domain/selectors";
import type { Role, Snapshot } from "../domain/model";
import english from "../../messages/en.json";
import chinese from "../../messages/zh.json";
import { DomainError } from "../domain/operations";
import { hashPassword, requireUser } from "./auth";
import type { Database, SqlConnection } from "./database";
import { readSnapshot, touchChangeVersions } from "./repository";
import { writeStoreDelta, type StorageMetadata } from "./storage";
import { readOperationalSnapshot } from "./queries";
import { assertOperationNotCancelled } from "./operation-recovery";
import {
  assertStaffAccountMutable,
  keepActiveAdmins,
  lockStaffAccounts,
  revokeStaffSessions,
} from "./staff-safety";

async function admin(connection: SqlConnection, token: string | undefined) {
  const user = await requireUser(connection, token);
  if (user.role !== "ADMIN")
    throw new DomainError("Only an admin can manage staff.", 403);
  return user;
}

const staffListSchema = z
  .object({
    query: z.string().trim().max(200).optional(),
    status: z.enum(["all", "active", "disabled"]).default("all"),
    role: z.enum(["DEALER", "CASHIER", "MANAGER", "ADMIN"]).optional(),
    page: z.coerce.number().int().min(0).max(1_000_000).default(0),
    pageSize: z.coerce.number().int().min(1).max(50).default(20),
    sort: z.string().min(1).max(40).optional(),
    direction: z.enum(["asc", "desc"]).optional(),
  })
  .strict();

// Use the displayed labels as aliases without storing translated role values.
const staffRoleLabels: Record<Role, readonly string[]> = {
  ADMIN: [english.ui.admin, chinese.ui.admin],
  MANAGER: [english.ui.manager, chinese.ui.manager],
  CASHIER: [english.ui.cashier, chinese.ui.cashier],
  DEALER: [english.ui.dealer, chinese.ui.dealer],
};

export async function listStaff(
  db: Database,
  token: string | undefined,
  input?: unknown,
): Promise<StaffListResult> {
  if (input !== undefined) {
    const parsed = staffListSchema.safeParse(input);
    if (
      !parsed.success ||
      (parsed.data.sort && !validListSort("staff", parsed.data.sort)) ||
      (parsed.data.direction && !parsed.data.sort)
    )
      throw new DomainError(
        "Choose valid staff filters, sort fields and a page size from 1 to 50.",
      );
    const query = parsed.data;
    return db.transaction(async (connection) => {
      await connection.query(
        "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      const user = await admin(connection, token);
      const values: unknown[] = [user.branchId];
      const clauses = ["m.branch_id=$1"];
      if (query.role) {
        values.push(query.role);
        clauses.push(`m.role=$${values.length}`);
      }
      for (const term of (query.query ?? "")
        .normalize("NFD")
        .replace(/\p{M}/gu, "")
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 12)) {
        values.push(term);
        const textParameter = `$${values.length}`;
        const roles = Object.entries(staffRoleLabels)
          .filter(([, labels]) =>
            labels.some((label) => label.toLowerCase().includes(term)),
          )
          .map(([role]) => role);
        if (roles.length) values.push(roles);
        clauses.push(
          `(strpos(regexp_replace(normalize(lower(u.username||' '||m.role),NFD),'[̀-ͯ]','','g'),${textParameter})>0${roles.length ? ` OR m.role=ANY($${values.length}::text[])` : ""})`,
        );
      }
      const countsRow = (
        await connection.query<{
          all: string;
          active: string;
          disabled: string;
        }>(
          `SELECT count(*) AS all,count(*) FILTER(WHERE u.active) AS active,count(*) FILTER(WHERE NOT u.active) AS disabled FROM poker_users u JOIN poker_memberships m ON m.user_id=u.id WHERE ${clauses.join(" AND ")}`,
          values,
        )
      ).rows[0];
      const counts = {
        ALL: Number(countsRow.all),
        ACTIVE: Number(countsRow.active),
        DISABLED: Number(countsRow.disabled),
      };
      const total =
        query.status === "active"
          ? counts.ACTIVE
          : query.status === "disabled"
            ? counts.DISABLED
            : counts.ALL;
      const page = Math.min(
        query.page,
        Math.max(0, Math.ceil(total / query.pageSize) - 1),
      );
      if (query.status !== "all") {
        values.push(query.status === "active");
        clauses.push(`u.active=$${values.length}`);
      }
      const fields: Record<string, string> = {
        username: 'lower(u.username) COLLATE "C"',
        role: 'lower(m.role) COLLATE "C"',
        active: "u.active",
      };
      const field = query.sort ? fields[query.sort] : undefined;
      const order = field
        ? `${field} ${query.direction === "desc" ? "DESC" : "ASC"},u.id COLLATE "C" ASC`
        : "u.active DESC,u.username,u.id";
      values.push(query.pageSize, page * query.pageSize);
      const { rows } = await connection.query<StaffAccount>(
        `SELECT u.id,u.username,u.active,m.role,(SELECT count(*)>1 FROM poker_memberships WHERE user_id=u.id) AS "sharedAccount" FROM poker_users u JOIN poker_memberships m ON m.user_id=u.id WHERE ${clauses.join(" AND ")} ORDER BY ${order} LIMIT $${values.length - 1} OFFSET $${values.length}`,
        values,
      );
      return {
        branchId: user.branchId,
        accounts: rows,
        total,
        page,
        pageSize: query.pageSize,
        counts,
      };
    });
  }
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
  options: { compact?: boolean } = {},
): Promise<Snapshot> {
  const parsed = staffMutationSchema.safeParse(input);
  if (!parsed.success)
    throw new DomainError("Check the username, password, role, and reason.");
  const { branchId, actorId, operationId, revision, command } = parsed.data;
  await admin(db, token);
  return db.transaction(async (connection) => {
    // Serialize account changes across venues before checking access and admin coverage.
    await lockStaffAccounts(connection);
    const actor = await admin(connection, token);
    if (actorId !== undefined && actorId !== actor.id)
      throw new DomainError(
        "Your signed-in account changed. Reload this page before continuing.",
        409,
      );
    if (actor.branchId !== branchId)
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
    // A logout or venue switch can commit while this request waits for the row.
    const authorized = await admin(connection, token);
    if (
      authorized.id !== actor.id ||
      authorized.branchId !== actor.branchId ||
      authorized.role !== actor.role
    )
      throw new DomainError(
        "Your access changed. Reload this page before continuing.",
        409,
      );
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
      assertOperationNotCancelled(previous.fingerprint);
      if (
        previous.actor_id !== actor.id ||
        previous.fingerprint !== fingerprint
      )
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
      assertStaffAccountMutable(target);
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
        await keepActiveAdmins(connection, target.id, [branchId]);
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
      await revokeStaffSessions(connection, target.id, target.username);
    }
    const original = {
      ...emptyStore(),
      settings: row.data.settings,
      currentDayId: row.data.currentDayId,
    };
    const next = structuredClone(original);
    next.auditLogs.unshift({
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
      [branchId, operationId, actor.id, fingerprint, row.revision + 1],
    );
    return options.compact
      ? readOperationalSnapshot(connection, token)
      : readSnapshot(connection, token);
  });
}
