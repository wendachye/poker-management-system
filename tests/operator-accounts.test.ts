import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { testDatabase } from "./helpers/database";
import {
  hashPassword,
  login,
  sessionUser,
  changeBranch,
} from "../src/server/auth";
import { createBackup, restoreBackup } from "../src/server/backup";
import type { Database, SqlConnection } from "../src/server/database";
import { DomainError } from "../src/domain/operations";
import {
  manageOperatorAccount,
  type OperatorAccountCommand,
  type OperatorAccountInput,
} from "../src/server/operator-accounts";
import { manageStaff } from "../src/server/staff";

const password = "fictional-operator-test-password";
const replacement = "fictional-replacement-password";
function input(command: OperatorAccountCommand): OperatorAccountInput {
  return {
    operationId: randomUUID(),
    operator: "Local test operator",
    reason: "Fictional account maintenance",
    command,
  };
}
async function seed(db: Database) {
  const hash = await hashPassword(password);
  for (const [id, memberships] of [
    [
      "owner",
      [
        ["local", "ADMIN"],
        ["other", "ADMIN"],
      ],
    ],
    [
      "shared",
      [
        ["local", "MANAGER"],
        ["other", "CASHIER"],
      ],
    ],
  ] as const) {
    await db.query(
      "INSERT INTO poker_users(id,username,password_hash) VALUES($1,$1,$2)",
      [id, hash],
    );
    for (const [venue, role] of memberships)
      await db.query(
        "INSERT INTO poker_memberships(user_id,branch_id,role) VALUES($1,$2,$3)",
        [id, venue, role],
      );
  }
}
async function state(db: SqlConnection) {
  return (
    await db.query<{ data: unknown }>(`SELECT jsonb_build_object(
    'users',(SELECT jsonb_agg(to_jsonb(u) ORDER BY id) FROM poker_users u),
    'memberships',(SELECT jsonb_agg(to_jsonb(m) ORDER BY user_id,branch_id) FROM poker_memberships m),
    'sessions',(SELECT jsonb_agg(to_jsonb(s) ORDER BY token_hash) FROM poker_sessions s),
    'attempts',(SELECT jsonb_agg(to_jsonb(a) ORDER BY username) FROM poker_login_attempts a),
    'states',(SELECT jsonb_agg(to_jsonb(s) ORDER BY branch_id) FROM poker_branch_state s),
    'versions',(SELECT jsonb_agg(to_jsonb(v) ORDER BY branch_id,key) FROM poker_change_versions v),
    'operations',(SELECT jsonb_agg(to_jsonb(o) ORDER BY branch_id,operation_id) FROM poker_operations o),
    'audit',(SELECT jsonb_agg(to_jsonb(a) ORDER BY branch_id,id) FROM poker_audit a)
  ) AS data`)
  ).rows[0].data;
}
async function rejectsStatus(
  work: Promise<unknown>,
  status: number,
  message?: RegExp,
) {
  await assert.rejects(work, (error: unknown) => {
    assert.ok(error instanceof DomainError);
    assert.equal(error.status, status);
    if (message) assert.match(error.message, message);
    return true;
  });
}

test("operator creation is audited, secret-safe, validated and replayed without repeating a save", async () => {
  const { db, engine } = await testDatabase();
  try {
    const before = await state(db);
    const create = input({
      kind: "CREATE",
      username: "  First.Admin  ",
      password,
      branchId: "local",
      role: "ADMIN",
    });
    for (const patch of [
      { operator: "" },
      { reason: "" },
      { operationId: "invalid" },
      { command: { ...create.command, username: "!operator:reserved" } },
    ])
      await rejectsStatus(
        manageOperatorAccount(db, { ...create, ...patch }),
        400,
      );
    assert.deepEqual(await state(db), before);
    const saved = await manageOperatorAccount(db, create);
    assert.equal(saved.username, "first.admin");
    assert.deepEqual(saved.branchIds, ["local"]);
    assert.equal(saved.replayed, false);
    const after = await state(db);
    assert.deepEqual(await manageOperatorAccount(db, create), {
      ...saved,
      replayed: true,
    });
    assert.deepEqual(await state(db), after);
    await rejectsStatus(
      manageOperatorAccount(db, {
        ...create,
        reason: "Different operation reason",
      }),
      409,
      /identifier/,
    );
    await rejectsStatus(
      manageOperatorAccount(db, {
        ...create,
        command: { ...create.command, password: replacement },
      }),
      409,
      /identifier/,
    );
    assert.deepEqual(await state(db), after);
    const audit = (
      await db.query<{ data: Record<string, string>; actor_id: string }>(
        "SELECT data,actor_id FROM poker_audit WHERE branch_id='local'",
      )
    ).rows[0];
    const principal = (
      await db.query<{ principal: string }>(
        "SELECT session_user::text AS principal",
      )
    ).rows[0].principal;
    assert.equal(
      audit.data.actor,
      `Operator: Local test operator (${principal})`,
    );
    assert.notEqual(audit.actor_id, saved.userId);
    const serialized = JSON.stringify(audit);
    assert.equal(serialized.includes(password), false);
    assert.equal(serialized.includes("password_hash"), false);
    const technical = (
      await db.query<{
        username: string;
        active: boolean;
        memberships: string;
      }>(
        `SELECT u.username,u.active,
      (SELECT count(*)::text FROM poker_memberships WHERE user_id=u.id) AS memberships FROM poker_users u WHERE id=$1`,
        [audit.actor_id],
      )
    ).rows[0];
    assert.equal(technical.active, false);
    assert.equal(technical.memberships, "0");
    assert.match(technical.username, /^!operator:[a-f0-9]{64}$/);
    await rejectsStatus(login(db, technical.username, password), 401);
    assert.ok(await login(db, saved.username, password));
    assert.equal(
      (
        await db.query<{ revision: number }>(
          "SELECT revision FROM poker_branch_state WHERE branch_id='local'",
        )
      ).rows[0].revision,
      1,
    );
  } finally {
    await engine.close();
  }
});

