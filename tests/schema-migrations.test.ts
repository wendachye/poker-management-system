import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { Database, SqlConnection } from "../src/server/database";
import { migrate, schema, schemaMigrationStatus } from "../src/server/schema";
import { configuredStore } from "./helpers/store";
import { importStore, readStore } from "../src/server/storage";
import { buildSampleStore } from "../scripts/sample-data";
import type { Role, Staff } from "../src/domain/model";

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
      expectedVersion: 5,
    });
    await migrate(db);
    const history = await db.query<{
      version: number;
      name: string;
      checksum: string;
      applied_at: Date;
    }>("SELECT * FROM poker_schema_migrations ORDER BY version");
    assert.equal(history.rows.length, 5);
    assert.equal(history.rows[0].version, 1);
    assert.equal(history.rows[0].name, "initial_schema");
    assert.deepEqual(
      history.rows.slice(0, 4).map((row) => row.checksum),
      [
        "b0e60da76b6ac5e2ee16eeb4e79e800f03a97dfea4d3ea62926b5e0778dd2a6d",
        "845d08bbb67983f3a72516a002392a93c619abcb377d2cb172db4387db601134",
        "04edbd9c06ced69f8aefd0b737e8a9598ba4d75c3e20475c473275dcef8c6a10",
        "b0d921b0384ac8cb287af434fb21b9f29b7e39d01e39723729824a062b3b0aaa",
      ],
      "Published v1-v4 migration fingerprints must not change",
    );
    assert.equal(
      history.rows[0].checksum,
      createHash("sha256").update(schema).digest("hex"),
    );
    assert.ok(Number.isFinite(new Date(history.rows[0].applied_at).getTime()));
    assert.deepEqual(await schemaMigrationStatus(db), {
      ready: true,
      appliedVersion: 5,
      expectedVersion: 5,
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

test("the authentication upgrade preserves released history and rolls quota changes back on incompatible legacy usernames", async () => {
  const { db, engine } = await isolatedDatabase();
  try {
    await migrate(db);
    await legacyRecords(db);
    // Construct the exact published v3 seam without changing its recorded SQL.
    await db.query("DROP TABLE poker_login_budget");
    await db.query("DROP INDEX poker_login_attempts_expiry");
    await db.query("DROP INDEX poker_sessions_user");
    for (const index of [
      "poker_ledger_order",
      "poker_approvals_order",
      "poker_audit_order",
    ])
      await db.query(`DROP INDEX ${index}`);
    await db.query(
      "ALTER TABLE poker_login_attempts DROP CONSTRAINT poker_login_attempts_count",
    );
    await db.query(
      "ALTER TABLE poker_users DROP CONSTRAINT poker_users_login_namespace",
    );
    await db.query("DELETE FROM poker_schema_migrations WHERE version>=4");
    const released = (
      await db.query("SELECT * FROM poker_schema_migrations ORDER BY version")
    ).rows;
    await db.query(
      "INSERT INTO poker_login_attempts(username,attempts,window_start) VALUES('existing.owner',2147483647,now())",
    );
    await db.query(
      "INSERT INTO poker_users(id,username,password_hash) VALUES('legacy-reserved','!unknown:3','test-no-login')",
    );
    const original = await records(db);
    await assert.rejects(migrate(db), /poker_users_login_namespace/);
    assert.deepEqual(await records(db), original);
    assert.deepEqual(
      (await db.query("SELECT * FROM poker_schema_migrations ORDER BY version"))
        .rows,
      released,
    );
    assert.equal(
      (
        await db.query<{ attempts: number }>(
          "SELECT attempts FROM poker_login_attempts WHERE username='existing.owner'",
        )
      ).rows[0].attempts,
      2147483647,
    );
    assert.equal(
      (await db.query("SELECT to_regclass('poker_login_budget') AS relation"))
        .rows[0].relation,
      null,
    );

    // Remediation affects only this deliberately invalid disposable fixture.
    await db.query("DELETE FROM poker_users WHERE id='legacy-reserved'");
    const remediated = await records(db);
    await migrate(db);
    assert.deepEqual(await records(db), remediated);
    assert.deepEqual(
      (
        await db.query(
          "SELECT * FROM poker_schema_migrations WHERE version<=3 ORDER BY version",
        )
      ).rows,
      released,
    );
    assert.equal(
      (
        await db.query<{ attempts: number }>(
          "SELECT attempts FROM poker_login_attempts WHERE username='existing.owner'",
        )
      ).rows[0].attempts,
      11,
    );
    assert.deepEqual(await schemaMigrationStatus(db), {
      ready: true,
      appliedVersion: 5,
      expectedVersion: 5,
    });
  } finally {
    await engine.close();
  }
});

test("the v4 history-order upgrade preserves populated venues and rolls index creation back on failure", async () => {
  const { db, engine } = await isolatedDatabase();
  const indexNames = [
    "poker_ledger_order",
    "poker_approvals_order",
    "poker_audit_order",
  ];
  try {
    await migrate(db);
    const actors = Object.fromEntries(
      ["admin", "manager", "cashier", "dealer"].map((name) => [
        name,
        {
          id: "upgrade-" + name,
          username: "upgrade." + name,
          role: name.toUpperCase() as Role,
          branchId: "upgrade-main",
        },
      ]),
    ) as Record<"admin" | "manager" | "cashier" | "dealer", Staff>;
    for (const actor of Object.values(actors))
      await db.query(
        "INSERT INTO poker_users(id,username,password_hash) VALUES($1,$2,'fictional-unusable-hash')",
        [actor.id, actor.username],
      );
    const store = buildSampleStore(actors, new Date("2026-10-28T05:00:00Z"));
    for (const [branchId, revision] of [
      ["upgrade-main", 7],
      ["upgrade-other", 13],
    ] as const) {
      await db.query("INSERT INTO poker_branches(id,name) VALUES($1,$1)", [
        branchId,
      ]);
      for (const actor of Object.values(actors))
        await db.query(
          "INSERT INTO poker_memberships(user_id,branch_id,role) VALUES($1,$2,$3)",
          [actor.id, branchId, actor.role],
        );
      const venue = structuredClone(store);
      // Matching entity IDs deliberately exist in two venues. Their names and
      // revisions remain different, so index lookups must retain branch scope.
      venue.profiles[0].name = branchId + " retained player";
      await importStore(db, branchId, venue, revision);
      await db.query(
        "INSERT INTO poker_operations(branch_id,operation_id,actor_id,fingerprint,revision) VALUES($1,'retained-operation',$2,$3,$4)",
        [branchId, actors.admin.id, "a".repeat(64), revision],
      );
    }

    // Construct the published v4 seam without changing a released statement.
    for (const index of indexNames) await db.query(`DROP INDEX ${index}`);
    await db.query("DELETE FROM poker_schema_migrations WHERE version=5");
    const original = await records(db);
    const released = (
      await db.query("SELECT * FROM poker_schema_migrations ORDER BY version")
    ).rows;
    assert.deepEqual(await schemaMigrationStatus(db), {
      ready: false,
      appliedVersion: 4,
      expectedVersion: 5,
    });
    const faulty: Database = {
      ...db,
      transaction: (work) =>
        db.transaction((connection) =>
          work({
            async query<T>(sql: string, values?: unknown[]) {
              if (
                sql.startsWith("INSERT INTO poker_schema_migrations") &&
                values?.[0] === 5
              )
                throw new Error("Simulated v5 ledger write failure");
              return connection.query<T>(sql, values);
            },
          }),
        ),
    };
    await assert.rejects(migrate(faulty), /Simulated v5 ledger/);
    assert.deepEqual(await records(db), original);
    assert.deepEqual(
      (await db.query("SELECT * FROM poker_schema_migrations ORDER BY version"))
        .rows,
      released,
    );
    assert.equal(
      (
        await db.query(
          "SELECT indexname FROM pg_indexes WHERE schemaname=current_schema() AND indexname=ANY($1::text[])",
          [indexNames],
        )
      ).rows.length,
      0,
      "Failed migration rolls every newly created index back",
    );

    await migrate(db);
    assert.deepEqual(await records(db), original);
    assert.deepEqual(
      (
        await db.query(
          "SELECT * FROM poker_schema_migrations WHERE version<=4 ORDER BY version",
        )
      ).rows,
      released,
    );
    const indexes = (
      await db.query<{ indexname: string; indexdef: string }>(
        "SELECT indexname,indexdef FROM pg_indexes WHERE schemaname=current_schema() AND indexname=ANY($1::text[]) ORDER BY indexname",
        [indexNames],
      )
    ).rows;
    assert.deepEqual(
      indexes.map((row) => row.indexname),
      [...indexNames].sort(),
    );
    for (const index of indexes)
      assert.match(index.indexdef, /\(branch_id, order_no, id\)/);
    for (const branchId of ["upgrade-main", "upgrade-other"]) {
      const saved = await readStore(db, branchId);
      assert.equal(saved.profiles[0].name, branchId + " retained player");
      assert.deepEqual(
        saved.transactions.map((row) => row.id),
        store.transactions.map((row) => row.id),
      );
      assert.deepEqual(
        saved.approvals.map((row) => row.id),
        store.approvals.map((row) => row.id),
      );
      assert.deepEqual(
        saved.auditLogs.map((row) => row.id),
        store.auditLogs.map((row) => row.id),
      );
    }
    assert.deepEqual(await schemaMigrationStatus(db), {
      ready: true,
      appliedVersion: 5,
      expectedVersion: 5,
    });
    const upgraded = (
      await db.query("SELECT * FROM poker_schema_migrations ORDER BY version")
    ).rows;
    await migrate(db);
    assert.deepEqual(await records(db), original);
    assert.deepEqual(
      (await db.query("SELECT * FROM poker_schema_migrations ORDER BY version"))
        .rows,
      upgraded,
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
      5,
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
      6,
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
      5,
    );
    assert.equal((await schemaMigrationStatus(db)).ready, true);
  } finally {
    await engine.close();
  }
});
