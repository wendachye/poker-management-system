import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "./helpers/database";
import { hashPassword, login, sessionUser } from "../src/server/auth";
import { listStaff, manageStaff } from "../src/server/staff";
import { readSnapshot } from "../src/server/repository";
import type { StaffCommand } from "../src/domain/staff";
import { DomainError } from "../src/domain/operations";

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
  await assert.rejects(
    listStaff(fixture.db, cashierToken, { pageSize: 1 }),
    /Only an admin/,
  );
  await assert.rejects(
    listStaff(fixture.db, undefined, { pageSize: 1 }),
    /expired/,
  );
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
test("staff pages sort the full venue directory with bounded filters and stable counts", async () => {
  const { db, engine } = await testDatabase();
  try {
    const hash = await hashPassword(password);
    for (let index = 0; index < 25; index++) {
      await db.query(
        "INSERT INTO poker_users(id,username,password_hash,active) VALUES($1,$2,$3,$4)",
        [
          `directory-${index}`,
          `staff.${String(index).padStart(2, "0")}`,
          hash,
          index !== 24,
        ],
      );
      await db.query(
        "INSERT INTO poker_memberships(user_id,branch_id,role) VALUES($1,'local',$2)",
        [`directory-${index}`, index === 0 ? "ADMIN" : "CASHIER"],
      );
    }
    const session = await login(db, "staff.00", password);
    const page = await listStaff(db, session, {
      query: "staff.",
      status: "active",
      sort: "username",
      direction: "desc",
      pageSize: 10,
    });
    assert.equal(page.total, 24);
    assert.equal(page.pageSize, 10);
    assert.deepEqual(page.counts, { ALL: 25, ACTIVE: 24, DISABLED: 1 });
    assert.deepEqual(
      page.accounts.slice(0, 3).map((item) => item.username),
      ["staff.23", "staff.22", "staff.21"],
    );
    const last = await listStaff(db, session, {
      query: "staff.",
      status: "active",
      sort: "username",
      direction: "desc",
      pageSize: 10,
      page: 999,
    });
    assert.equal(last.page, 2);
    assert.equal(last.accounts.length, 4);
    assert.equal((await listStaff(db, session)).accounts.length, 25);
    const filtered = await listStaff(db, session, {
      query: "STAFF.2",
      role: "CASHIER",
      status: "disabled",
      sort: "active",
      direction: "desc",
    });
    assert.deepEqual(
      filtered.accounts.map((account) => account.username),
      ["staff.24"],
    );
    assert.deepEqual(filtered.counts, { ALL: 5, ACTIVE: 4, DISABLED: 1 });
    assert.equal((await listStaff(db, session, { query: "%" })).total, 0);
    for (const invalid of [
      { pageSize: 51 },
      { sort: "username; DROP TABLE poker_users" },
      { branchId: "other" },
      { direction: "desc" },
    ])
      await assert.rejects(listStaff(db, session, invalid), /valid/);
  } finally {
    await engine.close();
  }
});
test("paged staff search matches displayed Chinese role labels and literal partial terms", async () => {
  const { db, engine } = await testDatabase();
  try {
    const hash = await hashPassword(password);
    for (const [id, role, active] of [
      ["bilingual.admin", "ADMIN", true],
      ["cashier.alpha", "CASHIER", true],
      ["cashier.zulu", "CASHIER", false],
      ["bilingual.manager", "MANAGER", true],
      ["bilingual.dealer", "DEALER", true],
    ] as const) {
      await db.query(
        "INSERT INTO poker_users(id,username,password_hash,active) VALUES($1,$1,$2,$3)",
        [id, hash, active],
      );
      await db.query(
        "INSERT INTO poker_memberships(user_id,branch_id,role) VALUES($1,'local',$2)",
        [id, role],
      );
    }
    const session = await login(db, "bilingual.admin", password);
    for (const query of ["收银员", "收银", "CASHIER"]) {
      const page = await listStaff(db, session, {
        query,
        sort: "username",
        direction: "desc",
        pageSize: 1,
      });
      assert.equal(page.total, 2);
      assert.deepEqual(page.counts, { ALL: 2, ACTIVE: 1, DISABLED: 1 });
      assert.deepEqual(
        page.accounts.map((account) => account.username),
        ["cashier.zulu"],
      );
      const second = await listStaff(db, session, {
        query,
        sort: "username",
        direction: "desc",
        pageSize: 1,
        page: 1,
      });
      assert.deepEqual(
        second.accounts.map((account) => account.username),
        ["cashier.alpha"],
      );
    }
    for (const [query, username] of [
      ["经理", "bilingual.manager"],
      ["荷", "bilingual.dealer"],
      ["管理", "bilingual.admin"],
      ["cashier.alpha 收银", "cashier.alpha"],
    ]) {
      const page = await listStaff(db, session, { query });
      assert.deepEqual(
        page.accounts.map((account) => account.username),
        [username],
      );
    }
    assert.equal((await listStaff(db, session, { query: "收银%" })).total, 0);
    const enabled = await listStaff(db, session, {
      query: "收银员",
      status: "active",
    });
    assert.deepEqual(
      enabled.accounts.map((account) => account.username),
      ["cashier.alpha"],
    );
    assert.deepEqual(enabled.counts, { ALL: 2, ACTIVE: 1, DISABLED: 1 });
  } finally {
    await engine.close();
  }
});
test("create staff enforces the draft actor, persists once across retries, and audits no secrets", async () => {
  const request = {
    ...(await payload({
      kind: "STAFF_CREATE",
      username: "new.staff",
      password,
      role: "CASHIER",
      reason: "New counter staff",
    })),
    actorId: "admin",
  };
  const before = await readSnapshot(fixture.db, token);
  const accountsBefore = await listStaff(fixture.db, token);
  await assert.rejects(
    manageStaff(fixture.db, token, { ...request, actorId: "previous-admin" }),
    (error) => {
      assert.ok(error instanceof DomainError);
      assert.equal(error.status, 409);
      assert.match(error.message, /account changed/);
      return true;
    },
  );
  assert.deepEqual(await readSnapshot(fixture.db, token), before);
  assert.deepEqual(await listStaff(fixture.db, token), accountsBefore);
  assert.equal(
    (
      await fixture.db.query(
        "SELECT operation_id FROM poker_operations WHERE operation_id=$1",
        [request.operationId],
      )
    ).rows.length,
    0,
  );
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
