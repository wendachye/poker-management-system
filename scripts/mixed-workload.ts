import { randomBytes } from "node:crypto";
import { availableParallelism, totalmem } from "node:os";
import { performance } from "node:perf_hooks";
import { Pool } from "pg";
import { hashPassword } from "../src/server/auth";
import { capacityDatabaseTarget } from "../src/server/capacity-target";
import { databaseFromPool } from "../src/server/database";
import { databasePoolOptions } from "../src/server/database-options";
import { verifyDatabaseIntegrity } from "../src/server/integrity";
import { readPage } from "../src/server/queries";
import { migrate } from "../src/server/schema";
import {
  errorCategory,
  invariant,
  mixedOptions,
  mixedLimits,
  mixedRunner,
  runMixedRaces,
  seedMixed,
  summarizeMeasurements,
  verifyMixedVenue,
  type Measurement,
} from "./mixed-workload-scenario";

// No .env loading and no DATABASE_URL fallback. Refuse the target before Pool.
async function main() {
  const target = capacityDatabaseTarget(process.env.POSTGRES_TEST_DATABASE_URL);
  const options = mixedOptions(process.env);
  const budgets = databasePoolOptions({
    DATABASE_URL: target.connectionString,
    PGOPTIONS: process.env.PGOPTIONS,
  });
  const schema = `poker_test_mixed_${randomBytes(8).toString("hex")}`;
  invariant(
    /^poker_test_mixed_[a-f0-9]{16}$/.test(schema),
    "owned-schema-identifier",
  );
  const pools: Pool[] = [];
  let idlePoolErrors = 0;
  const pool = (searchPath: string, max = budgets.max) => {
    const created = new Pool({
      connectionString: target.connectionString,
      ...budgets,
      max,
      options: `-c search_path=${searchPath}`,
      application_name: `poker-mixed-${schema}`,
    });
    created.on("error", () => {
      idlePoolErrors++;
    });
    pools.push(created);
    return created;
  };
  const admin = pool("pg_catalog", 1);
  let schemaCreated = false;
  let readers: Promise<unknown>[] = [];
  const stopReaders = new AbortController();
  let result: Record<string, unknown> | undefined;
  let failure: unknown;
  let cleanupFailure = false;
  const measurements: Measurement[] = [];
  try {
    const server = (
      await admin.query<{ name: string; version: string }>(
        "SELECT current_database() AS name,version() AS version",
      )
    ).rows[0];
    invariant(server.name === target.database, "test-database-identity");
    await admin.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    const workers = pool(schema);
    const db = databaseFromPool(workers);
    invariant(
      (await db.query<{ name: string }>("SELECT current_schema() AS name"))
        .rows[0].name === schema,
      "owned-search-path",
    );
    await migrate(db);
    const password = "fictional-mixed-workload-password";
    const venues = await seedMixed(
      db,
      options,
      password,
      await hashPassword(password),
    );
    // Fresh random fixture schemas have no planner statistics yet. Analyze only
    // this run's owned tables so before/after measurements use the same setup.
    const fixtureTables = (
      await workers.query<{ tablename: string }>(
        "SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename",
        [schema],
      )
    ).rows;
    for (const { tablename } of fixtureTables)
      await workers.query(
        `ANALYZE "${schema}"."${tablename.replaceAll('"', '""')}"`,
      );
    await verifyDatabaseIntegrity(db);
    const runner = mixedRunner(db, measurements);
    const workloadStarted = performance.now();
    readers = venues.flatMap((venue) =>
      venue.workers
        .slice(5)
        .map((worker) =>
          runner.readWorker(
            venue,
            worker,
            options.readRoundsPerReader,
            options.readPauseMs,
            stopReaders.signal,
          ),
        ),
    );
    // Observe rejection immediately while the writes are still running.
    const allReaders = Promise.allSettled(readers);
    const writes = await Promise.allSettled(
      venues.map(async (venue) => {
        await runner.send(venue, 0, {
          kind: "OPEN_DAY",
          date: "2026-01-02",
          openingCash: 1_000_000,
        });
        for (let cycle = 0; cycle < options.cycles; cycle++) {
          const lanes = await Promise.allSettled([
            runner.journey(venue, cycle, false),
            runner.journey(venue, cycle, true),
          ]);
          const failed = lanes.find((row) => row.status === "rejected");
          if (failed?.status === "rejected") throw failed.reason;
        }
      }),
    );
    const failedWrite = writes.find((row) => row.status === "rejected");
    if (failedWrite?.status === "rejected") throw failedWrite.reason;
    const mixedWriteDurationMs = performance.now() - workloadStarted;
    const raceFirst = pool(schema, 1),
      raceSecond = pool(schema, 1),
      holder = pool(schema, 1);
    const races = [];
    // Controlled races run sequentially, with their barrier latencies separated.
    for (const venue of venues)
      races.push(
        await runMixedRaces(db, holder, raceFirst, raceSecond, runner, venue),
      );
    const readResults = await allReaders;
    const failedRead = readResults.find((row) => row.status === "rejected");
    if (failedRead?.status === "rejected") throw failedRead.reason;
    const checks = [];
    for (const venue of venues) {
      const check = await verifyMixedVenue(
        db,
        venue,
        options.cycles,
        options.retainedEntriesPerVenue,
      );
      const other = venues.find((row) => row.id !== venue.id)!;
      let denied = false;
      try {
        await runner.measure(
          "read:other-venue-player",
          () =>
            readPage(db, venue.workers[0].token, {
              resource: "player",
              playerId: `${other.id}_profile_0`,
            }),
          "isolation",
          404,
        );
      } catch (error) {
        denied = errorCategory(error) === "HTTP_404";
        if (!denied) throw error;
      }
      invariant(denied, "other-venue-player-not-disclosed");
      await runner.send(venue, 0, {
        kind: "CLOSE_DAY",
        countedCash: check.expectedCashSen,
        reason: "",
      });
      const closed = await runner.snapshot(venue.workers[0]);
      const day = closed.store.days.find(
        (row) => row.id === closed.store.currentDayId,
      );
      invariant(
        day?.status === "CLOSED" &&
          day.closes.length === 1 &&
          day.closes[0].variance === 0,
        "final-close-exact",
      );
      const finalCheck = await verifyMixedVenue(
        db,
        venue,
        options.cycles,
        options.retainedEntriesPerVenue,
      );
      checks.push({ venue: venue.id, ...finalCheck, closed: true });
    }
    const integrity = await verifyDatabaseIntegrity(db);
    invariant(idlePoolErrors === 0, "no-idle-pool-errors");
    invariant(
      measurements.every((row) => row.outcome !== "error"),
      "no-unexpected-workload-errors",
    );
    result = {
      kind: "descriptive-local-mixed-financial-workload",
      status: "passed",
      generatedAt: new Date().toISOString(),
      target: {
        host: target.host,
        port: target.port,
        database: target.database,
      },
      platform: {
        node: process.version,
        logicalCpus: availableParallelism(),
        hostMemoryBytes: totalmem(),
        postgresql: server.version,
      },
      options,
      fixtureStatistics: { analyzedOwnedTables: fixtureTables.length },
      resourceCaps: mixedLimits,
      roleMixPerVenue: { admin: 1, manager: 3, cashier: 6 },
      databaseBudgets: budgets,
      connectionBudget: {
        ordinaryPoolMax: budgets.max,
        racePools: 3,
        ownerPoolMax: 1,
      },
      timing: {
        mixedWriteDurationMs: Number(mixedWriteDurationMs.toFixed(3)),
        scenarioWallDurationIncludingIntegrityMs: Number(
          (performance.now() - workloadStarted).toFixed(3),
        ),
      },
      measurements: summarizeMeasurements(measurements),
      races,
      checks,
      integrity,
      idlePoolErrors,
      retries: 0,
      boundaries: [
        "Native authenticated repository and read functions; excludes HTTP/TLS/browser/rendering.",
        "Closed-loop bounded sample workload, not sustained service throughput or production acceptance.",
        "Ten authenticated identities per venue; two financial lanes plus five polling/search readers; managers/admin perform independent decisions.",
        "Fixture setup, login, full-history integrity checks and teardown are not ordinary action timings.",
        "Deliberate race timings include an observed native row-lock barrier; only named race conflicts count as expected.",
        "Unexpected errors and ordinary financial conflicts fail; no blind financial conflict retry.",
        "Connections use the explicitly supplied disposable test identity, not a restricted application role acceptance test.",
        "No operations database, cloud resources or real records are used.",
      ],
    };
  } catch (error) {
    failure = error;
  } finally {
    stopReaders.abort();
    await Promise.allSettled(readers);
    const ended = await Promise.allSettled(
      pools.filter((item) => item !== admin).map((item) => item.end()),
    );
    cleanupFailure = ended.some((row) => row.status === "rejected");
    try {
      if (schemaCreated) {
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        schemaCreated = false;
      }
    } catch {
      cleanupFailure = true;
    }
    try {
      await admin.end();
    } catch {
      cleanupFailure = true;
    }
  }
  if (failure || cleanupFailure) {
    console.log(
      JSON.stringify(
        {
          kind: "descriptive-local-mixed-financial-workload",
          status: "failed",
          error: failure ? errorCategory(failure) : "CLEANUP_FAILED",
          measurements: summarizeMeasurements(measurements),
          idlePoolErrors,
          cleanup: {
            ownedSchemaRemoved: !schemaCreated,
            allPoolsClosed: !cleanupFailure,
          },
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  } else
    console.log(
      JSON.stringify(
        {
          ...result,
          cleanup: { ownedSchemaRemoved: true, allPoolsClosed: true },
        },
        null,
        2,
      ),
    );
}
main().catch((error) => {
  // Guard/configuration failures may occur before resources exist. Do not print
  // arbitrary pg errors or supplied URLs containing credentials.
  console.error(
    JSON.stringify({
      status: "failed",
      error: errorCategory(error),
      configuration:
        "Provide guarded MIXED_* values and an explicit disposable loopback POSTGRES_TEST_DATABASE_URL; PGOPTIONS is unsupported.",
    }),
  );
  process.exitCode = 1;
});
