import assert from "node:assert/strict";
import test from "node:test";
import {
  buyInQuickAmounts,
  matchesSearchChoice,
  validBuyInDraftAmount,
} from "../src/lib/operation-form-options";

test("player picker matches formatted phones and reordered names without changing identity", () => {
  const choices = [
    {
      value: "player-grace",
      label: "Grace Low · +12025550111",
      phoneNumbers: ["+12025550111"],
    },
    {
      value: "player-farid",
      label: "Farid Aziz · +12025550110",
      phoneNumbers: ["+12025550110"],
    },
  ];
  assert.deepEqual(
    choices
      .filter((option) => matchesSearchChoice(option, "+1 (202) 555-0111"))
      .map((option) => option.value),
    ["player-grace"],
  );
  assert.deepEqual(
    choices
      .filter((option) => matchesSearchChoice(option, " low   GRACE "))
      .map((option) => option.value),
    ["player-grace"],
  );
  assert.equal(matchesSearchChoice(choices[1], "player-farid"), true);
});

test("only explicit phone fields drop separators in player picker searches", () => {
  const reference = { value: "123-456", label: "Alex Tan" };
  assert.equal(matchesSearchChoice(reference, "123456"), false);
  assert.equal(matchesSearchChoice(reference, "123 456"), false);
  assert.equal(matchesSearchChoice(reference, "123-456"), true);
  assert.equal(
    matchesSearchChoice({ ...reference, phoneNumbers: ["+123456"] }, "123 456"),
    true,
  );
  assert.equal(
    matchesSearchChoice(
      { value: "jose", label: "José Álvarez", searchTerms: ["VIP"] },
      "alvarez vip",
    ),
    true,
  );
});

test("common buy-in amounts follow table increments and the effective credit cap", () => {
  assert.deepEqual(
    buyInQuickAmounts(20_000, 500_000, 10_000),
    [50_000, 100_000],
  );
  assert.deepEqual(buyInQuickAmounts(20_000, 80_000, 5_000), [50_000]);
  assert.deepEqual(buyInQuickAmounts(20_000, 35_000, 5_000), []);
  assert.deepEqual(buyInQuickAmounts(20_000, 500_000, 20_000), [100_000]);
  assert.deepEqual(buyInQuickAmounts(50_000, 100_000, 10_000), []);
  assert.deepEqual(buyInQuickAmounts(20_000, 10_000, 10_000), []);
});

test("buy-in summaries accept only positive whole-sen amounts within the allowed range", () => {
  const valid = (amount: number) =>
    validBuyInDraftAmount(amount, 20_000, 75_000, 5_000);
  assert.equal(valid(0), false);
  assert.equal(valid(-1), false);
  assert.equal(valid(Number.NaN), false);
  assert.equal(valid(50_000.5), false);
  assert.equal(valid(15_000), false);
  assert.equal(valid(80_000), false);
  assert.equal(valid(52_000), false);
  assert.equal(valid(20_000), true);
  assert.equal(valid(50_000), true);
  assert.equal(valid(75_000), true);
  assert.equal(validBuyInDraftAmount(20_001, 1, 50_000, 0), true);
});
