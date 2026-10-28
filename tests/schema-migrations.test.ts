import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { Database, SqlConnection } from "../src/server/database";
import { migrate, schema, schemaMigrationStatus } from "../src/server/schema";
import { configuredStore } from "./helpers/store";
import { importStore, readStore } from "../src/server/storage";

async function isolatedDatabase() {
  const engine = await PGlite.create();
  const adapt = (connection: Pick<PGlite, "query">): SqlConnection => ({
    async query<T>(sql: string, values?: unknown[]) {
      return { rows: (await connection.query<T>(sql, values)).rows };
    },
  });
  const db: Database = {
    ...adapt(engine),
    transaction: (work) =>
      engine.transaction((connection) =>
        work(adapt(connection as unknown as PGlite)),
      ),
  };
  return { db, engine };
}

async function legacyRecords(db: Database, indexed = true) {
  await db.query(
    "INSERT INTO poker_branches(id,name,timezone) VALUES('legacy','Existing venue','Asia/Kuala_Lumpur')",
  );
  if (indexed) await importStore(db, "legacy", configuredStore(), 7);
  else
    await db.query(
      "INSERT INTO poker_branch_state(branch_id,revision,data) VALUES('legacy',7,$1)",
      [JSON.stringify(configuredStore())],
    );
  await db.query(
    "INSERT INTO poker_users(id,username,password_hash) VALUES('owner','existing.owner','existing-password-hash')",
  );
  await db.query(
    "INSERT INTO poker_memberships(user_id,branch_id,role) VALUES('owner','legacy','ADMIN')",
  );
  await db.query(
    "INSERT INTO poker_operations(branch_id,operation_id,actor_id,fingerprint,revision) VALUES('legacy','existing-operation','owner','existing-fingerprint',7)",
  );
}

async function records(db: Database) {
  return Promise.all(
    [
      "SELECT * FROM poker_branches ORDER BY id",
      "SELECT * FROM poker_branch_state ORDER BY branch_id",
      "SELECT * FROM poker_users ORDER BY id",
      "SELECT * FROM poker_memberships ORDER BY user_id,branch_id",
      "SELECT * FROM poker_operations ORDER BY branch_id,operation_id",
    ].map(async (sql) => {
      const result = (await db.query(sql)).rows;
      if (sql.includes("FROM poker_operations"))
        return result.map((row) => ({
          ...row,
          result_context: row.result_context ?? {},
        }));
      if (!sql.includes("FROM poker_branch_state")) return result;
      return Promise.all(
        result.map(async (value) => {
          const row = value as {
            branch_id: string;
            data: { storageVersion?: number };
            current_day_id?: string | null;
          };
          const { current_day_id: _, ...stored } = row;
          void _;
          return row.data.storageVersion === 2
            ? { ...stored, data: await readStore(db, row.branch_id) }
            : row;
        }),
      );
    }),
  );
}

test("a fresh install records its baseline version checksum and application time", async () => {
  const { db, engine } = await isolatedDatabase();
  try {
    assert.deepEqual(await schemaMigrationStatus(db), {
      ready: false,
      appliedVersion: 0,
      expectedVersion: 3,
    });
    await migrate(db);
    const history = await db.query<{
      version: number;
      name: string;
      checksum: string;
      applied_at: Date;
    }>("SELECT * FROM poker_schema_migrations ORDER BY version");
    assert.equal(history.rows.length, 3);
    assert.equal(history.rows[0].version, 1);
    assert.equal(history.rows[0].name, "initial_schema");
    assert.equal(
      history.rows[0].checksum,
      createHash("sha256").update(schema).digest("hex"),
    );
    assert.ok(Number.isFinite(new Date(history.rows[0].applied_at).getTime()));
    assert.deepEqual(await schemaMigrationStatus(db), {
      ready: true,
      appliedVersion: 3,
      expectedVersion: 3,
    });
    await legacyRecords(db);
  } finally {
    await engine.close();
  }
});

test("repeated migrations preserve business records and the original ledger timestamp", async () => {
  const { db, engine } = await isolatedDatabase();
  try {
    await migrate(db);
    await legacyRecords(db);
    const original = await records(db);
    const history = await db.query("SELECT * FROM poker_schema_migrations");
    await migrate(db);
    await migrate(db);
    assert.deepEqual(await records(db), original);
    assert.deepEqual(
      (await db.query("SELECT * FROM poker_schema_migrations")).rows,
      history.rows,
    );
  } finally {
    await engine.close();
  }
});

test("existing unversioned tables adopt the baseline without resetting any records", async () => {
  const { db, engine } = await isolatedDatabase();
  try {
    await engine.exec(schema);
    await legacyRecords(db, false);
    const original = await records(db);
    assert.equal((await schemaMigrationStatus(db)).ready, false);
    await migrate(db);
    assert.deepEqual(await records(db), original);
    assert.equal((await schemaMigrationStatus(db)).ready, true);
    assert.equal(
      (await db.query("SELECT version FROM poker_schema_migrations")).rows
        .length,
      3,
    );
  } finally {
    await engine.close();
  }
});

