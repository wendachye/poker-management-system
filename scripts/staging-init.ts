import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { Pool } from "pg";
import {
  databaseFromPool,
  type Database,
  type SqlConnection,
} from "../src/server/database";
import { databasePoolOptions } from "../src/server/database-options";
import { migrate } from "../src/server/schema";
import { captureBackup, backupSummary } from "../src/server/backup";
import { manageOperatorAccount } from "../src/server/operator-accounts";
import { replaceStore } from "../src/server/storage";
import { emptyStore } from "../src/domain/selectors";
import { defaultSettings } from "../src/domain/settings";
import type { Role } from "../src/domain/model";
import {
  stagingTarget,
  StagingSetupError,
  type StagingInput,
  type StagingTarget,
} from "./staging-target";

const identifier = (value: string) => `"${value.replaceAll('"', '""')}"`;
const staff = [
  ["staging.admin", "ADMIN"],
  ["staging.manager", "MANAGER"],
  ["staging.cashier", "CASHIER"],
] as const satisfies ReadonlyArray<readonly [string, Role]>;
export type StagingSecrets = {
  owner: string;
  app: string;
  staff: Record<(typeof staff)[number][0], string>;
};

export function createStagingSecrets(): StagingSecrets {
  return {
    owner: randomBytes(32).toString("hex"),
    app: randomBytes(32).toString("hex"),
    staff: Object.fromEntries(
      staff.map(([name]) => [name, randomBytes(24).toString("hex")]),
    ) as StagingSecrets["staff"],
  };
}

function assertSecrets(secrets: StagingSecrets) {
  const values = [
    secrets.owner,
    secrets.app,
    ...staff.map(([name]) => secrets.staff[name]),
  ];
  if (
    values.some((value) => !/^[a-f0-9]{48,64}$/.test(value)) ||
    new Set(values).size !== values.length
  )
    throw new StagingSetupError(
      "INVALID_SECRETS",
      "Use distinct generated setup credentials.",
    );
}

async function grantApplication(
  connection: SqlConnection,
  target: StagingTarget,
) {
  const app = identifier(target.app);
  await connection.query(
    `GRANT USAGE ON SCHEMA ${identifier(target.schema)} TO ${app}`,
  );
  await connection.query(
    `GRANT SELECT ON ALL TABLES IN SCHEMA ${identifier(target.schema)} TO ${app}`,
  );
  await connection.query(
    `GRANT INSERT,UPDATE ON poker_branches,poker_users,poker_memberships,poker_branch_state,poker_profiles,poker_tables,poker_visits,poker_days,poker_approvals,poker_change_versions,poker_financial_totals,poker_login_budget TO ${app}`,
  );
  await connection.query(
    `GRANT INSERT ON poker_ledger,poker_audit,poker_operations TO ${app}`,
  );
  await connection.query(
    `GRANT INSERT,UPDATE,DELETE ON poker_sessions,poker_login_attempts TO ${app}`,
  );
}

/** All creation, migrations, fixtures and grants commit together or roll back.
 * Only a fresh staging database is accepted; this is not a retry/migration CLI.
 */
