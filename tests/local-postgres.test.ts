import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { randomBytes } from "node:crypto";
import type { Database, SqlConnection } from "../src/server/database";
import { hashPassword, login, logout } from "../src/server/auth";
import { readStore } from "../src/server/storage";
import {
  assertNativeResource,
  assertNativeSecrets,
  initializeNativeSamples,
  nativeLocalIdentity,
  verifyNativeSamples,
  LOCAL_RUNTIME_LABEL,
  LOCAL_SAMPLE_PASSWORD,
  NATIVE_APP,
  NATIVE_SCHEMA,
  type NativeLocalSecrets,
} from "../scripts/local-postgres-setup";

function secrets(): NativeLocalSecrets {
  return {
    version: 1,
    workspace: "123456789abc",
    bootstrapPassword: randomBytes(32).toString("hex"),
    ownerPassword: randomBytes(32).toString("hex"),
    appPassword: randomBytes(32).toString("hex"),
  };
}

async function fixture() {
  const engine = await PGlite.create();
  const adapt = (connection: Pick<PGlite, "query">): SqlConnection => ({
    async query<T>(sql: string, values?: unknown[]) {
      return { rows: (await connection.query<T>(sql, values)).rows };
    },
  });
  const db: Database = {
    ...adapt(engine),
    transaction: (work) =>
      engine.transaction((tx) => work(adapt(tx as unknown as PGlite))),
  };
  return { db, engine };
}
const time = new Date("2026-10-29T15:00:00Z");

test("native resource identity and private configuration prevent unrelated Docker/data reuse", () => {
  const identity = nativeLocalIdentity(process.cwd());
  assert.match(identity.workspace, /^[a-f0-9]{12}$/);
  assert.equal(identity.container, `poker-native-local-${identity.workspace}`);
  const labels = {
    "com.poker.local.runtime": LOCAL_RUNTIME_LABEL,
    "com.poker.local.workspace": identity.workspace,
    "com.poker.local.resource": "data",
  };
  assertNativeResource({ Labels: labels }, identity.workspace, "data");
  for (const changed of [
    {},
    { ...labels, "com.poker.local.workspace": "other" },
    { ...labels, "com.poker.local.runtime": "another-app" },
    { ...labels, "com.poker.local.resource": "container" },
  ])
    assert.throws(
      () =>
        assertNativeResource({ Labels: changed }, identity.workspace, "data"),
      /preserved/,
    );
  const config = secrets();
  assertNativeSecrets(config, config.workspace);
  for (const changed of [
    null,
    {},
    { ...config, workspace: "other" },
    { ...config, appPassword: config.ownerPassword },
    { ...config, ownerPassword: "'; DROP ROLE anything;--" },
  ])
    assert.throws(() => assertNativeSecrets(changed, config.workspace));
});

test("native sample initialization uses genuine financial history, separate locations and restricted runtime permissions", async () => {
  const { db, engine } = await fixture();
  try {
    const result = await initializeNativeSamples(
      db,
      secrets(),
      time,
      "postgres",
    );
    assert.equal(result.created, true);
    assert.equal(result.users.length, 4);
    await db.query(`SET ROLE ${NATIVE_APP}`);
    await db.query(`SET search_path TO ${NATIVE_SCHEMA},pg_catalog`);
    const report = await verifyNativeSamples(db);
    assert.equal(report.venueCount, 2);
    assert.equal(report.counts.profiles, 16);
    assert.equal(report.counts.transactions, 86);
    for (const branch of ["local-sample", "local-second"]) {
      const store = await readStore(db, branch);
      assert.equal(store.settings?.smallBlind, 500);
      assert.equal(store.settings?.bigBlind, 1_000);
      assert.equal(store.settings?.minBuyIn, 20_000);
      assert.equal(store.settings?.maxBuyIn, 500_000);
      assert.equal(store.settings?.buyInStep, 5_000);
      const reserve = store.tables.find((table) =>
        table.name.endsWith("Reserve"),
      );
      assert.ok(reserve);
      assert.equal(reserve.smallBlind, 1_000);
      assert.equal(reserve.bigBlind, 2_500);
      assert.equal(reserve.minBuyIn, 50_000);
      assert.equal(reserve.maxBuyIn, 1_000_000);
      assert.equal(reserve.buyInStep, 5_000);
    }
    assert.ok(report.counts.approvals > 86);
    assert.equal(
      (
        await db.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM poker_memberships",
        )
      ).rows[0].count,
      "8",
    );
    assert.equal(
      (
        await db.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM poker_ledger WHERE branch_id='local-second'",
        )
      ).rows[0].count,
      "0",
    );
    for (const account of result.users) {
      const token = await login(db, account.username, LOCAL_SAMPLE_PASSWORD);
      await logout(db, token);
    }
    for (const sql of [
      "CREATE TABLE forbidden(id integer)",
      "CREATE TABLE public.forbidden(id integer)",
      "UPDATE poker_ledger SET branch_id=branch_id WHERE false",
      "DELETE FROM poker_audit WHERE false",
      "DELETE FROM poker_operations WHERE false",
      "DELETE FROM poker_schema_migrations WHERE false",
    ])
      await assert.rejects(db.query(sql), (error: unknown) =>
        Boolean(
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "42501",
        ),
      );
  } finally {
    await engine.close();
  }
});

