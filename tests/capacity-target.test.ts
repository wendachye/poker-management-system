import { test } from "node:test";
import assert from "node:assert/strict";
import {
  capacityDatabaseTarget,
  capacityLimits,
  capacityOptions,
  latencySummary,
} from "../src/server/capacity-target";

test("capacity scenarios explicitly assume volumes and bound concurrency", () => {
  const options = capacityOptions({});
  assert.equal(options.venues, 5);
  assert.equal(options.staffPerVenue, 10);
  assert.equal(options.workers, 50);
  assert.equal(options.readRounds, 1);
  assert.deepEqual(options.retainedEntryScenarios, [1000, 10000]);
  assert.equal(options.playerProfilesPerVenue, 100);
  assert.equal(options.mutationAttempts, 3);
  assert.ok(options.workers <= capacityLimits.totalWorkers);
  assert.deepEqual(
    capacityOptions({
      CAPACITY_VENUES: "2",
      CAPACITY_STAFF_PER_VENUE: "2",
      CAPACITY_ENTRY_COUNTS: "10,100",
    }).retainedEntryScenarios,
    [10, 100],
  );
});

test("capacity target permits only explicitly named loopback test databases", () => {
  for (const host of ["localhost", "127.0.0.1", "[::1]"])
    for (const name of ["poker_test", "poker_test_capacity"])
      assert.equal(
        capacityDatabaseTarget(`postgresql://test:secret@${host}:55434/${name}`)
          .database,
        name,
      );
  for (const value of [
    undefined,
    "",
    "not-a-url",
    "postgresql://localhost/poker",
    "postgresql://database.example.com/poker_test",
    "https://localhost/poker_test",
    "postgresql://localhost/poker_test?options=-c%20search_path=public",
    "postgresql://localhost/poker_test#fragment",
    "postgresql://127.1/poker_test",
    "postgresql://localhost/poker_test_other/path",
    "postgresql://localhost/poker_test_",
  ])
    assert.throws(
      () => capacityDatabaseTarget(value),
      /POSTGRES_TEST_DATABASE_URL/,
    );
});

test("capacity target guard errors never print supplied credentials", () => {
  const secret = "must-not-print-credential";
  try {
    capacityDatabaseTarget(
      `postgresql://test:${secret}@database.example.com/poker_test`,
    );
    assert.fail("Expected guard rejection");
  } catch (error) {
    assert.ok(error instanceof Error);
    assert.equal(error.message.includes(secret), false);
  }
});

test("capacity configuration rejects record and concurrency allocations outside hard caps", () => {
  for (const [name, value] of [
    ["CAPACITY_VENUES", "6"],
    ["CAPACITY_VENUES", "0"],
    ["CAPACITY_VENUES", "-1"],
    ["CAPACITY_STAFF_PER_VENUE", "11"],
    ["CAPACITY_STAFF_PER_VENUE", "1"],
    ["CAPACITY_PLAYER_PROFILES", "1001"],
    ["CAPACITY_PLAYER_PROFILES", "NaN"],
    ["CAPACITY_READ_ROUNDS", "4"],
    ["CAPACITY_MUTATION_ATTEMPTS", "4"],
    ["CAPACITY_ENTRY_COUNTS", "20001"],
    ["CAPACITY_ENTRY_COUNTS", "0"],
    ["CAPACITY_ENTRY_COUNTS", "1,2,3,4"],
    ["CAPACITY_ENTRY_COUNTS", "10,10"],
    ["CAPACITY_ENTRY_COUNTS", "1000,"],
    ["CAPACITY_ENTRY_COUNTS", "1000, 10000"],
  ])
    assert.throws(() => capacityOptions({ [name]: value }), new RegExp(name));
});

test("latency summary uses nearest-rank percentiles without mutating samples", () => {
  const samples = [
    20, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
  ];
  assert.deepEqual(latencySummary(samples), {
    samples: 20,
    p50Ms: 10,
    p95Ms: 19,
    maxMs: 20,
  });
  assert.equal(samples[0], 20);
  assert.deepEqual(latencySummary([]), {
    samples: 0,
    p50Ms: null,
    p95Ms: null,
    maxMs: null,
  });
  assert.deepEqual(latencySummary([1.23456]), {
    samples: 1,
    p50Ms: 1.235,
    p95Ms: 1.235,
    maxMs: 1.235,
  });
  for (const value of [NaN, Infinity, -1])
    assert.throws(() => latencySummary([value]), /finite nonnegative/);
});
