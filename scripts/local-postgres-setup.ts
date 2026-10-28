import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { Database, SqlConnection } from "../src/server/database";
import { migrate } from "../src/server/schema";
import { hashPassword } from "../src/server/auth";
import { replaceStore } from "../src/server/storage";
import { verifyDatabaseIntegrity } from "../src/server/integrity";
import { emptyStore } from "../src/domain/selectors";
import { defaultSettings } from "../src/domain/settings";
import type { Role, Staff } from "../src/domain/model";
import { buildSampleStore } from "./sample-data";

export const NATIVE_DATABASE = "poker_local_sample";
export const NATIVE_SCHEMA = "poker_local";
export const NATIVE_OWNER = "poker_local_owner";
export const NATIVE_APP = "poker_local_app";
export const NATIVE_BOOTSTRAP = "poker_local_bootstrap";
export const LOCAL_SAMPLE_PASSWORD = "local-test-password";
export const LOCAL_RUNTIME_LABEL = "postgres18-samples-v1";
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;

export function nativeLocalIdentity(root: string) {
  const normalized = resolve(root).replaceAll("\\", "/").toLowerCase();
  const workspace = createHash("sha256")
    .update(normalized)
    .digest("hex")
    .slice(0, 12);
  return {
    workspace,
    container: `poker-native-local-${workspace}`,
    volume: `poker-native-local-${workspace}-data`,
  };
}

export function assertNativeResource(
  detail: { Labels?: Record<string, string>; Name?: string },
  workspace: string,
  resource: "container" | "data",
) {
  if (
    detail.Labels?.["com.poker.local.runtime"] !== LOCAL_RUNTIME_LABEL ||
    detail.Labels?.["com.poker.local.workspace"] !== workspace ||
    detail.Labels?.["com.poker.local.resource"] !== resource
  )
    throw new Error(
      "An existing Docker resource has a different owner. It was preserved.",
    );
}

export type NativeLocalSecrets = {
  version: 1;
  workspace: string;
  bootstrapPassword: string;
  ownerPassword: string;
  appPassword: string;
};

export function assertNativeSecrets(
  value: unknown,
  workspace: string,
): asserts value is NativeLocalSecrets {
  if (!value || typeof value !== "object")
    throw new Error("Local PostgreSQL configuration is invalid.");
  const row = value as Partial<NativeLocalSecrets>;
  if (
    row.version !== 1 ||
    row.workspace !== workspace ||
    [row.bootstrapPassword, row.ownerPassword, row.appPassword].some(
      (secret) => typeof secret !== "string" || !/^[a-f0-9]{64}$/.test(secret),
    ) ||
    new Set([row.bootstrapPassword, row.ownerPassword, row.appPassword])
      .size !== 3
  )
    throw new Error(
      "Local PostgreSQL configuration does not match this workspace. Existing data was preserved.",
    );
}

async function grantApplication(connection: SqlConnection) {
  await connection.query(
    `GRANT USAGE ON SCHEMA ${quote(NATIVE_SCHEMA)} TO ${quote(NATIVE_APP)}`,
  );
  await connection.query(
    `GRANT SELECT ON ALL TABLES IN SCHEMA ${quote(NATIVE_SCHEMA)} TO ${quote(NATIVE_APP)}`,
  );
  await connection.query(
    `GRANT INSERT,UPDATE ON poker_branches,poker_users,poker_memberships,poker_branch_state,poker_profiles,poker_tables,poker_visits,poker_days,poker_approvals,poker_change_versions,poker_financial_totals,poker_login_budget TO ${quote(NATIVE_APP)}`,
  );
  await connection.query(
    `GRANT INSERT ON poker_ledger,poker_audit,poker_operations TO ${quote(NATIVE_APP)}`,
  );
  await connection.query(
    `GRANT INSERT,UPDATE,DELETE ON poker_sessions,poker_login_attempts TO ${quote(NATIVE_APP)}`,
  );
}

/** Trusted database seam; the launcher itself always supplies its guarded Docker
 * loopback connection. The optional database name supports embedded fixture tests.
 */
