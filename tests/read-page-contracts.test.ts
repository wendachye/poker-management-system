import test from "node:test";
import assert from "node:assert/strict";
import type { ReadPage } from "../src/domain/read-model";
import { emptyStore } from "../src/domain/selectors";
import { readPageReceipt, readQueryParams } from "../src/lib/read-page";
import { ManagementResponseError } from "../src/lib/management-response";

function fixture(): ReadPage<{ id: string }> {
  return {
    branchId: "venue",
    revision: 4,
    items: [{ id: "profile" }],
    total: 41,
    page: 1,
    pageSize: 20,
    counts: { ALL: 41, ACTIVE: 5, OUT: 36 },
    context: {
      revision: 4,
      branch: {
        id: "venue",
        name: "Venue",
        timezone: "Asia/Kuala_Lumpur",
        role: "MANAGER",
      },
      user: {
        id: "staff",
        username: "staff",
        role: "MANAGER",
        branchId: "venue",
      },
      store: emptyStore(),
    },
  };
}
test("server pages retain complete counts without expanding their bounded rows", () => {
  const original = fixture();
  const page = readPageReceipt<{ id: string }>(
    JSON.parse(JSON.stringify(original)),
  );
  assert.equal(page.total, 41);
  assert.equal(page.items.length, 1);
  assert.equal(page.page, 1);
  assert.deepEqual(page.context, original.context);
});
test("a paginated receipt cannot cross venues or disagree with its snapshot revision", () => {
  for (const mutate of [
    (page: ReadPage<{ id: string }>) => {
      page.branchId = "other";
    },
    (page: ReadPage<{ id: string }>) => {
      page.revision = 5;
    },
    (page: ReadPage<{ id: string }>) => {
      page.context.user.branchId = "other";
    },
  ]) {
    const page = fixture();
    mutate(page);
    assert.throws(
      () => readPageReceipt(page),
      (error: unknown) =>
        error instanceof ManagementResponseError && error.uncertain,
    );
  }
});
test("pagination contracts reject unbounded rows, invalid counts and invalid page budgets", () => {
  for (const patch of [
    { total: -1 },
    { total: Number.MAX_SAFE_INTEGER + 1 },
    { page: -1 },
    { pageSize: 0 },
    { pageSize: 51 },
    { pageSize: 1, items: [{}, {}] },
    { counts: { ALL: -1 } },
    { counts: [] },
    { items: null },
  ]) {
    assert.throws(
      () => readPageReceipt({ ...fixture(), ...patch }),
      ManagementResponseError,
    );
  }
});
test("empty filters are omitted while zero-based pages and encoded searches survive", () => {
  const params = readQueryParams({
    resource: "requests",
    page: 0,
    pageSize: 20,
    dayId: "",
    type: "",
    query: "Alex +6012 & VIP",
    status: "PENDING",
  });
  assert.equal(params.has("dayId"), false);
  assert.equal(params.has("type"), false);
  assert.equal(params.get("page"), "0");
  assert.equal(params.get("query"), "Alex +6012 & VIP");
  assert.equal(params.get("status"), "PENDING");
});
