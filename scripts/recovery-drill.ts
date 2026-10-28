// Disposable PostgreSQL recovery verification. Deliberately does not load .env.
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import { buildSampleStore } from "./sample-data";
import { readBackupFile, writeBackupFile } from "./backup-files";
import {
  backupRecoveryDigest,
  expectedRecoveryFinancialRows,
  financialRowKey,
  recoveryDigest,
  recoveryDrillTarget,
  recoveryRecordCounts,
  recoveryResourceName,
  type RecoveryFinancialRow,
} from "./recovery-contract";
import type { Command } from "../src/domain/commands";
import type { Staff } from "../src/domain/model";
import { emptyStore } from "../src/domain/selectors";
import { createBackup, restoreBackup, type Backup } from "../src/server/backup";
import { hashPassword, login, sessionUser } from "../src/server/auth";
import { databaseFromPool, type Database } from "../src/server/database";
import { databasePoolOptions } from "../src/server/database-options";
import { migrate, schema, schemaMigrationStatus } from "../src/server/schema";
import { importStore, readStore } from "../src/server/storage";
import { mutate } from "../src/server/repository";
import { readOperationalSnapshot } from "../src/server/queries";
import { verifyDatabaseIntegrity } from "../src/server/integrity";

type Side = {
  schema: string;
  owner: string;
  app: string;
  ownerSecret: string;
  appSecret: string;
  ownerPool?: Pool;
  appPool?: Pool;
  ownerDb?: Database;
  appDb?: Database;
};
type Phase = { name: string; durationMs: number; status: "passed" | "failed" };
const password = "fictional-recovery-drill-password";
const fixtureTime = new Date("2026-10-20T15:00:00.000Z");

class RecoveryVerificationError extends Error {
  constructor(readonly verification: string) {
    super("Recovery verification failed.");
  }
}

function check(condition: unknown, label: string): asserts condition {
  if (!condition) throw new RecoveryVerificationError(label);
}
function same(first: unknown, second: unknown, label: string) {
  check(recoveryDigest(first) === recoveryDigest(second), label);
}
function code(error: unknown) {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[A-Z0-9]{5}$/.test(error.code)
  )
    return error.code;
  return "DRILL_VERIFICATION_FAILED";
}
const identifier = (value: string) => {
  check(
    /^poker_test_recovery_[a-f0-9]{16}_(?:source|destination)(?:_owner|_app)?$/.test(
      value,
    ),
    "owned SQL identity",
  );
  return `"${value}"`;
};

async function expectSqlFailure(
  work: () => Promise<unknown>,
  expected: string,
  label: string,
) {
  let failed = false;
  try {
    await work();
  } catch (error) {
    failed = true;
    check(code(error) === expected, label);
  }
  check(failed, label);
}

async function legacySnapshot(db: Database, indexed: boolean) {
  const states = (
    await db.query<{ branch_id: string; revision: number; data: unknown }>(
      "SELECT branch_id,revision,data FROM poker_branch_state ORDER BY branch_id",
    )
  ).rows;
  if (indexed)
    for (const state of states)
      state.data = await readStore(db, state.branch_id);
  return {
    authoritative: {
      branches: (
        await db.query(
          "SELECT id,name,timezone FROM poker_branches ORDER BY id",
        )
      ).rows,
      users: (
        await db.query(
          "SELECT id,username,password_hash,active FROM poker_users ORDER BY id",
        )
      ).rows,
      memberships: (
        await db.query(
          "SELECT user_id,branch_id,role FROM poker_memberships ORDER BY branch_id,user_id",
        )
      ).rows,
      states,
      operations: (
        await db.query(
          "SELECT branch_id,operation_id,actor_id,fingerprint,revision,created_at FROM poker_operations ORDER BY branch_id,operation_id",
        )
      ).rows,
    },
    history: (
      await db.query(
        "SELECT version,name,checksum,applied_at FROM poker_schema_migrations ORDER BY version",
      )
    ).rows,
    attempts: (
      await db.query(
        "SELECT username,attempts,window_start FROM poker_login_attempts ORDER BY username",
      )
    ).rows,
    sessions: (
      await db.query(
        "SELECT token_hash,user_id,branch_id,expires_at FROM poker_sessions ORDER BY token_hash",
      )
    ).rows,
  };
}