export async function initializeNativeSamples(
  db: Database,
  secrets: NativeLocalSecrets,
  now = new Date(),
  databaseName = NATIVE_DATABASE,
) {
  assertNativeSecrets(secrets, secrets.workspace);
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(databaseName))
    throw new Error("Invalid local database identity.");
  const roles: Role[] = ["ADMIN", "MANAGER", "CASHIER", "DEALER"];
  let created = false;
  await db.transaction(async (connection) => {
    const current = (
      await connection.query<{ database: string; version: string }>(
        "SELECT current_database() AS database,current_setting('server_version_num') AS version",
      )
    ).rows[0];
    if (
      current?.database !== databaseName ||
      Math.floor(Number(current.version) / 10_000) < 17
    )
      throw new Error(
        "The local sample launcher requires its exact PostgreSQL database (version 17 or newer).",
      );
    await connection.query("SELECT pg_advisory_xact_lock(1886350181, 8)");
    const existing = (
      await connection.query<{ present: boolean }>(
        "SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname=$1) AS present",
        [NATIVE_SCHEMA],
      )
    ).rows[0].present;
    if (existing) {
      const marker = (
        await connection.query<{ present: boolean }>(
          "SELECT to_regclass($1) IS NOT NULL AS present",
          [`${NATIVE_SCHEMA}.poker_local_runtime`],
        )
      ).rows[0].present;
      if (!marker)
        throw new Error(
          "Existing schema is not this launcher's sample database. No records were reset.",
        );
      const stored = (
        await connection.query<{ value: string }>(
          `SELECT value FROM ${quote(NATIVE_SCHEMA)}.poker_local_runtime WHERE key='workspace'`,
        )
      ).rows[0]?.value;
      if (stored !== secrets.workspace)
        throw new Error(
          "Sample database belongs to a different workspace. No records were changed.",
        );
    } else {
      const collisions = (
        await connection.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM pg_roles WHERE rolname=ANY($1::text[])",
          [[NATIVE_OWNER, NATIVE_APP]],
        )
      ).rows[0].count;
      if (collisions !== "0")
        throw new Error(
          "Local role names are already in use. Existing roles were preserved.",
        );
      for (const [role, password] of [
        [NATIVE_OWNER, secrets.ownerPassword],
        [NATIVE_APP, secrets.appPassword],
      ])
        await connection.query(
          `CREATE ROLE ${quote(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`,
        );
      await connection.query(
        `CREATE SCHEMA ${quote(NATIVE_SCHEMA)} AUTHORIZATION ${quote(NATIVE_OWNER)}`,
      );
      await connection.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
      await connection.query(
        `REVOKE CREATE ON DATABASE ${quote(databaseName)} FROM PUBLIC`,
      );
      for (const role of [NATIVE_OWNER, NATIVE_APP]) {
        await connection.query(
          `GRANT CONNECT ON DATABASE ${quote(databaseName)} TO ${quote(role)}`,
        );
        await connection.query(
          `ALTER ROLE ${quote(role)} IN DATABASE ${quote(databaseName)} SET search_path TO ${quote(NATIVE_SCHEMA)},pg_catalog`,
        );
      }
      created = true;
    }
    await connection.query(`SET LOCAL ROLE ${quote(NATIVE_OWNER)}`);
    await connection.query(
      `SET LOCAL search_path TO ${quote(NATIVE_SCHEMA)},pg_catalog`,
    );
    const transactional: Database = {
      ...connection,
      transaction: (work) => work(connection),
    };
    await migrate(transactional);
    if (created) {
      await connection.query(
        "CREATE TABLE poker_local_runtime(key text PRIMARY KEY,value text NOT NULL)",
      );
      await connection.query(
        "INSERT INTO poker_local_runtime(key,value) VALUES('workspace',$1)",
        [secrets.workspace],
      );
      const actors = {} as Record<
        "admin" | "manager" | "cashier" | "dealer",
        Staff
      >;
      for (const role of roles) {
        const key = role.toLowerCase() as keyof typeof actors;
        const id = `native-local-${key}`,
          username = `local.${key}`;
        await connection.query(
          "INSERT INTO poker_users(id,username,password_hash) VALUES($1,$2,$3)",
          [id, username, await hashPassword(LOCAL_SAMPLE_PASSWORD)],
        );
        actors[key] = { id, username, role, branchId: "local-sample" };
      }
      const sample = buildSampleStore(actors, now);
      const venueRules = {
        smallBlind: 500,
        bigBlind: 1_000,
        minBuyIn: 20_000,
        maxBuyIn: 500_000,
        buyInStep: 5_000,
        rakePercent: 5,
        rakeCap: 5_000,
        tipsPolicy: "Voluntary tips are recorded separately through approval.",
      };
      const reserveRules = {
        smallBlind: 1_000,
        bigBlind: 2_500,
        minBuyIn: 50_000,
        maxBuyIn: 1_000_000,
        buyInStep: 5_000,
      };
      sample.settings = {
        ...defaultSettings(),
        ...sample.settings,
        ...venueRules,
        venueName: "Local Sample Venue",
      };
      // Apply final current rules after the genuine historical fixture was built;
      // posted amounts and recorded approval policies remain unchanged.
      sample.tables = sample.tables.map((table) =>
        table.name.endsWith("Reserve") ? { ...table, ...reserveRules } : table,
      );
      const second = emptyStore();
      second.settings = {
        ...defaultSettings(),
        ...venueRules,
        venueName: "Second Sample Venue",
        setupCompleted: true,
      };
      second.tables = [
        {
          id: "second-main-floor",
          name: "Main floor",
          dealer: "",
          status: "OPEN",
        },
        {
          id: "second-reserve",
          name: "Reserve",
          dealer: "",
          status: "OPEN",
          ...reserveRules,
        },
      ];
      for (const [id, name, store] of [
        ["local-sample", "Local Sample Venue", sample],
        ["local-second", "Second Sample Venue", second],
      ] as const) {
        await connection.query(
          "INSERT INTO poker_branches(id,name,timezone) VALUES($1,$2,'Asia/Kuala_Lumpur')",
          [id, name],
        );
        await replaceStore(connection, id, store, 0);
        for (const actor of Object.values(actors))
          await connection.query(
            "INSERT INTO poker_memberships(user_id,branch_id,role) VALUES($1,$2,$3)",
            [actor.id, id, actor.role],
          );
      }
    }
    await grantApplication(connection);
  });
  return {
    created,
    users: roles.map((role) => ({
      username: `local.${role.toLowerCase()}`,
      role,
    })),
  };
}

export async function verifyNativeSamples(db: Database) {
  return verifyDatabaseIntegrity(db);
}
