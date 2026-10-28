import assert from "node:assert/strict";
import test from "node:test";
import { MAX_MONEY } from "../src/domain/money";
import { creditRepaymentDraft } from "../src/lib/credit-repayment-form";

test("repayment drafts require an explicit positive cash amount", () => {
  for (const text of ["", " ", "0", "0.00", "-1", "500.001", "1,000", "NaN"])
    assert.deepEqual(creditRepaymentDraft(text, 70_000), {
      amount: null,
      exceedsDebt: false,
      valid: false,
      remainingDebt: null,
    });
});

test("partial and full repayment drafts retain exact sen without buy-in increments", () => {
  assert.deepEqual(creditRepaymentDraft("200.05", 70_000), {
    amount: 20_005,
    exceedsDebt: false,
    valid: true,
    remainingDebt: 49_995,
  });
  assert.equal(creditRepaymentDraft("0.01", 70_000).remainingDebt, 69_999);
  assert.equal(creditRepaymentDraft(" 700.00 ", 70_000).remainingDebt, 0);
});

test("repayments cannot exceed current debt or repay a settled account", () => {
  assert.deepEqual(creditRepaymentDraft("800", 70_000), {
    amount: 80_000,
    exceedsDebt: true,
    valid: false,
    remainingDebt: null,
  });
  assert.equal(creditRepaymentDraft("500", 70_000).valid, true);
  assert.equal(creditRepaymentDraft("500", 20_000).valid, false);
  assert.equal(creditRepaymentDraft("0.01", 0).valid, false);
});

test("repayment drafts use the same monetary cap as posted cash entries", () => {
  assert.equal(
    creditRepaymentDraft(String(MAX_MONEY / 100), MAX_MONEY).valid,
    true,
  );
  assert.equal(
    creditRepaymentDraft(String(MAX_MONEY / 100 + 1), MAX_MONEY).amount,
    null,
  );
});
