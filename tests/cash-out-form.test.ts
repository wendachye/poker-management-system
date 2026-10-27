import assert from "node:assert/strict";
import test from "node:test";
import { MAX_MONEY } from "../src/domain/money";
import { parseCashOutDraftAmount } from "../src/lib/cash-out-form";

test("a cash-out draft distinguishes an unset amount from an explicit zero", () => {
  assert.equal(parseCashOutDraftAmount(""), null);
  assert.equal(parseCashOutDraftAmount("   "), null);
  assert.equal(parseCashOutDraftAmount("0"), 0);
  assert.equal(parseCashOutDraftAmount("0.00"), 0);
});

test("cash-out drafts preserve exact sen without imposing buy-in increments", () => {
  assert.equal(parseCashOutDraftAmount("0.01"), 1);
  assert.equal(parseCashOutDraftAmount("500.05"), 50_005);
  assert.equal(parseCashOutDraftAmount(" 700.5 "), 70_050);
  assert.equal(parseCashOutDraftAmount("800"), 80_000);
});

test("malformed or out-of-range cash-out drafts cannot produce a payout preview", () => {
  for (const input of ["-1", "500.001", "1,000", "RM500", "NaN", "Infinity"])
    assert.equal(parseCashOutDraftAmount(input), null, input);
  assert.equal(parseCashOutDraftAmount(String(MAX_MONEY / 100)), MAX_MONEY);
  assert.equal(parseCashOutDraftAmount(String(MAX_MONEY / 100 + 1)), null);
});
