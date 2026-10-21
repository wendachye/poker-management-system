import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "./helpers/database";
import { hashPassword, login, sessionUser } from "../src/server/auth";
import { listStaff, manageStaff } from "../src/server/staff";
import { readSnapshot } from "../src/server/repository";
import type { StaffCommand } from "../src/domain/staff";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
let token: string, cashierToken: string, accountId: string;
const password = "test-staff-password";
before(async () => {
  fixture = await testDatabase();
  const hash = await hashPassword(password);
  for (const [id, role, branch] of [
    ["admin", "ADMIN", "local"],
    ["cashier", "CASHIER", "local"],
    ["other", "ADMIN", "other"],
  ]) {
    await fixture.db.query(
      "INSERT INTO poker_users(id,username,password_hash) VALUES($1,$1,$2)",
      [id, hash],
    );
    await fixture.db.query(
      "INSERT INTO poker_memberships(user_id,branch_id,role) VALUES($1,$2,$3)",
      [id, branch, role],
    );
  }
  token = await login(fixture.db, "admin", password);
  cashierToken = await login(fixture.db, "cashier", password);
});
after(async () => fixture.engine.close());
async function payload<T extends StaffCommand>(command: T) {
  return {
    branchId: "local",
    operationId: crypto.randomUUID(),
    revision: (await readSnapshot(fixture.db, token)).revision,
    command,
  };
}
test("staff access is admin-only, branch scoped, and does not expose password hashes", async () => {
  await assert.rejects(listStaff(fixture.db, cashierToken), /Only an admin/);
  await assert.rejects(listStaff(fixture.db, undefined), /expired/);
  const list = await listStaff(fixture.db, token);
  assert.deepEqual(
    list.accounts.map((a) => a.username),
    ["admin", "cashier"],
  );
  assert.equal(JSON.stringify(list).includes("password"), false);
  await assert.rejects(
    manageStaff(
      fixture.db,
      token,
      await payload({
        kind: "STAFF_ROLE",
        userId: "other",
        role: "DEALER",
        reason: "Not allowed",
      }),
    ),
    /not found/,
  );
  await assert.rejects(
    manageStaff(
      fixture.db,
      cashierToken,
      await payload({
        kind: "STAFF_CREATE",
        username: "forged",
        password,
        role: "ADMIN",
        reason: "Not allowed",
      }),
    ),
    /Only an admin/,
  );
});
test("create staff persists once across retries, audits no secrets, and rejects stale/invalid writes", async () => {
  const request = await payload({
    kind: "STAFF_CREATE",
    username: "new.staff",
    password,
    role: "CASHIER",
    reason: "New counter staff",
  });
  const saved = await manageStaff(fixture.db, token, request);
  assert.deepEqual(await manageStaff(fixture.db, token, request), saved);
  accountId = (await listStaff(fixture.db, token)).accounts.find(
    (a) => a.username === "new.staff",
  )!.id;
  const log = saved.store.auditLogs[0];
  assert.equal(log.action, "Created staff account");
  assert.equal(JSON.stringify(log).includes(password), false);
  assert.equal(JSON.stringify(log).includes("password_hash"), false);
  await assert.rejects(
    manageStaff(fixture.db, token, {
      ...request,
      command: { ...request.command, password: "different-password" },
    }),
    /identifier/,
  );
  await assert.rejects(
    manageStaff(fixture.db, token, {
      ...request,
      operationId: crypto.randomUUID(),
    }),
    /updated this branch/,
  );
  await assert.rejects(
    manageStaff(
      fixture.db,
      token,
      await payload({ ...request.command, password: "short" }),
    ),
    /Check the username/,
  );
  await assert.rejects(
    manageStaff(fixture.db, token, {
      ...(await payload(request.command)),
      branchId: "other",
    }),
    /branch changed/,
  );
});
test("role changes, password reset, disable and enable revoke sessions while preserving historical accounts", async () => {
  let staffToken = await login(fixture.db, "new.staff", password);
  const promoted = await manageStaff(
    fixture.db,
    token,
    await payload({
      kind: "STAFF_ROLE",
      userId: accountId,
      role: "MANAGER",
      reason: "Promotion",
    }),
  );
  assert.equal(promoted.store.auditLogs[0].action, "Changed staff role");
  assert.equal(promoted.store.auditLogs[1].action, "Created staff account");
  assert.equal(await sessionUser(fixture.db, staffToken), null);
  staffToken = await login(fixture.db, "new.staff", password);
  assert.equal((await sessionUser(fixture.db, staffToken))?.role, "MANAGER");
  await manageStaff(
    fixture.db,
    token,
    await payload({
      kind: "STAFF_PASSWORD",
      userId: accountId,
      password: "replacement-password",
      enable: false,
      reason: "Forgotten password",
    }),
  );
  assert.equal(await sessionUser(fixture.db, staffToken), null);
  await assert.rejects(login(fixture.db, "new.staff", password), /Invalid/);
  staffToken = await login(fixture.db, "new.staff", "replacement-password");
  await manageStaff(
    fixture.db,
    token,
    await payload({
      kind: "STAFF_DISABLE",
      userId: accountId,
      reason: "Staff departed",
    }),
  );
  assert.equal(await sessionUser(fixture.db, staffToken), null);
  await assert.rejects(
    login(fixture.db, "new.staff", "replacement-password"),
    /Invalid/,
  );
  assert.equal(
    (await listStaff(fixture.db, token)).accounts.find(
      (a) => a.id === accountId,
    )?.active,
    false,
  );
  await manageStaff(
    fixture.db,
    token,
    await payload({
      kind: "STAFF_PASSWORD",
      userId: accountId,
      password,
      enable: true,
      reason: "Staff returned",
    }),
  );
  assert.ok(await login(fixture.db, "new.staff", password));
});
test("an admin cannot disable/demote/reset themselves or change shared-account global credentials", async () => {
  for (const command of [
    { kind: "STAFF_DISABLE", userId: "admin", reason: "Self disable" },
    {
      kind: "STAFF_ROLE",
      userId: "admin",
      role: "DEALER",
      reason: "Self demotion",
    },
    {
      kind: "STAFF_PASSWORD",
      userId: "admin",
      password,
      enable: false,
      reason: "Self reset",
    },
  ] as StaffCommand[])
    await assert.rejects(
      manageStaff(fixture.db, token, await payload(command)),
      /another admin/,
    );
  await fixture.db.query(
    "INSERT INTO poker_memberships(user_id,branch_id,role) VALUES($1,'other','ADMIN')",
    [accountId],
  );
  assert.equal(
    (await listStaff(fixture.db, token)).accounts.find(
      (a) => a.id === accountId,
    )?.sharedAccount,
    true,
  );
  for (const command of [
    { kind: "STAFF_DISABLE", userId: accountId, reason: "Global disable" },
    {
      kind: "STAFF_PASSWORD",
      userId: accountId,
      password,
      enable: false,
      reason: "Global reset",
    },
  ] as StaffCommand[])
    await assert.rejects(
      manageStaff(fixture.db, token, await payload(command)),
      /multiple locations/,
    );
  await manageStaff(
    fixture.db,
    token,
    await payload({
      kind: "STAFF_ROLE",
      userId: accountId,
      role: "DEALER",
      reason: "Local role change",
    }),
  );
  assert.equal(
    (
      await fixture.db.query<{ role: string }>(
        "SELECT role FROM poker_memberships WHERE user_id=$1 AND branch_id='other'",
        [accountId],
      )
    ).rows[0].role,
    "ADMIN",
  );
});