async function seedLegacy(db: Database, hash: string) {
  for (const statement of schema
    .split(";")
    .map((value) => value.trim())
    .filter(Boolean))
    await db.query(statement);
  await db.query(`CREATE TABLE poker_schema_migrations (
    version integer PRIMARY KEY CHECK(version>0), name text NOT NULL,
    checksum text NOT NULL CHECK(checksum ~ '^[a-f0-9]{64}$'), applied_at timestamptz NOT NULL DEFAULT now())`);
  await db.query(
    "INSERT INTO poker_schema_migrations(version,name,checksum) VALUES(1,'initial_schema',$1)",
    [createHash("sha256").update(schema).digest("hex")],
  );
  const venues: Array<{
    id: string;
    actors: Record<"cashier" | "manager" | "admin" | "dealer", Staff>;
    legacyRetry: {
      branchId: string;
      actorId: string;
      operationId: string;
      revision: number;
      command: Command;
    };
  }> = [];
  for (const branchId of ["drill-main", "drill-second"]) {
    const actors = Object.fromEntries(
      (["cashier", "manager", "admin", "dealer"] as const).map((role) => [
        role,
        {
          id: `${branchId}_${role}`,
          username: `${branchId}.${role}`,
          role: role.toUpperCase() as Staff["role"],
          branchId,
        },
      ]),
    ) as Record<"cashier" | "manager" | "admin" | "dealer", Staff>;
    await db.query(
      "INSERT INTO poker_branches(id,name,timezone) VALUES($1,$2,'Asia/Kuala_Lumpur')",
      [branchId, `Fictional recovery ${branchId}`],
    );
    for (const actor of Object.values(actors)) {
      await db.query(
        "INSERT INTO poker_users(id,username,password_hash) VALUES($1,$2,$3)",
        [actor.id, actor.username, hash],
      );
      await db.query(
        "INSERT INTO poker_memberships(user_id,branch_id,role) VALUES($1,$2,$3)",
        [actor.id, branchId, actor.role],
      );
    }
    const store = buildSampleStore(actors, fixtureTime);
    await db.query(
      "INSERT INTO poker_branch_state(branch_id,revision,data) VALUES($1,7,$2)",
      [branchId, JSON.stringify(store)],
    );
    // This exact table creation occurred through applyCommand in buildSampleStore.
    const command: Command = {
      kind: "TABLE",
      name: "Sample · Main floor",
      dealer: "Sample Dealer A",
      status: "OPEN",
    };
    const legacyRetry = {
      branchId,
      actorId: actors.admin.id,
      operationId: randomUUID(),
      revision: 0,
      command,
    };
    await db.query(
      "INSERT INTO poker_operations(branch_id,operation_id,actor_id,fingerprint,revision) VALUES($1,$2,$3,$4,7)",
      [
        branchId,
        legacyRetry.operationId,
        actors.admin.id,
        createHash("sha256").update(JSON.stringify(command)).digest("hex"),
      ],
    );
    venues.push({ id: branchId, actors, legacyRetry });
  }
  await db.query(
    "INSERT INTO poker_login_attempts(username,attempts,window_start) VALUES($1,2147483647,now()-interval '1 hour')",
    [venues[0].actors.admin.username],
  );
  await db.query(
    "INSERT INTO poker_users(id,username,password_hash,active) VALUES('drill-invalid-legacy','!unknown:7',$1,false)",
    [hash],
  );
  return venues;
}

async function grantApplication(db: Database, side: Side) {
  const role = identifier(side.app);
  await db.query(`GRANT USAGE ON SCHEMA ${identifier(side.schema)} TO ${role}`);
  await db.query(
    `GRANT SELECT ON ALL TABLES IN SCHEMA ${identifier(side.schema)} TO ${role}`,
  );
  await db.query(
    `GRANT INSERT,UPDATE ON poker_branches,poker_users,poker_memberships,poker_branch_state,poker_profiles,poker_tables,poker_visits,poker_days,poker_approvals,poker_change_versions,poker_financial_totals,poker_login_budget TO ${role}`,
  );
  await db.query(
    `GRANT INSERT ON poker_ledger,poker_audit,poker_operations TO ${role}`,
  );
  await db.query(
    `GRANT INSERT,UPDATE,DELETE ON poker_sessions,poker_login_attempts TO ${role}`,
  );
}

