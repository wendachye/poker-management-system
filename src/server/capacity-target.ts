type Environment = Readonly<Record<string, string | undefined>>;

export const capacityLimits = {
  venues: 5,
  staffPerVenue: 10,
  totalWorkers: 50,
  retainedEntriesPerVenue: 20_000,
  scenarios: 3,
  playerProfilesPerVenue: 1_000,
  readRounds: 3,
  mutationAttempts: 3,
} as const;

/** This harness never accepts the operations DATABASE_URL or a remote database. */
export function capacityDatabaseTarget(value: string | undefined) {
  const message =
    "POSTGRES_TEST_DATABASE_URL must explicitly name a loopback PostgreSQL database poker_test or poker_test_* without connection query overrides.";
  let url: URL;
  try {
    if (!value) throw new Error();
    url = new URL(value);
  } catch {
    throw new Error(message);
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    !/^\/poker_test(?:_[a-z0-9_]+)?$/.test(url.pathname) ||
    url.search ||
    url.hash
  )
    throw new Error(message);
  return {
    connectionString: value!,
    database: url.pathname.slice(1),
    host: url.hostname,
    port: Number(url.port || "5432"),
  };
}

function bounded(
  env: Environment,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const number = Number(raw);
  if (
    !/^\d+$/.test(raw) ||
    !Number.isSafeInteger(number) ||
    number < minimum ||
    number > maximum
  )
    throw new Error(
      `${name} must be an integer from ${minimum} to ${maximum}.`,
    );
  return number;
}

export function capacityOptions(env: Environment = process.env) {
  const rawEntries = env.CAPACITY_ENTRY_COUNTS ?? "1000,10000";
  const entries = rawEntries.split(",").map((raw) => {
    const number = Number(raw);
    if (
      !/^\d+$/.test(raw) ||
      !Number.isSafeInteger(number) ||
      number < 1 ||
      number > capacityLimits.retainedEntriesPerVenue
    )
      throw new Error(
        "CAPACITY_ENTRY_COUNTS must list 1-20000 retained ledger entries per venue.",
      );
    return number;
  });
  if (
    entries.length > capacityLimits.scenarios ||
    new Set(entries).size !== entries.length
  )
    throw new Error("CAPACITY_ENTRY_COUNTS supports 1-3 distinct scenarios.");
  const venues = bounded(env, "CAPACITY_VENUES", 5, 1, capacityLimits.venues);
  const staffPerVenue = bounded(
    env,
    "CAPACITY_STAFF_PER_VENUE",
    10,
    2,
    capacityLimits.staffPerVenue,
  );
  return {
    venues,
    staffPerVenue,
    workers: venues * staffPerVenue,
    retainedEntryScenarios: entries,
    playerProfilesPerVenue: bounded(
      env,
      "CAPACITY_PLAYER_PROFILES",
      100,
      1,
      capacityLimits.playerProfilesPerVenue,
    ),
    readRounds: bounded(
      env,
      "CAPACITY_READ_ROUNDS",
      1,
      1,
      capacityLimits.readRounds,
    ),
    mutationAttempts: bounded(
      env,
      "CAPACITY_MUTATION_ATTEMPTS",
      3,
      1,
      capacityLimits.mutationAttempts,
    ),
  };
}

/** Nearest-rank percentiles; empty samples are unknown, not zero latency. */
export function latencySummary(values: number[]) {
  if (values.some((value) => !Number.isFinite(value) || value < 0))
    throw new Error("Latency samples must be finite nonnegative milliseconds.");
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (fraction: number) =>
    sorted.length
      ? Number(sorted[Math.ceil(sorted.length * fraction) - 1].toFixed(3))
      : null;
  return {
    samples: sorted.length,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    maxMs: percentile(1),
  };
}
