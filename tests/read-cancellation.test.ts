import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { DomainError } from "../src/domain/operations";
import { emptyStore } from "../src/domain/selectors";
import { hashPassword, login } from "../src/server/auth";
import type { Database } from "../src/server/database";
import { readPage } from "../src/server/queries";
import { importStore } from "../src/server/storage";
import { testDatabase } from "./helpers/database";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
let token: string;
let otherToken: string;
const query = { resource: "players", pageSize: 20 };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function cancelled(error: unknown) {
  assert.ok(error instanceof DomainError);
  assert.equal(error.status, 408);
  assert.equal(error.message, "Cannot load records.");
  return true;
}
async function flush() {
  for (let index = 0; index < 4; index++) await Promise.resolve();
}

before(async () => {
  fixture = await testDatabase();
  const password = "fictional-cancelled-read-password";
  const hash = await hashPassword(password);
  for (const [id, branchId, role] of [
    ["read-admin", "local", "ADMIN"],
    ["other-reader", "other", "CASHIER"],
  ]) {
    await fixture.db.query(
      "INSERT INTO poker_users(id,username,password_hash) VALUES($1,$1,$2)",
      [id, hash],
    );
    await fixture.db.query(
      "INSERT INTO poker_memberships(user_id,branch_id,role) VALUES($1,$2,$3)",
      [id, branchId, role],
    );
  }
  const store = emptyStore();
  for (let index = 0; index < 55; index++)
    store.profiles.push({
      id: `fictional-read-${index}`,
      name: `Fictional person ${index}`,
      phone: `+1202555${String(index).padStart(4, "0")}`,
      type: "CASH",
      creditLimit: 0,
      tags: [],
    });
  await importStore(fixture.db, "local", store);
  const other = emptyStore();
  other.profiles.push({
    id: "fictional-other-profile",
    name: "Other venue only",
    phone: "+12025559999",
    type: "CASH",
    creditLimit: 0,
    tags: [],
  });
  await importStore(fixture.db, "other", other);
  token = await login(fixture.db, "read-admin", password);
  otherToken = await login(fixture.db, "other-reader", password);
});
after(async () => {
  await fixture.engine.close();
});

test("pre-aborted record reads acquire no database transaction and never expose the abort reason", async () => {
  let acquisitions = 0;
  const unreachable: Database = {
    async query() {
      throw new Error("Unexpected direct query");
    },
    async transaction() {
      acquisitions++;
      throw new Error("Unexpected checkout");
    },
  };
  const abort = new AbortController();
  abort.abort(new Error("private client abort detail"));
  for (const resource of [
    "players",
    "requests",
    "transactions",
    "audit",
    "sessions",
    "player",
    "receipt",
    "report",
    "range",
  ])
    await assert.rejects(
      readPage(unreachable, token, { resource }, abort.signal),
      cancelled,
    );
  assert.equal(acquisitions, 0);
});

test("cancellation during queued checkout stops before application SQL and awaits transaction cleanup", async () => {
  const entered = deferred(),
    checkout = deferred(),
    cleaning = deferred(),
    cleanup = deferred();
  const abort = new AbortController();
  const statements: string[] = [];
  let settled = false;
  const held: Database = {
    ...fixture.db,
    async transaction(work) {
      entered.resolve();
      await checkout.promise;
      try {
        return await fixture.db.transaction((connection) =>
          work({
            async query<T>(sql: string, values?: unknown[]) {
              statements.push(sql);
              return connection.query<T>(sql, values);
            },
          }),
        );
      } catch (error) {
        cleaning.resolve();
        await cleanup.promise;
        throw error;
      }
    },
  };
  const operation = readPage(held, token, query, abort.signal);
  void operation.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  const rejected = assert.rejects(operation, cancelled);
  try {
    await entered.promise;
    abort.abort("private queued checkout abort");
    await flush();
    assert.equal(settled, false);
    checkout.resolve();
    await cleaning.promise;
    assert.deepEqual(statements, []);
    assert.equal(settled, false);
  } finally {
    checkout.resolve();
    cleanup.resolve();
  }
  await rejected;
  assert.equal((await readPage(fixture.db, token, query)).total, 55);
});

