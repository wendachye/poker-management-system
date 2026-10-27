import assert from "node:assert/strict";
import test from "node:test";
import { closingCashDraft } from "../src/lib/closing-cash-draft";

test("closing never treats an empty or invalid cash count as zero", () => {
  for (const count of ["", " ", "-1", "10.001", "1,000", "NaN"])
    assert.deepEqual(closingCashDraft(count, 100_000, "Count reviewed"), {
      countedCash: null,
      variance: null,
      requiresExplanation: false,
      valid: false,
    });
  assert.equal(closingCashDraft("0", 0, "").valid, true);
});

test("matching physical counts need no difference explanation", () => {
  assert.deepEqual(closingCashDraft("19975.00", 1_997_500, ""), {
    countedCash: 1_997_500,
    variance: 0,
    requiresExplanation: false,
    valid: true,
  });
});

test("cash shortages and overages require a meaningful trimmed explanation", () => {
  for (const [count, variance] of [
    ["19965", -1000],
    ["19985", 1000],
  ] as const) {
    for (const explanation of ["", " ", "  ab  "])
      assert.deepEqual(closingCashDraft(count, 1_997_500, explanation), {
        countedCash: Number(count) * 100,
        variance,
        requiresExplanation: true,
        valid: false,
      });
    assert.equal(
      closingCashDraft(count, 1_997_500, "  Count reviewed  ").valid,
      true,
    );
  }
});

test("zero is an explicit valid count and cash differences retain exact sen", () => {
  assert.deepEqual(closingCashDraft("0.00", 105, "Empty drawer"), {
    countedCash: 0,
    variance: -105,
    requiresExplanation: true,
    valid: true,
  });
  assert.equal(closingCashDraft("1.04", 105, "One sen short").variance, -1);
  assert.equal(closingCashDraft("1.06", 105, "One sen over").variance, 1);
  assert.equal(closingCashDraft("1.06", 105, "x".repeat(501)).valid, false);
});
