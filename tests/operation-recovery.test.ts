import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { DomainError } from "../src/domain/operations";
import { changeBranch, hashPassword, login } from "../src/server/auth";
import { createBackup, restoreBackup } from "../src/server/backup";
import type { Database } from "../src/server/database";
import { createLocation } from "../src/server/locations";
import {
  CANCELLED_OPERATION_FINGERPRINT,
  recoverOperation,
} from "../src/server/operation-recovery";
import { mutate, readSnapshot } from "../src/server/repository";
import { readOperationalSnapshot } from "../src/server/queries";
import { manageStaff } from "../src/server/staff";
import { testDatabase } from "./helpers/database";
import { POST as recoverRoute } from "../src/app/api/operations/recover/route";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
let adminToken: string, cashierToken: string, otherToken: string;
const password = "recovery-test-password";
before(async () => {
  fixture = await testDatabase();
  const hash = await hashPassword(password);
  for (const [id, branch, role] of [
    ["admin", "local", "ADMIN"],
    ["cashier", "local", "CASHIER"],
    ["other-admin", "other", "ADMIN"],
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
  await fixture.db.query(
    "INSERT INTO poker_memberships(user_id,branch_id,role) VALUES('admin','other','ADMIN')",
  );
  adminToken = await login(fixture.db, "admin", password);
  // The venue names sort local first, so the shared administrator starts here.
  assert.equal((await readSnapshot(fixture.db, adminToken)).branch.id, "local");
  cashierToken = await login(fixture.db, "cashier", password);
  otherToken = await login(fixture.db, "other-admin", password);
});
after(async () => fixture.engine.close());

function reference(operationId = randomUUID()) {
  return { branchId: "local", actorId: "admin", operationId };
}
function errorStatus(expected: number) {
  return (error: unknown) => {
    assert.ok(error instanceof DomainError);
    assert.equal(error.status, expected);
    return true;
  };
}
async function operationCount() {
  return (
    await fixture.db.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM poker_operations",
    )
  ).rows[0].count;
}

test("recovery checkpoints reject malformed references and unrelated sensitive payloads", async () => {
  const count = await operationCount();
  for (const input of [
    null,
    {},
    { ...reference(), operationId: "not-a-uuid" },
    { ...reference(), actorId: "" },
    { ...reference(), branchId: "x".repeat(101) },
    { ...reference(), command: { password } },
  ])
    await assert.rejects(
      recoverOperation(fixture.db, adminToken, input),
      errorStatus(400),
    );
  assert.equal(await operationCount(), count);
});

test("the recovery route is disabled before database access in sample prototype mode", async () => {
  const previous = process.env.POKER_PROTOTYPE_MODE;
  process.env.POKER_PROTOTYPE_MODE = "1";
  try {
    const response = await recoverRoute(
      new Request("http://localhost/api/operations/recover", {
        method: "POST",
        body: JSON.stringify(reference()),
      }),
    );
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {
      error: "Staff APIs are disabled in the sample-data prototype.",
    });
  } finally {
    if (previous === undefined) delete process.env.POKER_PROTOTYPE_MODE;
    else process.env.POKER_PROTOTYPE_MODE = previous;
  }
});

test("recovery requires the original staff and active venue without changing either venue", async () => {
  const count = await operationCount();
  const before = await readSnapshot(fixture.db, adminToken);
  const other = await readSnapshot(fixture.db, otherToken);
  await assert.rejects(
    recoverOperation(fixture.db, undefined, reference()),
    errorStatus(401),
  );
  await assert.rejects(
    recoverOperation(fixture.db, cashierToken, reference()),
    errorStatus(409),
  );
  await assert.rejects(
    recoverOperation(fixture.db, adminToken, {
      ...reference(),
      branchId: "other",
    }),
    errorStatus(409),
  );
  assert.equal(await operationCount(), count);
  assert.deepEqual(await readSnapshot(fixture.db, adminToken), before);
  assert.deepEqual(await readSnapshot(fixture.db, otherToken), other);
});

test("an absent operation is immutably cancelled, repeated recovery is safe, and a delayed state save cannot post", async () => {
  const input = reference();
  const before = await readSnapshot(fixture.db, adminToken);
  const compactBefore = await readOperationalSnapshot(fixture.db, adminToken);
  const request = {
    ...input,
    revision: before.revision,
    command: {
      kind: "TABLE",
      name: "Cancelled table",
      dealer: "",
      status: "OPEN",
    },
  };
  const result = await recoverOperation(fixture.db, adminToken, input);
  assert.equal(result.status, "cancelled");
  assert.equal(result.operationId, input.operationId);
  assert.equal(result.actorId, input.actorId);
  assert.equal(result.branchId, input.branchId);
  assert.deepEqual(result.snapshot, compactBefore);
  assert.deepEqual(
    await recoverOperation(fixture.db, adminToken, input),
    result,
  );
  await assert.rejects(
    mutate(fixture.db, adminToken, request),
    /cancelled during recovery/,
  );
  assert.deepEqual(await readSnapshot(fixture.db, adminToken), before);
  const rows = (
    await fixture.db.query<{ fingerprint: string; revision: number }>(
      "SELECT fingerprint,revision FROM poker_operations WHERE branch_id=$1 AND operation_id=$2",
      [input.branchId, input.operationId],
    )
  ).rows;
  assert.deepEqual(rows, [
    { fingerprint: CANCELLED_OPERATION_FINGERPRINT, revision: before.revision },
  ]);
  assert.equal(
    JSON.stringify(result).includes(CANCELLED_OPERATION_FINGERPRINT),
    false,
  );
  assert.equal(JSON.stringify(result).includes("password_hash"), false);
});