async function applicationPrivileges(side: Side) {
  const db = side.appDb!;
  const identity = (
    await db.query<{ principal: string; owner: string; privileged: boolean }>(
      `SELECT session_user::text AS principal,current_schema() AS owner,
    (rolsuper OR rolcreatedb OR rolcreaterole) AS privileged FROM pg_roles WHERE rolname=current_user`,
    )
  ).rows[0];
  check(
    identity.principal === side.app &&
      identity.owner === side.schema &&
      !identity.privileged,
    "dedicated non-owner application role",
  );
  const denied = async (sql: string, label: string) =>
    expectSqlFailure(
      () =>
        db.transaction(async (connection) => {
          await connection.query(sql);
          throw new Error(
            "Unexpected application privilege; transaction rolled back.",
          );
        }),
      "42501",
      label,
    );
  await denied(
    "CREATE TABLE recovery_forbidden(id integer)",
    "application cannot create schema objects",
  );
  await denied(
    "ALTER TABLE poker_users ADD COLUMN recovery_forbidden integer",
    "application cannot alter owned schema",
  );
  await denied(
    "INSERT INTO poker_schema_migrations(version,name,checksum) VALUES(9999,'forbidden',repeat('a',64))",
    "application cannot change migration history",
  );
  for (const table of ["poker_ledger", "poker_audit", "poker_operations"]) {
    await denied(
      `UPDATE ${table} SET branch_id=branch_id WHERE false`,
      `application cannot update ${table}`,
    );
    await denied(
      `DELETE FROM ${table} WHERE false`,
      `application cannot delete ${table}`,
    );
  }
  check(
    (await schemaMigrationStatus(db)).ready,
    "application can read migration readiness",
  );
  return {
    dedicatedNonOwner: true,
    schemaDdlDenied: true,
    migrationWritesDenied: true,
    immutableHistoryUpdateDeleteDenied: true,
  };
}

async function financialParity(db: Database, backup: Backup) {
  const expected = expectedRecoveryFinancialRows(backup.payload.states);
  const actual = (
    await db.query<RecoveryFinancialRow>(`SELECT branch_id,scope,entity_id,day_id,
    buy_in::text,cash_out::text,rake::text,tips::text,insurance::text,jackpot::text,cash_received::text,cash_payout::text,credit_delta::text
    FROM poker_financial_totals`)
  ).rows.sort((first, second) =>
    financialRowKey(first).localeCompare(financialRowKey(second), "en"),
  );
  same(actual, expected, "independent BigInt projection parity");
  return {
    rows: actual.length,
    digest: recoveryDigest(expected),
    independentBigIntParity: true,
  };
}

