import "server-only";
import { createHash } from "node:crypto";
import { database, type SqlConnection } from "./database";
import {
  DATABASE_IDENTITY_KEYS,
  databasePoolIdentity,
} from "./database-identity";
import {
  healthOutcomeResponse,
  healthPreflight,
  probeHealth,
  type HealthEnvironment,
} from "./health";
import { createReadinessGate } from "./readiness-gate";

const configurationKeys = [
  ...DATABASE_IDENTITY_KEYS,
  "APP_ORIGIN",
  "NEXT_PUBLIC_POKER_PROTOTYPE",
  "POKER_PROTOTYPE_MODE",
] as const;

function snapshotEnvironment(env: HealthEnvironment): HealthEnvironment {
  const snapshot: Record<string, string | undefined> = {};
  for (const key of configurationKeys) {
    const value = env[key];
    if (value !== undefined && typeof value !== "string")
      throw new Error("Invalid readiness configuration.");
    snapshot[key] = value;
  }
  return Object.freeze(snapshot);
}
function signature(env: HealthEnvironment, keys: readonly string[]) {
  return createHash("sha256")
    .update(JSON.stringify(keys.map((key) => [key, env[key] ?? null])))
    .digest("hex");
}

/** One cache entry and underlying probe per service instance/warm app process. */
export function createReadinessService({
  connect = database,
  environment = () => process.env,
  ttlMs,
  deadlineMs,
}: {
  connect?: () => SqlConnection;
  environment?: () => HealthEnvironment;
  ttlMs?: number;
  deadlineMs?: number;
} = {}) {
  const gate = createReadinessGate({ ttlMs, deadlineMs });
  let activeConfiguration: string | undefined;
  let boundConnection: string | undefined;
  return async function readinessResponse() {
    let env: HealthEnvironment;
    let key: string;
    try {
      env = snapshotEnvironment(environment());
      key = signature(env, configurationKeys);
      if (key !== activeConfiguration) {
        gate.invalidate();
        activeConfiguration = key;
      }
    } catch {
      gate.invalidate();
      activeConfiguration = undefined;
      return healthOutcomeResponse({
        ready: false,
        mode: "operations",
        reason: "CONFIGURATION",
      });
    }
    const preflight = healthPreflight(env);
    if (preflight) return healthOutcomeResponse(preflight);

    // database() deliberately retains its existing pool. Never report a changed
    // runtime target/budget as checked through that old pool; restart to apply it.
    const connection = databasePoolIdentity(env);
    if (boundConnection !== undefined && boundConnection !== connection)
      return healthOutcomeResponse({
        ready: false,
        mode: "operations",
        reason: "CONFIGURATION",
      });
    boundConnection = connection;
    const outcome = await gate.read(key, () => probeHealth(connect, env));
    return healthOutcomeResponse(outcome);
  };
}
