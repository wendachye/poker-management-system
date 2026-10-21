import { test } from "node:test";
import assert from "node:assert/strict";
import { fieldError } from "../src/lib/form-validation";

test("forms reject blank required choices and whitespace-only reasons", () => {
  assert.ok(fieldError("", { required: true }));
  assert.ok(fieldError("   ", { required: true, minLength: 3 }));
  assert.ok(fieldError(" x ", { minLength: 3 }));
  assert.equal(
    fieldError("Seat correction", { required: true, minLength: 3 }),
    "",
  );
  assert.equal(fieldError("2026-10-02", { required: true, maxLength: -1 }), "");
});
test("money fields preserve exact decimal input and reject ambiguous formats", () => {
  for (const value of ["0", "12", "12.3", "12.30"])
    assert.equal(fieldError(value, { money: true, required: true }), "");
  for (const value of ["", "-1", "12.345", "1e3", "1,000", "abc"])
    assert.ok(fieldError(value, { money: true, required: true }));
});
test("minimum-length guidance reflects the field's required length", () => {
  assert.equal(
    fieldError("short", { minLength: 12 }),
    "Use at least 12 characters.",
  );
  assert.equal(fieldError("long-enough-password", { minLength: 12 }), "");
  assert.equal(
    fieldError("x", { minLength: 3 }),
    "Please provide at least three characters.",
  );
});
test("phone validation accepts the same international formatting as the server", () => {
  for (const value of ["+60123456789", "+60 (12) 345-6789"])
    assert.equal(fieldError(value, { phone: true, required: true }), "");
  for (const value of ["0123456789", "+0123456789", "+60abc56789"])
    assert.ok(fieldError(value, { phone: true, required: true }));
});

test("date fields reject impossible calendar dates and preserve required behavior", () => {
  for (const value of [
    "2026-02-29",
    "2026-02-30",
    "2026-13-01",
    "2026-10-00",
    "21/10/2026",
  ])
    assert.equal(fieldError(value, { date: true }), "Choose a valid date.");
  assert.equal(fieldError("2028-02-29", { date: true }), "");
  assert.equal(fieldError("", { date: true }), "");
  assert.equal(
    fieldError("", { date: true, required: true }),
    "This field is required.",
  );
});

test("date fields enforce inclusive form bounds before a business day is submitted", () => {
  const opening = { date: true, required: true, minDate: "2026-10-22" };
  assert.equal(
    fieldError("2026-10-21", opening),
    "Choose a date on or after the minimum allowed date.",
  );
  assert.equal(fieldError("2026-10-22", opening), "");
  assert.equal(fieldError("2026-10-23", opening), "");
  const bounded = { date: true, minDate: "2026-10-21", maxDate: "2026-10-31" };
  assert.equal(fieldError("2026-10-21", bounded), "");
  assert.equal(fieldError("2026-10-31", bounded), "");
  assert.equal(
    fieldError("2026-11-01", bounded),
    "Choose a date on or before the maximum allowed date.",
  );
});