test("restarting the native sample setup preserves edited profiles, passwords and existing financial history", async () => {
  const { db, engine } = await fixture();
  try {
    const config = secrets();
    await initializeNativeSamples(db, config, time, "postgres");
    await db.query(`SET search_path TO ${NATIVE_SCHEMA},pg_catalog`);
    const profile = (
      await db.query<{ id: string }>(
        "SELECT id FROM poker_profiles WHERE branch_id='local-sample' ORDER BY id LIMIT 1",
      )
    ).rows[0];
    await db.query(
      "UPDATE poker_profiles SET data=jsonb_set(data,'{name}',to_jsonb($1::text)) WHERE branch_id='local-sample' AND id=$2",
      ["Edited sample player", profile.id],
    );
    const changedPassword = "changed-local-test-password";
    const passwordHash = await hashPassword(changedPassword);
    await db.query(
      "UPDATE poker_users SET password_hash=$1 WHERE username='local.cashier'",
      [passwordHash],
    );
    const before = await verifyNativeSamples(db);
    await db.query("SET search_path TO public,pg_catalog");
    const result = await initializeNativeSamples(
      db,
      config,
      new Date("2026-11-01T15:00:00Z"),
      "postgres",
    );
    assert.equal(result.created, false);
    await db.query(`SET search_path TO ${NATIVE_SCHEMA},pg_catalog`);
    assert.equal(
      (
        await db.query<{ name: string }>(
          "SELECT data->>'name' AS name FROM poker_profiles WHERE branch_id='local-sample' AND id=$1",
          [profile.id],
        )
      ).rows[0].name,
      "Edited sample player",
    );
    assert.equal(
      (
        await db.query<{ password_hash: string }>(
          "SELECT password_hash FROM poker_users WHERE username='local.cashier'",
        )
      ).rows[0].password_hash,
      passwordHash,
    );
    assert.deepEqual((await verifyNativeSamples(db)).counts, before.counts);
    const token = await login(db, "local.cashier", changedPassword);
    await logout(db, token);
  } finally {
    await engine.close();
  }
});

test("native setup refuses unowned schemas and mismatched targets without creating sample records", async () => {
  const { db, engine } = await fixture();
  try {
    await assert.rejects(
      initializeNativeSamples(db, secrets(), time, "wrong_database"),
      /exact PostgreSQL/,
    );
    await db.query(`CREATE SCHEMA ${NATIVE_SCHEMA}`);
    await assert.rejects(
      initializeNativeSamples(db, secrets(), time, "postgres"),
      /not this launcher's/,
    );
    assert.equal(
      (
        await db.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM pg_roles WHERE rolname IN ('poker_local_owner','poker_local_app')",
        )
      ).rows[0].count,
      "0",
    );
  } finally {
    await engine.close();
  }
});

test("a failed native setup rolls back roles, schema and sample history before a safe retry", async () => {
  const { db, engine } = await fixture();
  try {
    const failing: Database = {
      ...db,
      transaction: (work) =>
        db.transaction((connection) =>
          work({
            query: async <T>(sql: string, values?: unknown[]) => {
              if (
                sql.startsWith(
                  "CREATE TABLE IF NOT EXISTS poker_schema_migrations",
                )
              )
                throw new Error("synthetic native setup failure");
              return connection.query<T>(sql, values);
            },
          }),
        ),
    };
    await assert.rejects(
      initializeNativeSamples(failing, secrets(), time, "postgres"),
      /synthetic native setup failure/,
    );
    assert.equal(
      (
        await db.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM pg_roles WHERE rolname IN ('poker_local_owner','poker_local_app')",
        )
      ).rows[0].count,
      "0",
    );
    assert.equal(
      (
        await db.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM pg_namespace WHERE nspname=$1",
          [NATIVE_SCHEMA],
        )
      ).rows[0].count,
      "0",
    );
    assert.equal(
      (await initializeNativeSamples(db, secrets(), time, "postgres")).created,
      true,
    );
  } finally {
    await engine.close();
  }
});
