import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import type { Database, SqlConnection } from "../src/server/database";
import { migrate } from "../src/server/schema";
import {
  hashPassword,
  login,
  logout,
  sessionUser,
  changeBranch,
} from "../src/server/auth";
import { readSnapshot, mutate } from "../src/server/repository";
import { configuredStore } from "./helpers/store";
import type { Command } from "../src/domain/commands";
import { verifyOrigin } from "../src/server/http";
import { DomainError } from "../src/domain/operations";
import { testDatabase } from "./helpers/database";
import { importStore, readStore } from "../src/server/storage";
const engine = new PGlite();
const adapt = (connection: Pick<PGlite, "query">): SqlConnection => ({
  async query<T>(sql: string, values?: unknown[]) {
    const result = await connection.query<T>(sql, values);
    return { rows: result.rows };
  },
});
const db: Database = {
  ...adapt(engine),
  transaction: (work) =>
    engine.transaction((tx) => work(adapt(tx as unknown as PGlite))),
};
let token = "";
before(async () => {
  await migrate(db);
  for (const branch of ["kl", "penang"]) {
    await db.query(
      "INSERT INTO poker_branches(id,name,timezone) VALUES($1,$2,$3)",
      [branch, branch, "Asia/Kuala_Lumpur"],
    );
    await importStore(db, branch, configuredStore());
  }
  await db.query(
    "INSERT INTO poker_users(id,username,password_hash) VALUES($1,$2,$3)",
    ["admin", "admin", await hashPassword("test-password-only")],
  );
  await db.query(
    "INSERT INTO poker_memberships(user_id,branch_id,role) VALUES($1,$2,$3)",
    ["admin", "kl", "ADMIN"],
  );
  token = await login(db, "admin", "test-password-only");
});
after(async () => {
  await engine.close();
});
function payload(
  command: Command,
  revision: number,
  operationId = crypto.randomUUID(),
  branchId = "kl",
) {
  return { branchId, command, revision, operationId };
}

test("forged session values and wrong passwords do not authenticate", async () => {
  assert.equal(await sessionUser(db, "arbitrary"), null);
  assert.equal(await sessionUser(db, "a".repeat(64)), null);
  await assert.rejects(login(db, "admin", "wrong-password"), /Invalid/);
  await assert.rejects(readSnapshot(db, "arbitrary"), /expired/);
  assert.equal((await sessionUser(db, token))?.role, "ADMIN");
});