test("failed migration recording rolls back both new DDL and the ledger", async () => {
  const { db, engine } = await isolatedDatabase();
  try {
    const faulty: Database = {
      ...db,
      transaction: (work) =>
        db.transaction((connection) =>
          work({
            async query<T>(sql: string, values?: unknown[]) {
              if (sql.startsWith("INSERT INTO poker_schema_migrations"))
                throw new Error("Simulated migration ledger write failure");
              return connection.query<T>(sql, values);
            },
          }),
        ),
    };
    await assert.rejects(migrate(faulty), /Simulated migration ledger/);
    const tables = await db.query<{
      ledger: string | null;
      business: string | null;
    }>(
      "SELECT to_regclass('poker_schema_migrations')::text AS ledger,to_regclass('poker_branches')::text AS business",
    );
    assert.deepEqual(tables.rows[0], { ledger: null, business: null });
    await migrate(db);
    assert.equal((await schemaMigrationStatus(db)).ready, true);
  } finally {
    await engine.close();
  }
});

test("failed baseline adoption preserves legacy data and records no completed migration", async () => {
  const { db, engine } = await isolatedDatabase();
  try {
    await db.query("CREATE TABLE poker_branches(id text PRIMARY KEY)");
    await db.query("INSERT INTO poker_branches(id) VALUES('must-survive')");
    await assert.rejects(migrate(db), /column .*name.*does not exist/i);
    assert.deepEqual((await db.query("SELECT * FROM poker_branches")).rows, [
      { id: "must-survive" },
    ]);
    assert.equal((await schemaMigrationStatus(db)).ready, false);
    assert.equal(
      (await db.query("SELECT to_regclass('poker_users') AS relation")).rows[0]
        .relation,
      null,
    );
  } finally {
    await engine.close();
  }
});

test("unknown future migration versions are rejected without changing business data", async () => {
  const { db, engine } = await isolatedDatabase();
  try {
    await migrate(db);
    await legacyRecords(db);
    const original = await records(db);
    await db.query(
      "INSERT INTO poker_schema_migrations(version,name,checksum) VALUES(99,'future_release',$1)",
      ["0".repeat(64)],
    );
    await assert.rejects(migrate(db), /unknown or out-of-order version/);
    await assert.rejects(schemaMigrationStatus(db), /unknown or out-of-order/);
    assert.deepEqual(await records(db), original);
    assert.equal(
      (await db.query("SELECT version FROM poker_schema_migrations")).rows
        .length,
      4,
    );
  } finally {
    await engine.close();
  }
});

test("migration checksum drift fails closed and does not repair recorded history", async () => {
  const { db, engine } = await isolatedDatabase();
  try {
    await migrate(db);
    await legacyRecords(db);
    const original = await records(db);
    await db.query("UPDATE poker_schema_migrations SET checksum=$1", [
      "0".repeat(64),
    ]);
    await assert.rejects(migrate(db), /migration checksum/);
    await assert.rejects(schemaMigrationStatus(db), /migration checksum/);
    assert.deepEqual(await records(db), original);
    assert.equal(
      (
        await db.query<{ checksum: string }>(
          "SELECT checksum FROM poker_schema_migrations",
        )
      ).rows[0].checksum,
      "0".repeat(64),
    );
  } finally {
    await engine.close();
  }
});

test("a changed migration name or non-prefix history cannot be silently adopted", async () => {
  const { db, engine } = await isolatedDatabase();
  try {
    await migrate(db);
    await db.query(
      "UPDATE poker_schema_migrations SET name='renamed_baseline'",
    );
    await assert.rejects(migrate(db), /migration name/);
    await assert.rejects(schemaMigrationStatus(db), /migration name/);
    await db.query(
      "UPDATE poker_schema_migrations SET version=98,name='future_baseline' WHERE version=1",
    );
    await assert.rejects(migrate(db), /unknown or out-of-order/);
  } finally {
    await engine.close();
  }
});

test("the migration advisory lock precedes ledger bootstrap and repeated callers are idempotent", async () => {
  const { db, engine } = await isolatedDatabase();
  try {
    const calls: string[] = [];
    const traced: Database = {
      ...db,
      transaction: (work) =>
        db.transaction((connection) =>
          work({
            async query<T>(sql: string, values?: unknown[]) {
              calls.push(sql);
              return connection.query<T>(sql, values);
            },
          }),
        ),
    };
    await Promise.all([migrate(traced), migrate(traced)]);
    assert.equal(calls[0], "SELECT pg_advisory_xact_lock(1886350181, 1)");
    assert.ok(
      calls[1].startsWith("CREATE TABLE IF NOT EXISTS poker_schema_migrations"),
    );
    assert.equal(
      calls.filter((sql) =>
        sql.startsWith("INSERT INTO poker_schema_migrations"),
      ).length,
      3,
    );
    assert.equal((await schemaMigrationStatus(db)).ready, true);
  } finally {
    await engine.close();
  }
});