for (const [stage, marker] of [
  ["transaction setup", "SET TRANSACTION"],
  ["staff authentication", "FROM poker_sessions"],
  ["filtered count", "SELECT count(*)::text AS total FROM"],
  ["operational context", "SELECT s.revision,s.data,b.name,b.timezone"],
])
  test(`abort during ${stage} waits for real SQL and rollback before rejecting, then skips later queries`, async () => {
    const entered = deferred(),
      sqlReleased = deferred(),
      cleaning = deferred(),
      cleanup = deferred();
    const abort = new AbortController();
    const statements: string[] = [];
    let settled = false;
    const held: Database = {
      ...fixture.db,
      async transaction(work) {
        try {
          return await fixture.db.transaction((connection) =>
            work({
              async query<T>(sql: string, values?: unknown[]) {
                statements.push(sql);
                const result = await connection.query<T>(sql, values);
                if (sql.includes(marker)) {
                  entered.resolve();
                  await sqlReleased.promise;
                }
                return result;
              },
            }),
          );
        } catch (error) {
          cleaning.resolve();
          await cleanup.promise;
          throw error;
        }
      },
    };
    const operation = readPage(held, token, query, abort.signal);
    void operation.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    const rejected = assert.rejects(operation, cancelled);
    try {
      await entered.promise;
      const count = statements.length;
      abort.abort("private in-flight SQL abort");
      await flush();
      assert.equal(settled, false);
      sqlReleased.resolve();
      await cleaning.promise;
      assert.equal(
        statements.length,
        count,
        "No subsequent SQL may run after the aborted query settles",
      );
      assert.ok(statements.at(-1)?.includes(marker));
      assert.equal(
        settled,
        false,
        "Rollback/release must settle before the read rejects",
      );
    } finally {
      sqlReleased.resolve();
      cleanup.resolve();
    }
    await rejected;
    assert.equal((await readPage(fixture.db, token, query)).total, 55);
  });

for (const cancel of [false, true])
  test(`record reads await complete transaction finalization${cancel ? " and reject a late abort before success" : " before returning success"}`, async () => {
    const finalizing = deferred(),
      released = deferred(),
      abort = new AbortController();
    let settled = false;
    const held: Database = {
      ...fixture.db,
      async transaction(work) {
        const value = await fixture.db.transaction(work);
        finalizing.resolve();
        await released.promise;
        return value;
      },
    };
    const operation = readPage(held, token, query, abort.signal);
    void operation.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    const result = cancel ? assert.rejects(operation, cancelled) : operation;
    try {
      await finalizing.promise;
      if (cancel) abort.abort("private finalization abort");
      await flush();
      assert.equal(settled, false);
    } finally {
      released.resolve();
    }
    const value = await result;
    if (!cancel)
      assert.equal((value as Awaited<ReturnType<typeof readPage>>).total, 55);
  });

test("ordinary reads preserve pagination, complete counts, branch isolation and role/auth checks", async () => {
  const signal = new AbortController().signal;
  const first = await readPage(
    fixture.db,
    token,
    { resource: "players", pageSize: 50 },
    signal,
  );
  assert.equal(first.total, 55);
  assert.equal(first.items.length, 50);
  assert.equal(first.pageSize, 50);
  assert.equal(first.branchId, "local");
  const last = await readPage(
    fixture.db,
    token,
    { resource: "players", pageSize: 50, page: 1 },
    signal,
  );
  assert.equal(last.items.length, 5);
  assert.equal(last.total, first.total);
  assert.equal(
    (
      await readPage(
        fixture.db,
        token,
        { resource: "players", query: "Other venue only" },
        signal,
      )
    ).total,
    0,
  );
  const other = await readPage(fixture.db, otherToken, query, signal);
  assert.equal(other.branchId, "other");
  assert.equal(other.total, 1);
  assert.equal(other.context.user.id, "other-reader");
  for (const [targetToken, input, status] of [
    [otherToken, { resource: "audit" }, 403],
    ["0".repeat(64), query, 401],
    [token, { resource: "players", pageSize: 51 }, 400],
  ] as const)
    await assert.rejects(
      readPage(fixture.db, targetToken, input, signal),
      (error) => error instanceof DomainError && error.status === status,
    );
  assert.deepEqual(
    await readPage(fixture.db, token, query, signal),
    await readPage(fixture.db, token, query),
  );
});