test("a same-venue account change rejects the previous actor's draft without posting", async () => {
  const isolated = await testDatabase();
  try {
    const password = "actor-precondition-test-password";
    const hash = await hashPassword(password);
    for (const id of ["previous-operator", "current-operator"]) {
      await isolated.db.query(
        "INSERT INTO poker_users(id,username,password_hash) VALUES($1,$1,$2)",
        [id, hash],
      );
      await isolated.db.query(
        "INSERT INTO poker_memberships(user_id,branch_id,role) VALUES($1,'local','ADMIN')",
        [id],
      );
    }
    const currentToken = await login(isolated.db, "current-operator", password);
    const before = await readSnapshot(isolated.db, currentToken);
    const input = {
      branchId: before.branch.id,
      actorId: "previous-operator",
      revision: before.revision,
      operationId: crypto.randomUUID(),
      command: {
        kind: "TABLE",
        name: "Counter table",
        dealer: "",
        status: "OPEN",
      },
    };
    await assert.rejects(mutate(isolated.db, currentToken, input), (error) => {
      assert.ok(error instanceof DomainError);
      assert.equal(error.status, 409);
      assert.match(error.message, /account changed/);
      return true;
    });
    assert.deepEqual(await readSnapshot(isolated.db, currentToken), before);
    assert.equal(
      (
        await isolated.db.query(
          "SELECT operation_id FROM poker_operations WHERE operation_id=$1",
          [input.operationId],
        )
      ).rows.length,
      0,
    );
    const matching = { ...input, actorId: before.user.id };
    await assert.rejects(mutate(isolated.db, undefined, matching), /expired/);
    const saved = await mutate(isolated.db, currentToken, matching);
    assert.equal(saved.revision, before.revision + 1);
    assert.equal(saved.store.tables.length, 1);
    assert.equal(saved.store.auditLogs[0].actorId, before.user.id);
    assert.deepEqual(await mutate(isolated.db, currentToken, matching), saved);
  } finally {
    await isolated.engine.close();
  }
});
test("database mutations persist and retries do not duplicate entries", async () => {
  const data = payload(
    { kind: "OPEN_DAY", date: "2026-09-30", openingCash: 50000 },
    0,
  );
  const first = await mutate(db, token, data);
  const retry = await mutate(db, token, data);
  assert.equal(first.revision, 1);
  assert.equal(retry.revision, 1);
  assert.equal((await readSnapshot(db, token)).store.days.length, 1);
  await assert.rejects(
    mutate(db, token, {
      ...data,
      command: { ...data.command, openingCash: 0 },
    }),
    /identifier/,
  );
});
test("stale writes and invalid actions leave data unchanged", async () => {
  await assert.rejects(
    mutate(
      db,
      token,
      payload({ kind: "TABLE", name: "T1", dealer: "", status: "OPEN" }, 0),
    ),
    /updated this branch/,
  );
  const before = await readSnapshot(db, token);
  await assert.rejects(
    mutate(
      db,
      token,
      payload(
        { kind: "CLOSE_DAY", countedCash: 0, reason: "" },
        before.revision,
      ),
    ),
    /Explain/,
  );
  assert.deepEqual(await readSnapshot(db, token), before);
});
test("two concurrent writers editing the same table cannot overwrite one another", async () => {
  const prior = await readSnapshot(db, token);
  const created = await mutate(
    db,
    token,
    payload(
      { kind: "TABLE", name: "Shared table", dealer: "", status: "OPEN" },
      prior.revision,
    ),
  );
  const tableId = created.store.tables[0].id;
  const revision = (await readSnapshot(db, token)).revision;
  const result = await Promise.allSettled(
    ["T1", "T2"].map((name) =>
      mutate(
        db,
        token,
        payload(
          { kind: "TABLE", tableId, name, dealer: "", status: "OPEN" },
          revision,
        ),
      ),
    ),
  );
  assert.equal(result.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal((await readSnapshot(db, token)).store.tables.length, 1);
});

test("two concurrent writers creating unrelated tables both save from the same revision", async () => {
  const before = await readSnapshot(db, token);
  const result = await Promise.allSettled(
    ["Independent one", "Independent two"].map((name) =>
      mutate(
        db,
        token,
        payload(
          { kind: "TABLE", name, dealer: "", status: "OPEN" },
          before.revision,
        ),
      ),
    ),
  );
  assert.equal(result.filter((item) => item.status === "fulfilled").length, 2);
  const saved = await readSnapshot(db, token);
  assert.equal(saved.revision, before.revision + 2);
  assert.equal(saved.store.tables.length, before.store.tables.length + 2);
});
test("branch isolation is enforced, including a stale tab's explicit branch", async () => {
  await assert.rejects(changeBranch(db, token, "penang"), /access/);
  await assert.rejects(
    mutate(
      db,
      token,
      payload(
        { kind: "OPEN_DAY", date: "2026-10-01", openingCash: 0 },
        0,
        crypto.randomUUID(),
        "penang",
      ),
    ),
    /branch changed/,
  );
  const other = { data: await readStore(db, "penang") };
  assert.equal(other.data.days.length, 0);
});
test("origin checks reject cross-site and non-JSON writes", () => {
  assert.throws(
    () =>
      verifyOrigin(
        new Request("https://poker.test/api/state", {
          headers: {
            origin: "https://other.test",
            "content-type": "application/json",
          },
        }),
      ),
    /origin/,
  );
  assert.throws(
    () =>
      verifyOrigin(
        new Request("https://poker.test/api/state", {
          headers: {
            origin: "https://poker.test",
            "content-type": "text/plain",
          },
        }),
      ),
    /JSON/,
  );
});
test("login throttling survives requests and expired/revoked sessions fail", async () => {
  for (let i = 0; i < 10; i++)
    await assert.rejects(login(db, "unknown", "bad"));
  await assert.rejects(login(db, "unknown", "bad"), /Too many/);
  const temporary = await login(db, "admin", "test-password-only");
  await logout(db, temporary);
  assert.equal(await sessionUser(db, temporary), null);
  await db.query(
    "UPDATE poker_sessions SET expires_at=now()-interval '1 second'",
  );
  assert.equal(await sessionUser(db, token), null);
});
