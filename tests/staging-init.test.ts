import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import {
  stagingTarget,
  StagingSetupError,
  type StagingInput,
} from "../scripts/staging-target";
import {
  createStagingSecrets,
  initializeStaging,
} from "../scripts/staging-init";
import type { Database, SqlConnection } from "../src/server/database";
import { verifyDatabaseIntegrity } from "../src/server/integrity";
import { login, requireUser } from "../src/server/auth";

function input(patch: Partial<StagingInput> = {}): StagingInput {
  return {
    databaseUrl: `postgresql://bootstrap:${"a".repeat(64)}@staging.example.invalid/postgres?sslmode=verify-full`,
    expectedHost: "staging.example.invalid",
    expectedDatabase: "postgres",
    schema: "poker_staging",
    confirmation: "staging.example.invalid/postgres/poker_staging",
    ...patch,
  };
}
async function fixture(restrictedBootstrap = false) {
  const engine = await PGlite.create();
  const adapt = (client: Pick<PGlite, "query">): SqlConnection => ({
    query: async <T>(sql: string, values?: unknown[]) => ({
      rows: (await client.query<T>(sql, values)).rows,
    }),
  });
  const db: Database = {
    ...adapt(engine),
    transaction: (work) =>
      engine.transaction((tx) => work(adapt(tx as unknown as PGlite))),
  };
  if (restrictedBootstrap) {
    await db.query(
      "CREATE ROLE staging_bootstrap LOGIN CREATEROLE CREATEDB NOSUPERUSER",
    );
    await db.query("ALTER DATABASE postgres OWNER TO staging_bootstrap");
    await db.query("SET SESSION AUTHORIZATION staging_bootstrap");
  }
  return { engine, db };
}

test("staging target requires independent exact confirmation and refuses unsafe or prototype connections without leaking secrets", () => {
  const good = stagingTarget(input());
  assert.equal(good.app, "poker_staging_app");
  for (const patch of [
    { databaseUrl: undefined },
    { expectedHost: undefined },
    { expectedDatabase: "other" },
    { confirmation: undefined },
    { confirmation: "staging.example.invalid/postgres/public" },
    { schema: 'poker_staging"; DROP SCHEMA public' },
    {
      databaseUrl: input().databaseUrl!.replace(
        "staging.example.invalid",
        "localhost",
      ),
      expectedHost: "localhost",
      confirmation: "localhost/postgres/poker_staging",
    },
    { databaseUrl: input().databaseUrl!.replace("verify-full", "require") },
    { databaseUrl: input().databaseUrl! + "&options=-csearch_path=public" },
    { databaseUrl: input().databaseUrl! + "&channel_binding=require" },
  ]) {
    assert.throws(
      () => stagingTarget(input(patch)),
      (error: unknown) =>
        error instanceof StagingSetupError &&
        !error.message.includes("a".repeat(64)),
    );
  }
  for (const environment of [
    { POKER_PROTOTYPE_MODE: "1" },
    { NEXT_PUBLIC_POKER_PROTOTYPE: "1" },
    { NODE_TLS_REJECT_UNAUTHORIZED: "0" },
    { PGOPTIONS: "-c search_path=public" },
  ])
    assert.throws(() => stagingTarget(input(), environment), StagingSetupError);
  assert.throws(
    () =>
      stagingTarget(input({ databaseUrl: undefined }), {
        DATABASE_URL: input().databaseUrl,
      }),
    /STAGING_DATABASE_URL/,
  );
});

test("an unsupported PostgreSQL version is rejected after read-only identity detection", async () => {
  const statements: string[] = [];
  const connection: SqlConnection = {
    query: async <T>(sql: string) => {
      statements.push(sql);
      return {
        rows: [
          { database: "postgres", version: "160015", principal: "bootstrap" },
        ] as T[],
      };
    },
  };
  const db: Database = {
    ...connection,
    transaction: (work) => work(connection),
  };
  await assert.rejects(
    initializeStaging(db, input(), createStagingSecrets()),
    (error: unknown) =>
      error instanceof StagingSetupError &&
      error.code === "UNSUPPORTED_POSTGRES",
  );
  assert.equal(statements.length, 1);
  assert.match(statements[0], /^SELECT current_database/);
});