test("operator disable and demotion protect every affected venue and reject missing accounts atomically", async () => {
  const { db, engine } = await testDatabase();
  try {
    await seed(db);
    const before = await state(db);
    await rejectsStatus(
      manageOperatorAccount(db, input({ kind: "DISABLE", username: "absent" })),
      404,
    );
    await rejectsStatus(
      manageOperatorAccount(
        db,
        input({ kind: "PASSWORD", username: "absent", password, enable: true }),
      ),
      404,
    );
    await rejectsStatus(
      manageOperatorAccount(
        db,
        input({
          kind: "GRANT",
          username: "absent",
          branchId: "local",
          role: "ADMIN",
        }),
      ),
      404,
    );
    await rejectsStatus(
      manageOperatorAccount(db, input({ kind: "DISABLE", username: "owner" })),
      409,
      /active admin/,
    );
    await rejectsStatus(
      manageOperatorAccount(
        db,
        input({
          kind: "GRANT",
          username: "owner",
          branchId: "local",
          role: "MANAGER",
        }),
      ),
      409,
      /active admin/,
    );
    assert.deepEqual(await state(db), before);
    // A backup admin in one venue does not make a global disable safe in another.
    await db.query(
      "UPDATE poker_memberships SET role='ADMIN' WHERE user_id='shared' AND branch_id='local'",
    );
    const partialCoverage = await state(db);
    await rejectsStatus(
      manageOperatorAccount(db, input({ kind: "DISABLE", username: "owner" })),
      409,
      /active admin/,
    );
    assert.deepEqual(await state(db), partialCoverage);
    await db.query(
      "UPDATE poker_memberships SET role='ADMIN' WHERE user_id='shared' AND branch_id='other'",
    );
    const changed = await manageOperatorAccount(
      db,
      input({ kind: "DISABLE", username: "owner" }),
    );
    assert.deepEqual(changed.branchIds, ["local", "other"]);
    assert.equal(
      (
        await db.query<{ active: boolean }>(
          "SELECT active FROM poker_users WHERE id='owner'",
        )
      ).rows[0].active,
      false,
    );
  } finally {
    await engine.close();
  }
});

test("shared reset, disable, enable and local role updates revoke all sessions and audit only local role data", async () => {
  const { db, engine } = await testDatabase();
  try {
    await seed(db);
    const first = await login(db, "shared", password);
    const second = await login(db, "shared", password);
    await changeBranch(db, second, "other");
    await db.query(
      "INSERT INTO poker_login_attempts(username,attempts,window_start) VALUES('shared',10,now())",
    );
    const reset = input({
      kind: "PASSWORD",
      username: "shared",
      password: replacement,
      enable: false,
    });
    const saved = await manageOperatorAccount(db, reset);
    assert.deepEqual(saved.branchIds, ["local", "other"]);
    assert.equal(await sessionUser(db, first), null);
    assert.equal(await sessionUser(db, second), null);
    assert.equal(
      (
        await db.query(
          "SELECT username FROM poker_login_attempts WHERE username='shared'",
        )
      ).rows.length,
      0,
    );
    await rejectsStatus(login(db, "shared", password), 401);
    const nextToken = await login(db, "shared", replacement);
    const roleChange = input({
      kind: "GRANT",
      username: "shared",
      branchId: "local",
      role: "DEALER",
    });
    await manageOperatorAccount(db, roleChange);
    assert.equal(await sessionUser(db, nextToken), null);
    assert.equal(
      (
        await db.query<{ role: string }>(
          "SELECT role FROM poker_memberships WHERE user_id='shared' AND branch_id='other'",
        )
      ).rows[0].role,
      "CASHIER",
    );
    await manageOperatorAccount(
      db,
      input({ kind: "DISABLE", username: "shared" }),
    );
    await rejectsStatus(login(db, "shared", replacement), 401);
    await manageOperatorAccount(
      db,
      input({ kind: "PASSWORD", username: "shared", password, enable: false }),
    );
    await rejectsStatus(login(db, "shared", password), 401);
    await manageOperatorAccount(
      db,
      input({ kind: "PASSWORD", username: "shared", password, enable: true }),
    );
    assert.ok(await login(db, "shared", password));
    const logs = (
      await db.query<{
        branch_id: string;
        data: { before: string; after: string };
      }>("SELECT branch_id,data FROM poker_audit ORDER BY branch_id,order_no")
    ).rows;
    assert.equal(logs.length, 10);
    for (const log of logs) {
      const after = JSON.parse(log.data.after) as Record<string, unknown>;
      assert.deepEqual(Object.keys(after).sort(), [
        "active",
        "id",
        "role",
        "username",
      ]);
      if (log.branch_id === "other") assert.equal(after.role, "CASHIER");
      assert.equal(JSON.stringify(log).includes(password), false);
      assert.equal(JSON.stringify(log).includes(replacement), false);
      assert.equal(JSON.stringify(log).includes("password_hash"), false);
    }
  } finally {
    await engine.close();
  }
});