export async function initializeStaging(
  db: Database,
  input: StagingInput,
  secrets: StagingSecrets,
  environment: Readonly<Record<string, string | undefined>> = {},
) {
  const target = stagingTarget(input, environment);
  assertSecrets(secrets);
  return db.transaction(async (connection) => {
    const actual = (
      await connection.query<{
        database: string;
        version: string;
        principal: string;
      }>(
        "SELECT current_database() AS database,current_setting('server_version_num') AS version,current_user::text AS principal",
      )
    ).rows[0];
    if (actual?.database !== target.database)
      throw new StagingSetupError(
        "DATABASE_MISMATCH",
        "The connected server did not select the confirmed database.",
      );
    const postgresMajor = Math.floor(Number(actual.version) / 10_000);
    if (![17, 18].includes(postgresMajor))
      throw new StagingSetupError(
        "UNSUPPORTED_POSTGRES",
        "Use PostgreSQL 17 or 18 for this staging setup and verify its hosted behavior separately.",
      );
    await connection.query("SELECT pg_advisory_xact_lock(1886350181, 7)");
    const existing = (
      await connection.query<{ occupied: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname=$1)
      OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=ANY($2::text[]))
      OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema'
        AND c.relkind IN ('r','p','v','m','S','f')
        AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass
          AND d.objid=c.oid AND d.deptype='e')) AS occupied`,
        [target.schema, [target.owner, target.app]],
      )
    ).rows[0];
    if (existing?.occupied !== false)
      throw new StagingSetupError(
        "TARGET_NOT_EMPTY",
        "Staging setup requires an empty database, fresh schema and fresh role names. No existing setup is overwritten.",
      );
    await connection.query("SET LOCAL password_encryption='scram-sha-256'");
    for (const [role, secret] of [
      [target.owner, secrets.owner],
      [target.app, secrets.app],
    ])
      await connection.query(
        `CREATE ROLE ${identifier(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${secret}'`,
      );
    // CREATEROLE supplies administration but not SET membership on PostgreSQL
    // 16+. Add our own temporary grant; never change the provider's admin grant.
    await connection.query(
      `GRANT ${identifier(target.owner)} TO ${identifier(actual.principal)} WITH ADMIN FALSE, INHERIT FALSE, SET TRUE GRANTED BY ${identifier(actual.principal)}`,
    );
    await connection.query(
      `CREATE SCHEMA ${identifier(target.schema)} AUTHORIZATION ${identifier(target.owner)}`,
    );
    await connection.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC`);
    await connection.query(
      `REVOKE CREATE ON DATABASE ${identifier(target.database)} FROM PUBLIC`,
    );
    for (const role of [target.owner, target.app]) {
      await connection.query(
        `GRANT CONNECT ON DATABASE ${identifier(target.database)} TO ${identifier(role)}`,
      );
      await connection.query(
        `ALTER ROLE ${identifier(role)} IN DATABASE ${identifier(target.database)} SET search_path TO ${identifier(target.schema)},pg_catalog`,
      );
    }
    await connection.query(`SET LOCAL ROLE ${identifier(target.owner)}`);
    await connection.query(
      `SET LOCAL search_path TO ${identifier(target.schema)},pg_catalog`,
    );
    // Nested domain/repository operations share this existing transaction.
    const staged: Database = {
      ...connection,
      transaction: (work) => work(connection),
    };
    await migrate(staged);
    for (const [id, name] of [
      ["staging-main", "Staging · Main venue"],
      ["staging-annex", "Staging · Second venue"],
    ]) {
      const store = emptyStore();
      store.settings = {
        ...defaultSettings(),
        venueName: name,
        smallBlind: 500,
        bigBlind: 1_000,
        minBuyIn: 20_000,
        maxBuyIn: 500_000,
        buyInStep: 5_000,
        rakePercent: 5,
        rakeCap: 5_000,
        tipsPolicy: "Fictional staging tips, recorded through approval.",
        houseRules:
          "STAGING ONLY. Fictional records. Review setup before opening a sample day.",
      };
      store.tables = [
        { id: `${id}-main`, name: "Main floor", status: "OPEN", dealer: "" },
        {
          id: `${id}-reserve`,
          name: "Reserve",
          status: "OPEN",
          dealer: "",
          smallBlind: 1_000,
          bigBlind: 2_500,
          minBuyIn: 50_000,
          maxBuyIn: 1_000_000,
          buyInStep: 5_000,
        },
      ];
      await connection.query(
        "INSERT INTO poker_branches(id,name,timezone) VALUES($1,$2,'Asia/Kuala_Lumpur')",
        [id, name],
      );
      await replaceStore(connection, id, store, 0);
    }
    for (const [username, role] of staff) {
      const common = {
        operator: "Staging initializer",
        reason: "Provision fictional cloud staging access",
      };
      await manageOperatorAccount(staged, {
        ...common,
        operationId: randomUUID(),
        command: {
          kind: "CREATE",
          username,
          role,
          branchId: "staging-main",
          password: secrets.staff[username],
        },
      });
      await manageOperatorAccount(staged, {
        ...common,
        operationId: randomUUID(),
        command: { kind: "GRANT", username, role, branchId: "staging-annex" },
      });
    }
    await grantApplication(connection, target);
    const backup = await captureBackup(connection);
    const report = {
      status: "initialized" as const,
      host: target.host,
      database: target.database,
      schema: target.schema,
      ownerRole: target.owner,
      appRole: target.app,
      postgresMajor,
      postgresVersionNumber: Number(actual.version),
      ...backupSummary(backup),
      sampleOnly: true,
      setupCompleted: false,
    };
    await connection.query("RESET ROLE");
    await connection.query(
      `REVOKE ${identifier(target.owner)} FROM ${identifier(actual.principal)} GRANTED BY ${identifier(actual.principal)}`,
    );
    return report;
  });
}

function roleUrl(target: StagingTarget, username: string, password: string) {
  const url = new URL(target.connectionString);
  url.username = username;
  url.password = password;
  return url.href;
}

async function main() {
  const { values } = parseArgs({
    options: {
      "expected-host": { type: "string" },
      "expected-database": { type: "string" },
      schema: { type: "string" },
      confirm: { type: "string" },
    },
  });
  const input: StagingInput = {
    databaseUrl: process.env.STAGING_DATABASE_URL,
    expectedHost: values["expected-host"],
    expectedDatabase: values["expected-database"],
    schema: values.schema,
    confirmation: values.confirm,
  };
  const target = stagingTarget(input, process.env),
    secrets = createStagingSecrets();
  const directory = resolve(
    ".local",
    "staging",
    `${target.schema}-${randomUUID()}`,
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const credentialsPath = resolve(directory, "credentials.json");
  const credentials = await open(credentialsPath, "wx", 0o600);
  try {
    await credentials.writeFile(
      JSON.stringify(
        {
          ownerDatabaseUrl: roleUrl(target, target.owner, secrets.owner),
          appDatabaseUrl: roleUrl(target, target.app, secrets.app),
          staff: secrets.staff,
        },
        null,
        2,
      ) + "\n",
    );
    await credentials.sync();
  } finally {
    await credentials.close();
  }
  console.log(
    JSON.stringify({
      status: "prepared",
      host: target.host,
      database: target.database,
      schema: target.schema,
      privateCredentialsFile: credentialsPath,
    }),
  );
  const pool = new Pool({
    connectionString: target.connectionString,
    ...databasePoolOptions({
      ...process.env,
      DATABASE_URL: target.connectionString,
    }),
    max: 1,
  });
  pool.on("error", () => {
    console.error(
      JSON.stringify({
        status: "failed",
        code: "STAGING_DATABASE_CONNECTION_LOST",
      }),
    );
    process.exitCode = 1;
  });
  try {
    const report = await initializeStaging(
      databaseFromPool(pool),
      input,
      secrets,
      process.env,
    );
    console.log(
      JSON.stringify(
        { ...report, privateCredentialsFile: credentialsPath },
        null,
        2,
      ),
    );
  } finally {
    await pool.end();
  }
}

if (require.main === module)
  main().catch((error: unknown) => {
    console.error(
      JSON.stringify({
        status: "failed",
        code:
          error instanceof StagingSetupError
            ? error.code
            : "STAGING_INITIALIZATION_FAILED",
        message:
          error instanceof StagingSetupError
            ? error.message
            : "Staging initialization failed. Check the dedicated bootstrap role permissions and review the target before retrying. No SQL, credentials or record payloads are printed.",
      }),
    );
    process.exitCode = 1;
  });
