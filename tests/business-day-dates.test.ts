import test from "node:test";
import assert from "node:assert/strict";
import { businessDayDates } from "../src/lib/business-day-dates";
import { applyCommand } from "../src/domain/operations";
import { currentDay } from "../src/domain/selectors";
import { configuredStore } from "./helpers/store";
import type { Staff } from "../src/domain/model";

const now = new Date("2026-10-21T10:00:00Z");
const timezone = "Asia/Kuala_Lumpur";

test("a manager can open and close successive days using each freshly initialized form date", () => {
  const manager: Staff = {
    id: "manager",
    username: "manager",
    role: "MANAGER",
    branchId: "local",
  };
  let store = configuredStore();
  for (const expected of ["2026-10-21", "2026-10-22", "2026-10-23"]) {
    const initial = businessDayDates(store.days, timezone, now);
    assert.equal(initial.defaultDate, expected);
    store = applyCommand(
      store,
      {
        kind: "OPEN_DAY",
        date: initial.defaultDate,
        openingCash: 1_036_000,
      },
      manager,
    );
    store = applyCommand(
      store,
      {
        kind: "CLOSE_DAY",
        dayId: currentDay(store)!.id,
        countedCash: 1_036_000,
        reason: "",
      },
      manager,
    );
  }
  assert.deepEqual(
    store.days.map((day) => day.date),
    ["2026-10-21", "2026-10-22", "2026-10-23"],
  );
});

test("opening a second business day on the same calendar date defaults to the next date", () => {
  assert.deepEqual(businessDayDates([{ date: "2026-10-21" }], timezone, now), {
    today: "2026-10-21",
    defaultDate: "2026-10-22",
    minDate: "2026-10-22",
  });
});

test("the latest recorded day controls opening even when history is unsorted or ahead of today", () => {
  const dates = businessDayDates(
    [{ date: "2026-11-05" }, { date: "2026-10-20" }],
    timezone,
    now,
  );
  assert.equal(dates.defaultDate, "2026-11-06");
  assert.equal(dates.minDate, "2026-11-06");
});

test("opening defaults to branch today when history is older and to today without history", () => {
  assert.deepEqual(businessDayDates([], timezone, now), {
    today: "2026-10-21",
    defaultDate: "2026-10-21",
    minDate: undefined,
  });
  assert.deepEqual(businessDayDates([{ date: "2026-10-02" }], timezone, now), {
    today: "2026-10-21",
    defaultDate: "2026-10-21",
    minDate: "2026-10-03",
  });
});

test("the next business date crosses month, year, leap-day and non-leap boundaries", () => {
  for (const [previous, expected] of [
    ["2026-10-31", "2026-11-01"],
    ["2026-12-31", "2027-01-01"],
    ["2028-02-28", "2028-02-29"],
    ["2028-02-29", "2028-03-01"],
    ["2027-02-28", "2027-03-01"],
  ]) {
    const dates = businessDayDates([{ date: previous }], timezone, now);
    assert.equal(dates.defaultDate, expected);
    assert.equal(dates.minDate, expected);
  }
});

test("branch midnight determines today independently of UTC and the host time zone", () => {
  const midnight = new Date("2026-10-21T16:30:00Z");
  assert.equal(
    businessDayDates([], timezone, midnight).defaultDate,
    "2026-10-22",
  );
  assert.equal(businessDayDates([], "UTC", midnight).defaultDate, "2026-10-21");
  assert.equal(
    businessDayDates([], "America/Los_Angeles", midnight).defaultDate,
    "2026-10-21",
  );
});
