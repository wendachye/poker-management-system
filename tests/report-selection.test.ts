import test from "node:test";
import assert from "node:assert/strict";
import { reportDateInput, reportSelection } from "../src/lib/report-selection";
import { readQueryParams } from "../src/lib/read-page";

test("a historical report selection survives filtering and current-day refreshes", () => {
  const selected = reportSelection("2026-10-20", "", "current-day");
  for (const query of ["", "nobody-matches-this"]) {
    const params = readQueryParams({ resource: "report", ...selected, query });
    assert.equal(params.get("date"), "2026-10-20");
    assert.equal(params.has("dayId"), false);
  }
  assert.equal(
    reportDateInput("2026-10-20", undefined, "2026-10-21"),
    "2026-10-20",
  );
});

test("clearing a native report date does not restore the current day during editing", () => {
  assert.equal(reportDateInput("", "2026-10-21", "2026-10-21"), "");
  assert.equal(
    reportDateInput(undefined, "2026-10-20", "2026-10-21"),
    "2026-10-20",
  );
  assert.equal(
    reportDateInput(undefined, undefined, "2026-10-21"),
    "2026-10-21",
  );
});

test("clearing the date override permits explicit or current day selection", () => {
  assert.deepEqual(reportSelection(undefined, "older-day", "current-day"), {
    dayId: "older-day",
  });
  assert.deepEqual(reportSelection(undefined, "", "current-day"), {
    dayId: "current-day",
  });
});
