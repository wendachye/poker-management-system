import { createHash } from "node:crypto";
import type { Database, SqlConnection } from "./database";
import { indexedStorageStatements } from "./storage-schema";
import { financialRollupStatements } from "./rollup-schema";
import { authenticationAdmissionStatements } from "./auth-schema";

// Schema changes are applied explicitly by db:migrate, never during a request.
export const schema = `
CREATE TABLE IF NOT EXISTS poker_branches (
 id text PRIMARY KEY, name text NOT NULL, timezone text NOT NULL DEFAULT 'Asia/Kuala_Lumpur'
);
CREATE TABLE IF NOT EXISTS poker_users (
 id text PRIMARY KEY, username text NOT NULL UNIQUE, password_hash text NOT NULL, active boolean NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS poker_memberships (
 user_id text NOT NULL REFERENCES poker_users(id), branch_id text NOT NULL REFERENCES poker_branches(id),
 role text NOT NULL CHECK (role IN ('DEALER','CASHIER','MANAGER','ADMIN')), PRIMARY KEY(user_id, branch_id)
);
CREATE TABLE IF NOT EXISTS poker_sessions (
 token_hash text PRIMARY KEY, user_id text NOT NULL REFERENCES poker_users(id), branch_id text NOT NULL REFERENCES poker_branches(id), expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS poker_login_attempts (
 username text PRIMARY KEY, attempts integer NOT NULL, window_start timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS poker_branch_state (
 branch_id text PRIMARY KEY REFERENCES poker_branches(id), revision integer NOT NULL DEFAULT 0, data jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS poker_operations (
 branch_id text NOT NULL REFERENCES poker_branches(id), operation_id text NOT NULL, actor_id text NOT NULL REFERENCES poker_users(id),
 fingerprint text NOT NULL, revision integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(branch_id, operation_id)
);
CREATE INDEX IF NOT EXISTS poker_sessions_expiry ON poker_sessions(expires_at);
`;

// Append future migrations; recorded SQL (including this baseline) and names
// must stay unchanged so a deployed release can detect incompatible history.
function migration(
  version: number,
  name: string,
  statements: readonly string[],
  checksumSource = JSON.stringify(statements),
) {
  return {
    version,
    name,
    statements,
    checksum: createHash("sha256").update(checksumSource).digest("hex"),
  };
}

// Preserve the legacy baseline fingerprint. Future definitions use explicit
// statement arrays so SQL functions and string literals may contain semicolons.
const migrations = [
  migration(
    1,
    "initial_schema",
    schema
      .split(";")
      .map((value) => value.trim())
      .filter(Boolean),
    schema,
  ),
  migration(2, "indexed_operational_records", indexedStorageStatements),
  migration(3, "transactional_financial_totals", financialRollupStatements),
  migration(
    4,
    "bounded_authentication_admission",
    authenticationAdmissionStatements,
  ),
];

const migrationLedger = `CREATE TABLE IF NOT EXISTS poker_schema_migrations (
 version integer PRIMARY KEY CHECK (version > 0),
 name text NOT NULL,
 checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
 applied_at timestamptz NOT NULL DEFAULT now()
)`;

type AppliedMigration = {
  version: number;
  name: string;
  checksum: string;
};

async function appliedMigrations(connection: SqlConnection) {
  return (
    await connection.query<AppliedMigration>(
      "SELECT version,name,checksum,applied_at FROM poker_schema_migrations ORDER BY version",
    )
  ).rows;
}

function validateHistory(applied: AppliedMigration[]) {
  for (const [index, recorded] of applied.entries()) {
    const expected = migrations[index];
    if (!expected || recorded.version !== expected.version)
      throw new Error(
        "Database migration history contains an unknown or out-of-order version. Use the matching application release.",
      );
    if (recorded.name !== expected.name)
      throw new Error(
        "Database migration name does not match this release. Refusing to change the schema.",
      );
    if (recorded.checksum !== expected.checksum)
      throw new Error(
        "Database migration checksum does not match this release. Refusing to change the schema.",
      );
  }
}

/** Read-only readiness metadata; incompatible history fails closed. */
export async function schemaMigrationStatus(connection: SqlConnection) {
  const expectedVersion = migrations[migrations.length - 1].version;
  const ledger = await connection.query<{ relation: string | null }>(
    "SELECT to_regclass('poker_schema_migrations')::text AS relation",
  );
  if (!ledger.rows[0].relation)
    return { ready: false, appliedVersion: 0, expectedVersion };
  const applied = await appliedMigrations(connection);
  validateHistory(applied);
  return {
    ready: applied.length === migrations.length,
    appliedVersion: applied.at(-1)?.version ?? 0,
    expectedVersion,
  };
}

async function validateBaseline(connection: SqlConnection) {
  // Legacy databases may already have the tables but no ledger. Resolve their
  // required columns before recording adoption; never reset existing records.
  for (const columns of [
    "id,name,timezone FROM poker_branches",
    "id,username,password_hash,active FROM poker_users",
    "user_id,branch_id,role FROM poker_memberships",
    "token_hash,user_id,branch_id,expires_at FROM poker_sessions",
    "username,attempts,window_start FROM poker_login_attempts",
    "branch_id,revision,data FROM poker_branch_state",
    "branch_id,operation_id,actor_id,fingerprint,revision,created_at FROM poker_operations",
  ])
    await connection.query(`SELECT ${columns} LIMIT 0`);
}

export async function migrate(db: Database) {
  await db.transaction(async (connection) => {
    // A transaction advisory lock also protects the very first ledger CREATE
    // across processes; table locks alone cannot serialize a missing table.
    await connection.query("SELECT pg_advisory_xact_lock(1886350181, 1)");
    await connection.query(migrationLedger);
    const applied = await appliedMigrations(connection);
    validateHistory(applied);
    for (const migration of migrations.slice(applied.length)) {
      for (const statement of migration.statements)
        await connection.query(statement);
      if (migration.version === 1) await validateBaseline(connection);
      await connection.query(
        "INSERT INTO poker_schema_migrations(version,name,checksum) VALUES($1,$2,$3)",
        [migration.version, migration.name, migration.checksum],
      );
    }
  });
}