async function main() {
  // Validate before creating a Pool or reading any persistent application data.
  const target = recoveryDrillTarget();
  const suffix = randomBytes(8).toString("hex");
  const sides: Side[] = ["source", "destination"].map((value) => {
    const name = value as "source" | "destination";
    return {
      schema: recoveryResourceName(suffix, name),
      owner: recoveryResourceName(suffix, `${name}_owner`),
      app: recoveryResourceName(suffix, `${name}_app`),
      ownerSecret: randomBytes(32).toString("hex"),
      appSecret: randomBytes(32).toString("hex"),
    };
  });
  const [source, destination] = sides;
  const roles = sides.flatMap((side) => [side.owner, side.app]);
  const schemas = sides.map((side) => side.schema);
  const phases: Phase[] = [];
  const idleErrors: string[] = [];
  const pools: Pool[] = [];
  const localRoot = path.resolve(process.cwd(), ".local");
  await mkdir(localRoot, { recursive: true, mode: 0o700 });
  check(
    (await realpath(localRoot)).toLowerCase() === localRoot.toLowerCase(),
    "local artifact directory is not redirected",
  );
  const directory = path.join(localRoot, `recovery-drill-${suffix}`);
  await mkdir(directory, { mode: 0o700 });
  const reportPath = path.join(directory, "report.json");
  const report: Record<string, unknown> = {
    kind: "disposable-postgresql-recovery-drill",
    createdAt: new Date().toISOString(),
    target: { host: target.host, port: target.port, database: target.database },
    fixturesOnly: true,
    phases,
    limitations: [
      "Local engineering rehearsal, not hosted disaster recovery or an agreed RPO/RTO",
      "No real venue records or credentials are read",
      "Private fixture backup files remain in the owned ignored artifact directory",
    ],
  };
  let ownershipEstablished = false;
  let admin: Pool | undefined;
  let failed = false;
  let interrupted = false;
  const interrupt = () => {
    interrupted = true;
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const measure = async <T>(
    name: string,
    work: () => Promise<T>,
  ): Promise<T> => {
    check(!interrupted, "drill not interrupted");
    const started = performance.now();
    const phase: Phase = { name, durationMs: 0, status: "failed" };
    phases.push(phase);
    try {
      const result = await work();
      phase.status = "passed";
      return result;
    } finally {
      phase.durationMs = Number((performance.now() - started).toFixed(3));
    }
  };
  const pool = (
    connectionString: string,
    extra: Record<string, unknown> = {},
  ) => {
    const value = new Pool({
      connectionString,
      ...databasePoolOptions({
        DATABASE_URL: connectionString,
        DATABASE_POOL_MAX: "2",
      }),
      options: "",
      ...extra,
    });
    value.on("error", (error) => idleErrors.push(code(error)));
    pools.push(value);
    return value;
  };
  try {
    admin = pool(target.connectionString, {
      options: "-c search_path=pg_catalog",
      application_name: `poker-recovery-owner-${suffix}`,
    });
    await measure("verify_target_and_create_owned_resources", async () => {
      const current = (
        await admin!.query<{
          database: string;
          version: string;
          number: string;
        }>(
          "SELECT current_database() AS database,version() AS version,current_setting('server_version_num') AS number",
        )
      ).rows[0];
      check(
        current.database === target.database &&
          Number(current.number) >= 170000 &&
          Number(current.number) < 180000,
        "explicit disposable PostgreSQL 17 target",
      );
      report.postgres = current.version;
      check(
        (
          await admin!.query(
            "SELECT nspname FROM pg_namespace WHERE nspname=ANY($1::text[])",
            [schemas],
          )
        ).rows.length === 0,
        "owned schemas initially absent",
      );
      check(
        (
          await admin!.query(
            "SELECT rolname FROM pg_roles WHERE rolname=ANY($1::text[])",
            [roles],
          )
        ).rows.length === 0,
        "owned roles initially absent",
      );
      ownershipEstablished = true;
      for (const side of sides) {
        for (const [role, secret] of [
          [side.owner, side.ownerSecret],
          [side.app, side.appSecret],
        ]) {
          check(/^[a-f0-9]{64}$/.test(secret), "generated fixture credential");
          await admin!.query(
            `CREATE ROLE ${identifier(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD '${secret}'`,
          );
          await admin!.query(
            `ALTER ROLE ${identifier(role)} IN DATABASE "${target.database}" SET search_path TO ${identifier(side.schema)}`,
          );
        }
        await admin!.query(
          `CREATE SCHEMA ${identifier(side.schema)} AUTHORIZATION ${identifier(side.owner)}`,
        );
        const ownerUrl = new URL(target.connectionString);
        ownerUrl.username = side.owner;
        ownerUrl.password = side.ownerSecret;
        const appUrl = new URL(target.connectionString);
        appUrl.username = side.app;
        appUrl.password = side.appSecret;
        side.ownerPool = pool(ownerUrl.href, {
          application_name: `poker-recovery-${suffix}`,
        });
        side.appPool = pool(appUrl.href, {
          application_name: `poker-recovery-app-${suffix}`,
        });
        side.ownerDb = databaseFromPool(side.ownerPool);
        side.appDb = databaseFromPool(side.appPool);
      }
    });
    const hash = await hashPassword(password);
    const venues = await measure("populate_genuine_legacy_v1_records", () =>
      seedLegacy(source.ownerDb!, hash),
    );
    await measure("verify_failed_v1_to_v5_upgrade_rollback", async () => {
      const before = await legacySnapshot(source.ownerDb!, false);
      await expectSqlFailure(
        () => migrate(source.ownerDb!),
        "23514",
        "incompatible legacy namespace fails upgrade",
      );
      same(
        await legacySnapshot(source.ownerDb!, false),
        before,
        "failed upgrade preserves legacy records/history/counters",
      );
      check(
        (
          await source.ownerDb!.query<{ relation: string | null }>(
            "SELECT to_regclass('poker_ledger')::text AS relation",
          )
        ).rows[0].relation === null,
        "failed upgrade removes intermediate DDL",
      );
      await source.ownerDb!.query(
        "DELETE FROM poker_users WHERE id='drill-invalid-legacy'",
      );
    });
    await measure(
      "upgrade_v1_to_v5_and_preserve_order_and_operation_ids",
      async () => {
        const before = await legacySnapshot(source.ownerDb!, false);
        await migrate(source.ownerDb!);
        const after = await legacySnapshot(source.ownerDb!, true);
        same(
          after.authoritative,
          before.authoritative,
          "successful upgrade preserves complete ordered authoritative records",
        );
        same(
          after.history.slice(0, 1),
          before.history,
          "published v1 migration metadata remains unchanged",
        );
        same(
          await schemaMigrationStatus(source.ownerDb!),
          { ready: true, appliedVersion: 5, expectedVersion: 5 },
          "all five migrations applied",
        );
        const backup = await createBackup(source.ownerDb!);
        report.migrationProjection = await financialParity(
          source.ownerDb!,
          backup,
        );
      },
    );
    await measure(
      "provision_and_verify_restricted_application_roles",
      async () => {
        await migrate(destination.ownerDb!);
        for (const side of sides) await grantApplication(side.ownerDb!, side);
        report.privileges = await applicationPrivileges(source);
        await applicationPrivileges(destination);
      },
    );
    const actors = venues[0].actors;
    const { admin: sourceAdmin, cashier: sourceCashier } = await measure(
      "restricted_role_staff_sign_in",
      async () => ({
        admin: await login(source.appDb!, actors.admin.username, password),
        cashier: await login(source.appDb!, actors.cashier.username, password),
      }),
    );
    let retryInput: {
      branchId: string;
      actorId: string;
      revision: number;
      operationId: string;
      command: Command;
    };
    await measure("restricted_role_cash_posting_and_exact_retry", async () => {
      const before = await readOperationalSnapshot(
        source.appDb!,
        sourceCashier,
      );
      const table = before.store.tables.find(
        (entry) => entry.status === "OPEN",
      )!;
      check(table, "sample open table");
      retryInput = {
        branchId: venues[0].id,
        actorId: actors.cashier.id,
        revision: before.revision,
        operationId: randomUUID(),
        command: {
          kind: "REQUEST",
          type: "Rake",
          amount: 5000,
          tableId: table.id,
          note: "Fictional recovery drill posting",
        },
      };
      const requested = await mutate(source.appDb!, sourceCashier, retryInput, {
        compact: true,
      });
      const approval = requested.store.approvals.find(
        (entry) => entry.note === "Fictional recovery drill posting",
      );
      check(approval, "request receipt includes new sample request");
      await mutate(
        source.appDb!,
        sourceAdmin,
        {
          branchId: venues[0].id,
          actorId: actors.admin.id,
          revision: requested.revision,
          operationId: randomUUID(),
          command: {
            kind: "DECIDE",
            approvalId: approval.id,
            decision: "APPROVED",
          },
        },
        { compact: true },
      );
      const posted = await createBackup(source.ownerDb!);
      await mutate(source.appDb!, sourceCashier, retryInput, { compact: true });
      same(
        backupRecoveryDigest(await createBackup(source.ownerDb!)),
        backupRecoveryDigest(posted),
        "same operation does not post twice",
      );
    });
    const baseline = await measure("capture_source_backup", () =>
      createBackup(source.ownerDb!),
    );
    const sourceDigest = backupRecoveryDigest(baseline);
    report.records = recoveryRecordCounts(baseline.payload);
    report.authoritativeDigest = sourceDigest;
    report.financialProjection = await financialParity(source.appDb!, baseline);
    report.sourceIntegrity = await verifyDatabaseIntegrity(source.appDb!);
    const backupPath = path.join(directory, "source-backup.json");
    const fromFile = await measure(
      "private_backup_file_write_read_and_checksum",
      async () => {
        report.backupFile = await writeBackupFile(backupPath, baseline);
        const read = await readBackupFile(backupPath);
        check(
          backupRecoveryDigest(read) === sourceDigest,
          "disk backup round trip",
        );
        return read;
      },
    );
    await destination.ownerDb!.query(
      "INSERT INTO poker_branches(id,name) VALUES('drill-sentinel','Fictional pre-restore sentinel')",
    );
    await importStore(destination.ownerDb!, "drill-sentinel", emptyStore());
    await destination.ownerDb!.query(
      "INSERT INTO poker_users(id,username,password_hash) VALUES('drill-sentinel-admin','drill.sentinel.admin',$1)",
      [hash],
    );
    await destination.ownerDb!.query(
      "INSERT INTO poker_memberships(user_id,branch_id,role) VALUES('drill-sentinel-admin','drill-sentinel','ADMIN')",
    );
    const oldDestinationToken = await login(
      destination.appDb!,
      "drill.sentinel.admin",
      password,
    );
    const beforeDestination = await createBackup(destination.ownerDb!);
    await measure("failed_safety_backup_preserves_destination", async () => {
      let callback = false;
      let rejected = false;
      try {
        await restoreBackup(destination.ownerDb!, fromFile, async () => {
          callback = true;
          throw new Error("Synthetic safety-file failure");
        });
      } catch (error) {
        rejected = true;
        check(
          callback &&
            error instanceof Error &&
            error.message === "Synthetic safety-file failure",
          "safety-file rejection propagates before mutation",
        );
      }
      check(callback && rejected, "safety-file failure was exercised");
      check(
        backupRecoveryDigest(await createBackup(destination.ownerDb!)) ===
          backupRecoveryDigest(beforeDestination),
        "safety-file failure leaves destination unchanged",
      );
      check(
        await sessionUser(destination.appDb!, oldDestinationToken),
        "safety-file failure keeps prior session",
      );
    });
    await measure(
      "mid_restore_sql_failure_rolls_back_every_replacement",
      async () => {
        let injected = false;
        const failing: Database = {
          query: destination.ownerDb!.query,
          transaction: (work) =>
            destination.ownerDb!.transaction((connection) =>
              work({
                async query<T>(sql: string, values?: unknown[]) {
                  if (!injected && sql.startsWith("INSERT INTO poker_users")) {
                    injected = true;
                    await connection.query("SELECT 1/0");
                  }
                  return connection.query<T>(sql, values);
                },
              }),
            ),
        };
        await expectSqlFailure(
          () =>
            restoreBackup(failing, fromFile, async (before) => {
              await writeBackupFile(
                path.join(directory, "rollback-safety.json"),
                before,
              );
            }),
          "22012",
          "actual SQL interruption during replacement",
        );
        check(injected, "mid-restore fault was reached");
        check(
          backupRecoveryDigest(await createBackup(destination.ownerDb!)) ===
            backupRecoveryDigest(beforeDestination),
          "SQL interruption restores original destination",
        );
        check(
          await sessionUser(destination.appDb!, oldDestinationToken),
          "SQL rollback preserves prior session",
        );
      },
    );
    await measure("restore_with_durable_pre_restore_backup", () =>
      restoreBackup(destination.ownerDb!, fromFile, async (before) => {
        const safetyPath = path.join(directory, "pre-restore.json");
        await writeBackupFile(safetyPath, before);
        check(
          backupRecoveryDigest(await readBackupFile(safetyPath)) ===
            backupRecoveryDigest(beforeDestination),
          "pre-restore safety file is complete",
        );
      }),
    );
    await measure(
      "verify_restored_records_balances_sessions_and_retries",
      async () => {
        const restored = await createBackup(destination.ownerDb!);
        check(
          backupRecoveryDigest(restored) === sourceDigest,
          "all authoritative records restored in order",
        );
        same(
          await financialParity(destination.appDb!, restored),
          report.financialProjection,
          "restored financial summaries match independent source totals",
        );
        check(
          (await sessionUser(destination.appDb!, oldDestinationToken)) === null,
          "old destination session revoked",
        );
        check(
          (await sessionUser(destination.appDb!, sourceAdmin)) === null,
          "source session is not portable to restore",
        );
        const { admin: freshAdmin, cashier: freshCashier } = await measure(
          "fresh_restored_staff_login",
          async () => ({
            admin: await login(
              destination.appDb!,
              actors.admin.username,
              password,
            ),
            cashier: await login(
              destination.appDb!,
              actors.cashier.username,
              password,
            ),
          }),
        );
        check(
          await sessionUser(destination.appDb!, freshAdmin),
          "fresh restored login",
        );
        await mutate(destination.appDb!, freshCashier, retryInput!, {
          compact: true,
        });
        await mutate(destination.appDb!, freshAdmin, venues[0].legacyRetry, {
          compact: true,
        });
        check(
          backupRecoveryDigest(await createBackup(destination.ownerDb!)) ===
            sourceDigest,
          "legacy and new retry IDs do not duplicate records after restore",
        );
        check(
          backupRecoveryDigest(await createBackup(source.ownerDb!)) ===
            sourceDigest,
          "source remains unchanged throughout recovery",
        );
        report.recovery = {
          authoritativeParity: true,
          independentFinancialParity: true,
          sessionsRevoked: true,
          freshLogin: true,
          legacyAndNewRetryParity: true,
          sourceUnchanged: true,
        };
        report.restoredIntegrity = await verifyDatabaseIntegrity(
          destination.appDb!,
        );
      },
    );
    check(
      !interrupted && idleErrors.length === 0,
      "uninterrupted healthy database connections",
    );
    report.status = "passed";
  } catch (error) {
    failed = true;
    report.status = "failed";
    report.failure = {
      category: code(error),
      phase:
        phases.findLast((phase) => phase.status === "failed")?.name ??
        "setup_or_verification",
      interrupted,
      ...(error instanceof RecoveryVerificationError
        ? { verification: error.verification }
        : {}),
    };
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    const cleanup = {
      ownedResourcesCreated: ownershipEstablished,
      poolsClosed: true,
      schemasRemoved: false,
      rolesRemoved: false,
      remainingSchemas: ownershipEstablished ? (null as number | null) : 0,
      remainingRoles: ownershipEstablished ? (null as number | null) : 0,
    };
    try {
      const closing = await Promise.allSettled(
        pools.filter((value) => value !== admin).map((value) => value.end()),
      );
      check(
        closing.every((result) => result.status === "fulfilled"),
        "fixture pools closed",
      );
      if (admin && ownershipEstablished) {
        for (const side of sides) {
          const owner = (
            await admin.query<{ owner: string }>(
              "SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname=$1",
              [side.schema],
            )
          ).rows[0];
          check(
            !owner || owner.owner === side.owner,
            "owned schema cleanup identity",
          );
          await admin.query(
            `DROP SCHEMA IF EXISTS ${identifier(side.schema)} CASCADE`,
          );
        }
        for (const role of roles)
          await admin.query(`DROP ROLE IF EXISTS ${identifier(role)}`);
        cleanup.remainingSchemas = (
          await admin.query(
            "SELECT nspname FROM pg_namespace WHERE nspname=ANY($1::text[])",
            [schemas],
          )
        ).rows.length;
        cleanup.remainingRoles = (
          await admin.query(
            "SELECT rolname FROM pg_roles WHERE rolname=ANY($1::text[])",
            [roles],
          )
        ).rows.length;
        check(
          cleanup.remainingSchemas === 0 && cleanup.remainingRoles === 0,
          "owned resources removed",
        );
      }
      cleanup.schemasRemoved = true;
      cleanup.rolesRemoved = true;
    } catch {
      failed = true;
      cleanup.poolsClosed = false;
      report.status = "failed";
      report.cleanupFailure = { ownedSchemas: schemas, ownedRoles: roles };
    } finally {
      await admin?.end().catch(() => {
        failed = true;
        cleanup.poolsClosed = false;
        report.status = "failed";
      });
      report.cleanup = cleanup;
      report.idleDatabaseErrors = idleErrors;
      await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", {
        flag: "wx",
        mode: 0o600,
      });
    }
  }
  console.log(
    `Recovery drill ${failed ? "failed" : "passed"}. Report: ${reportPath}`,
  );
  if (failed) process.exitCode = 1;
}

void main().catch(() => {
  console.error(
    "Recovery drill could not start or save its report. Use an explicitly disposable PostgreSQL 17 target and inspect local permissions.",
  );
  process.exitCode = 1;
});
