import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "./helpers/database";
import { hashPassword, login, changeBranch } from "../src/server/auth";
import { createLocation, listLocations } from "../src/server/locations";
import { readSnapshot, mutate } from "../src/server/repository";
import { venueSettings } from "../src/domain/settings";

test("location creation is admin-only, retry-safe, isolated and ready for independent setup", async () => {
  const { db, engine } = await testDatabase();
  try {
    const password = "test-location-password";
    const hash = await hashPassword(password);
    for (const [id, branch, role] of [
      ["owner", "local", "ADMIN"],
      ["cashier", "local", "CASHIER"],
      ["other-owner", "other", "ADMIN"],
    ]) {
      await db.query(
        "INSERT INTO poker_users(id,username,password_hash) VALUES($1,$1,$2)",
        [id, hash],
      );
      await db.query(
        "INSERT INTO poker_memberships(user_id,branch_id,role) VALUES($1,$2,$3)",
        [id, branch, role],
      );
    }
    const token = await login(db, "owner", password);
    const cashierToken = await login(db, "cashier", password);
    const before = await readSnapshot(db, token);
    const request = {
      branchId: "local",
      revision: before.revision,
      operationId: crypto.randomUUID(),
      command: {
        kind: "CREATE_LOCATION",
        id: "new-store",
        name: "New Store",
        timezone: "Asia/Singapore",
      },
    };
    await assert.rejects(createLocation(db, undefined, request), /expired/);
    await assert.rejects(
      createLocation(db, cashierToken, request),
      /Only an admin/,
    );
    assert.deepEqual(
      (await listLocations(db, token)).branches.map((branch) => branch.id),
      ["local"],
    );
    const created = await createLocation(db, token, request);
    const retried = await createLocation(db, token, request);
    assert.deepEqual(retried, created);
    assert.equal(created.revision, before.revision + 1);
    assert.equal(created.store.auditLogs[0].action, "Created location");
    assert.equal(created.store.auditLogs[0].entity, "new-store");
    assert.deepEqual(
      (await listLocations(db, token)).branches
        .map((branch) => branch.id)
        .sort(),
      ["local", "new-store"],
    );
    assert.deepEqual(
      (await listLocations(db, cashierToken)).branches.map(
        (branch) => branch.id,
      ),
      ["local"],
    );
    await assert.rejects(
      createLocation(db, token, {
        ...request,
        command: { ...request.command, name: "Conflicting retry" },
      }),
      /identifier/,
    );
    await assert.rejects(
      createLocation(db, token, {
        ...request,
        operationId: crypto.randomUUID(),
        command: { ...request.command, id: "another-store" },
      }),
      /updated this branch/,
    );
    await assert.rejects(
      createLocation(db, token, {
        ...request,
        revision: created.revision,
        operationId: crypto.randomUUID(),
      }),
      /already in use/,
    );
    await assert.rejects(
      createLocation(db, token, {
        ...request,
        revision: created.revision,
        operationId: crypto.randomUUID(),
        command: {
          ...request.command,
          id: "invalid code",
          timezone: "Invalid/Zone",
        },
      }),
      /location code/,
    );
    assert.deepEqual(await readSnapshot(db, token), created);
    await changeBranch(db, token, "new-store");
    const fresh = await readSnapshot(db, token);
    assert.equal(fresh.branch.name, "New Store");
    assert.equal(fresh.branch.timezone, "Asia/Singapore");
    assert.equal(fresh.user.role, "ADMIN");
    assert.equal(venueSettings(fresh.store).setupCompleted, false);
    assert.equal(fresh.revision, 0);
    assert.deepEqual(fresh.store.tables, []);
    assert.deepEqual(fresh.store.days, []);
    await assert.rejects(
      mutate(db, token, {
        branchId: "new-store",
        revision: 0,
        operationId: crypto.randomUUID(),
        command: { kind: "OPEN_DAY", date: "2026-10-21", openingCash: 0 },
      }),
      /setup/i,
    );
    await assert.rejects(
      createLocation(db, token, {
        ...request,
        revision: created.revision,
        operationId: crypto.randomUUID(),
      }),
      /branch changed/,
    );
    await assert.rejects(changeBranch(db, cashierToken, "new-store"), /access/);
    await assert.rejects(changeBranch(db, token, "other"), /access/);
    await changeBranch(db, token, "local");
    assert.deepEqual(await readSnapshot(db, token), created);
  } finally {
    await engine.close();
  }
});