test("fresh staging initialization migrates, provisions fictional users, preserves setup review and restricts the application role", async () => {
  const { engine, db } = await fixture(true);
  try {
    const secrets = createStagingSecrets();
    const report = await initializeStaging(db, input(), secrets);
    assert.equal(report.branches, 2);
    assert.equal(report.staffAccounts, 4); // Three sign-ins and a disabled audit anchor.
    assert.equal(report.transactions, 0);
    assert.equal(report.players, 0);
    assert.equal(report.setupCompleted, false);
    assert.equal(
      (
        await db.query<{ superuser: boolean }>(
          "SELECT rolsuper AS superuser FROM pg_roles WHERE rolname=current_user",
        )
      ).rows[0].superuser,
      false,
    );
    assert.equal(
      (
        await db.query<{ can_set: boolean }>(
          "SELECT pg_has_role(current_user,'poker_staging_owner','SET') AS can_set",
        )
      ).rows[0].can_set,
      false,
    );
    assert.equal(
      (
        await db.query<{ can_set: boolean }>(
          "SELECT pg_has_role(current_user,'poker_staging_app','SET') AS can_set",
        )
      ).rows[0].can_set,
      false,
    );
    assert.equal(JSON.stringify(report).includes(secrets.app), false);
    // Embedded engine has one connection. Its bootstrap administrator selects
    // the app identity for permission checks; this grants nothing to the app.
    await db.query(
      "GRANT poker_staging_app TO staging_bootstrap WITH SET TRUE, INHERIT FALSE",
    );
    await db.query("SET ROLE poker_staging_app");
    await db.query("SET search_path TO poker_staging,pg_catalog");
    const verified = await verifyDatabaseIntegrity(db);
    assert.equal(verified.venueCount, 2);
    assert.equal(verified.counts.transactions, 0);
    const states = (
      await db.query<{ setup: boolean }>(
        "SELECT (data->'settings'->>'setupCompleted')::boolean AS setup FROM poker_branch_state",
      )
    ).rows;
    // Indexed metadata carries settings; no day or financial activity was invented.
    assert.equal(states.length, 2);
    assert.ok(states.every((state) => state.setup === false));
    const token = await login(
      db,
      "staging.admin",
      secrets.staff["staging.admin"],
    );
    const user = await requireUser(db, token);
    assert.equal(user.username, "staging.admin");
    for (const sql of [
      "CREATE TABLE should_fail(id integer)",
      "CREATE TABLE public.should_fail(id integer)",
      "INSERT INTO poker_schema_migrations(version,name,checksum) VALUES(100,'forbidden',repeat('a',64))",
      "UPDATE poker_ledger SET branch_id=branch_id WHERE false",
      "DELETE FROM poker_audit WHERE false",
      "DELETE FROM poker_operations WHERE false",
    ])
      await assert.rejects(
        db.query(sql),
        (error: unknown) =>
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "42501",
      );
    await db.query("RESET ROLE");
    await db.query("SET search_path TO public,pg_catalog");
    await assert.rejects(
      initializeStaging(db, input(), createStagingSecrets()),
      (error: unknown) =>
        error instanceof StagingSetupError && error.code === "TARGET_NOT_EMPTY",
    );
    await db.query("SET ROLE poker_staging_app");
    await db.query("SET search_path TO poker_staging,pg_catalog");
    assert.equal(
      (
        await db.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM poker_users",
        )
      ).rows[0].count,
      "4",
    );
  } finally {
    await engine.close();
  }
});

test("staging initialization refuses populated databases and connected identity mismatch before creating roles", async () => {
  const { engine, db } = await fixture(true);
  try {
    await db.query("CREATE TABLE unrelated_existing_record(id integer)");
    await assert.rejects(
      initializeStaging(db, input(), createStagingSecrets()),
      (error: unknown) =>
        error instanceof StagingSetupError && error.code === "TARGET_NOT_EMPTY",
    );
    await db.query("DROP TABLE unrelated_existing_record");
    const mismatch = input({
      databaseUrl: input().databaseUrl!.replace("/postgres?", "/neondb?"),
      expectedDatabase: "neondb",
      confirmation: "staging.example.invalid/neondb/poker_staging",
    });
    await assert.rejects(
      initializeStaging(db, mismatch, createStagingSecrets()),
      (error: unknown) =>
        error instanceof StagingSetupError &&
        error.code === "DATABASE_MISMATCH",
    );
    assert.equal(
      (
        await db.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM pg_roles WHERE rolname LIKE 'poker_staging%'",
        )
      ).rows[0].count,
      "0",
    );
  } finally {
    await engine.close();
  }
});

test("a schema failure rolls back newly created roles, schema and data without touching existing objects", async () => {
  const { engine, db } = await fixture();
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
                throw new Error("synthetic migration failure");
              return connection.query<T>(sql, values);
            },
          }),
        ),
    };
    await assert.rejects(
      initializeStaging(failing, input(), createStagingSecrets()),
      /synthetic migration failure/,
    );
    assert.equal(
      (
        await db.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM pg_namespace WHERE nspname='poker_staging'",
        )
      ).rows[0].count,
      "0",
    );
    assert.equal(
      (
        await db.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM pg_roles WHERE rolname LIKE 'poker_staging%'",
        )
      ).rows[0].count,
      "0",
    );
    await initializeStaging(db, input(), createStagingSecrets());
  } finally {
    await engine.close();
  }
});