test("cancelled staff and location requests cannot save when their original POST arrives later", async () => {
  const before = await readSnapshot(fixture.db, adminToken);
  for (const [execute, command] of [
    [
      manageStaff,
      {
        kind: "STAFF_CREATE",
        username: "cancelled.staff",
        password,
        role: "CASHIER",
        reason: "Fictional cancelled request",
      },
    ],
    [
      createLocation,
      {
        kind: "CREATE_LOCATION",
        id: "cancelled-venue",
        name: "Cancelled Venue",
        timezone: "Asia/Kuala_Lumpur",
      },
    ],
  ] as const) {
    const input = reference();
    assert.equal(
      (await recoverOperation(fixture.db, adminToken, input)).status,
      "cancelled",
    );
    await assert.rejects(
      execute(fixture.db, adminToken, {
        ...input,
        revision: before.revision,
        command,
      }),
      /cancelled during recovery/,
    );
  }
  assert.deepEqual(await readSnapshot(fixture.db, adminToken), before);
  assert.equal(
    (
      await fixture.db.query(
        "SELECT id FROM poker_users WHERE username='cancelled.staff'",
      )
    ).rows.length,
    0,
  );
  assert.equal(
    (
      await fixture.db.query(
        "SELECT id FROM poker_branches WHERE id='cancelled-venue'",
      )
    ).rows.length,
    0,
  );
});

test("saved receipts across all three writers are confirmed without replaying commands or leaking credentials", async () => {
  for (const [execute, command] of [
    [
      mutate,
      { kind: "TABLE", name: "Saved table", dealer: "", status: "OPEN" },
    ],
    [
      manageStaff,
      {
        kind: "STAFF_CREATE",
        username: "saved.staff",
        password,
        role: "CASHIER",
        reason: "Fictional saved request",
      },
    ],
    [
      createLocation,
      {
        kind: "CREATE_LOCATION",
        id: "saved-venue",
        name: "Saved Venue",
        timezone: "Asia/Kuala_Lumpur",
      },
    ],
  ] as const) {
    const input = reference();
    const before = await readSnapshot(fixture.db, adminToken);
    const saved = await execute(
      fixture.db,
      adminToken,
      { ...input, revision: before.revision, command },
      { compact: true },
    );
    const count = await operationCount();
    const recovered = await recoverOperation(fixture.db, adminToken, input);
    assert.equal(recovered.status, "saved");
    assert.deepEqual(recovered.snapshot, saved);
    assert.deepEqual(
      await recoverOperation(fixture.db, adminToken, input),
      recovered,
    );
    assert.equal(await operationCount(), count);
    assert.equal(JSON.stringify(recovered).includes(password), false);
    assert.equal(JSON.stringify(recovered).includes("password_hash"), false);
    await assert.rejects(
      recoverOperation(fixture.db, cashierToken, {
        ...input,
        actorId: "cashier",
      }),
      errorStatus(403),
    );
  }
});

test("recovery rechecks session, role and active venue after acquiring the writer lock", async () => {
  for (const [change, expected] of [
    ["DELETE FROM poker_sessions WHERE user_id='admin'", 401],
    ["UPDATE poker_sessions SET branch_id='other' WHERE user_id='admin'", 409],
    [
      "UPDATE poker_memberships SET role='DEALER' WHERE user_id='admin' AND branch_id='local'",
      409,
    ],
  ] as const) {
    const count = await operationCount();
    const intercepted: Database = {
      query: fixture.db.query.bind(fixture.db),
      transaction: (work) =>
        fixture.db.transaction((connection) =>
          work({
            async query<T>(sql: string, values?: unknown[]) {
              const result = await connection.query<T>(sql, values);
              if (
                sql ===
                "SELECT revision FROM poker_branch_state WHERE branch_id=$1 FOR UPDATE"
              )
                await connection.query(change);
              return result;
            },
          }),
        ),
    };
    await assert.rejects(
      recoverOperation(intercepted, adminToken, reference()),
      errorStatus(expected),
    );
    assert.equal(await operationCount(), count);
    assert.equal(
      (await readSnapshot(fixture.db, adminToken)).user.role,
      "ADMIN",
    );
  }
});

test("cancelled operation barriers survive full backup and restore", async () => {
  const input = reference();
  const before = await readSnapshot(fixture.db, adminToken);
  await recoverOperation(fixture.db, adminToken, input);
  const backup = await createBackup(fixture.db);
  assert.equal(
    backup.payload.operations.find(
      (row) => row.operation_id === input.operationId,
    )?.fingerprint,
    CANCELLED_OPERATION_FINGERPRINT,
  );
  await restoreBackup(fixture.db, backup, async () => {});
  adminToken = await login(fixture.db, "admin", password);
  await changeBranch(fixture.db, adminToken, "local");
  assert.equal(
    (await recoverOperation(fixture.db, adminToken, input)).status,
    "cancelled",
  );
  await assert.rejects(
    mutate(fixture.db, adminToken, {
      ...input,
      revision: before.revision,
      command: {
        kind: "TABLE",
        name: "Delayed after restore",
        dealer: "",
        status: "OPEN",
      },
    }),
    /cancelled during recovery/,
  );
  assert.deepEqual(await readSnapshot(fixture.db, adminToken), before);
});
