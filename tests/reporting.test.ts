import test from "node:test";
import assert from "node:assert/strict";
import {
  rangeReport,
  compareReports,
  reportPreset,
} from "../src/domain/reporting";
import { emptyStore, totalsForDay } from "../src/domain/selectors";
import { buildSampleStore } from "../scripts/sample-data";

test("calendar presets and comparison intervals handle month ends and leap years", () => {
  assert.deepEqual(reportPreset("last-month", "2024-03-15"), {
    from: "2024-02-01",
    to: "2024-02-29",
  });
  assert.deepEqual(reportPreset("week", "2026-01-03"), {
    from: "2025-12-28",
    to: "2026-01-03",
  });
  assert.deepEqual(reportPreset("month", "2026-10-06"), {
    from: "2026-10-01",
    to: "2026-10-06",
  });
  const reports = compareReports(emptyStore(), "2024-03-01", "2024-03-07");
  assert.equal(reports.previous.from, "2024-02-23");
  assert.equal(reports.previous.to, "2024-02-29");
  assert.equal(reports.current.unrecordedDays, 7);
  assert.equal(reports.current.variance, null);
});
test("invalid, inverted, and excessive date ranges are rejected", () => {
  for (const [from, to] of [
    ["2026-02-30", "2026-03-03"],
    ["", "2026-03-03"],
    ["2026-10-02", "2026-10-01"],
    ["2024-01-01", "2026-01-01"],
  ])
    assert.throws(() => rangeReport(emptyStore(), from, to));
});
test("period totals sum posted cash flows and compensating entries without adding daily balances", () => {
  const actors = Object.fromEntries(
    ["admin", "manager", "cashier", "dealer"].map((name) => [
      name,
      { id: name, username: name, role: name.toUpperCase(), branchId: "local" },
    ]),
  );
  const store = buildSampleStore(
    actors as Parameters<typeof buildSampleStore>[0],
    new Date("2026-10-02T15:00:00Z"),
  );
  const report = rangeReport(store, "2026-09-30", "2026-10-06");
  assert.equal(report.days.length, 3);
  assert.equal(report.openDays, 1);
  assert.equal(report.unrecordedDays, 4);
  assert.equal(report.pendingRequests, 5);
  assert.equal(report.countedDays, 2);
  assert.equal(report.variance, -2500);
  assert.equal(
    report.totals.cashReceived,
    store.transactions.reduce((sum, tx) => sum + tx.cashReceived, 0),
  );
  assert.equal(
    report.totals.netCash,
    report.totals.cashReceived - report.totals.cashPayout,
  );
  assert.equal("expectedCash" in report.totals, false);
  assert.equal("openingCash" in report.totals, false);
  assert.equal(
    report.totals.rake,
    store.days.reduce((sum, d) => sum + totalsForDay(store, d.id).rake, 0),
  );
  const single = rangeReport(store, "2026-10-02", "2026-10-02");
  assert.equal(single.variance, null);
  assert.equal(single.days.length, 1);
});