test("a failure in the second venue audit rolls back account, sessions, both revisions and retry markers", async () => {
  const { db, engine } = await testDatabase();
  try {
    await seed(db);
    const token = await login(db, "shared", password);
    const before = await state(db);
    const broken: Database = {
      query: db.query,
      transaction: (work) =>
        db.transaction((connection) =>
          work({
            async query<T>(sql: string, values?: unknown[]) {
              if (
                sql.startsWith("INSERT INTO poker_audit") &&
                values?.[0] === "other"
              )
                throw new Error("Synthetic second venue audit failure");
              return connection.query<T>(sql, values);
            },
          }),
        ),
    };
    const command = input({
      kind: "PASSWORD",
      username: "shared",
      password: replacement,
      enable: false,
    });
    await assert.rejects(
      manageOperatorAccount(broken, command),
      /Synthetic second venue audit failure/,
    );
    assert.deepEqual(await state(db), before);
    assert.ok(await sessionUser(db, token));
    assert.equal((await manageOperatorAccount(db, command)).replayed, false);
    assert.equal(await sessionUser(db, token), null);
  } finally {
    await engine.close();
  }
});

test("operator retry survives later grants and backup restore while reserved actors cannot be enabled through staff commands", async () => {
  const { db, engine } = await testDatabase();
  try {
    await seed(db);
    const request = input({
      kind: "CREATE",
      username: "venue.staff",
      password,
      branchId: "local",
      role: "CASHIER",
    });
    const created = await manageOperatorAccount(db, request);
    await manageOperatorAccount(
      db,
      input({
        kind: "GRANT",
        username: "venue.staff",
        branchId: "other",
        role: "MANAGER",
      }),
    );
    const before = await state(db);
    assert.deepEqual(await manageOperatorAccount(db, request), {
      ...created,
      replayed: true,
    });
    assert.deepEqual(await state(db), before);
    const backup = await createBackup(db);
    await restoreBackup(db, backup, async () => {});
    assert.deepEqual(await manageOperatorAccount(db, request), {
      ...created,
      replayed: true,
    });
    const actor = (
      await db.query<{ id: string; username: string }>(
        "SELECT id,username FROM poker_users WHERE username LIKE '!operator:%'",
      )
    ).rows[0];
    for (const command of [
      {
        kind: "GRANT",
        username: actor.username,
        branchId: "local",
        role: "ADMIN",
      },
      { kind: "PASSWORD", username: actor.username, password, enable: true },
    ])
      await rejectsStatus(
        manageOperatorAccount(db, {
          ...input({ kind: "DISABLE", username: "owner" }),
          command,
        }),
        400,
      );
    // Even corrupt membership data cannot turn the audit identity into staff.
    await db.query(
      "INSERT INTO poker_memberships(user_id,branch_id,role) VALUES($1,'local','CASHIER')",
      [actor.id],
    );
    const owner = await login(db, "owner", password);
    const revision = (
      await db.query<{ revision: number }>(
        "SELECT revision FROM poker_branch_state WHERE branch_id='local'",
      )
    ).rows[0].revision;
    await rejectsStatus(
      manageStaff(db, owner, {
        branchId: "local",
        revision,
        operationId: randomUUID(),
        command: {
          kind: "STAFF_PASSWORD",
          userId: actor.id,
          password,
          enable: true,
          reason: "Must remain disabled",
        },
      }),
      403,
      /audit identities/,
    );
    await rejectsStatus(
      manageOperatorAccount(
        db,
        input({ kind: "DISABLE", username: "venue.staff" }),
      ),
      503,
      /audit identity is invalid/,
    );
    assert.equal(
      (
        await db.query<{ active: boolean }>(
          "SELECT active FROM poker_users WHERE id=$1",
          [actor.id],
        )
      ).rows[0].active,
      false,
    );
  } finally {
    await engine.close();
  }
});
