import assert from "node:assert/strict";
import test from "node:test";
import { matchesListSearch } from "../src/lib/list-search";
import { filterRequests } from "../src/domain/request-filters";
import type { ApprovalRequest } from "../src/domain/model";
import { configuredStore } from "./helpers/store";

test("list search ignores case, accents and extra whitespace across fields", () => {
  assert.equal(
    matchesListSearch("  ALVAREZ\t jose   main ", [
      "José  Álvarez",
      "Main floor",
    ]),
    true,
  );
  assert.equal(matchesListSearch("grace low", ["Low Grace"]), true);
  assert.equal(
    matchesListSearch("cashier shortage", ["cashier.lee", "Cash shortage"]),
    true,
  );
  assert.equal(
    matchesListSearch("jose lounge", ["José Álvarez", "Main floor"]),
    false,
  );
  assert.equal(matchesListSearch("\t  ", []), true);
});

test("phone-only searches accept formatting and partial numbers in explicit phone fields", () => {
  assert.equal(
    matchesListSearch("+1 (202) 555-0110", ["Farid Aziz"], ["+12025550110"]),
    true,
  );
  assert.equal(
    matchesListSearch("202 555 0110", ["Farid Aziz"], ["+1-202-555-0110"]),
    true,
  );
  assert.equal(
    matchesListSearch("555-0110", ["Farid Aziz"], ["+12025550110"]),
    true,
  );
  assert.equal(
    matchesListSearch("farid 0110", ["Farid Aziz"], ["+12025550110"]),
    true,
  );
  assert.equal(
    matchesListSearch("555-0119", ["Farid Aziz"], ["+12025550110"]),
    false,
  );
});

test("numeric searches preserve references and do not join fragments across fields", () => {
  assert.equal(matchesListSearch("123456", ["APR-123-456"]), false);
  assert.equal(matchesListSearch("123-456", ["APR-123-456"]), true);
  assert.equal(matchesListSearch("APR123456", ["APR-123-456"]), false);
  assert.equal(matchesListSearch("123 456", ["APR-123", "note 456"]), false);
  assert.equal(matchesListSearch("(12)", [], ["+12025550110"]), false);
  assert.equal(matchesListSearch("APR-123-456", ["apr-123-456"]), true);
});

function request(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: "APR-123-456",
    dayId: "today",
    type: "Buy-in",
    amount: 50_000,
    playerId: "jose",
    tableId: "main",
    staff: "floor.cashier",
    note: "Chips at the counter",
    status: "PENDING",
    approvalLevel: "MANAGER",
    riskReason: "",
    requestedBy: "cashier.nadia",
    requestedById: "cashier",
    createdAt: "2026-10-26T04:00:00Z",
    votes: [],
    ...overrides,
  };
}

function fixture() {
  const store = configuredStore();
  store.profiles = [
    {
      id: "jose",
      name: "Sample · José Álvarez",
      phone: "+12025550110",
      type: "CASH",
      creditLimit: 0,
      tags: [],
    },
    {
      id: "mei",
      name: "Mei Lim",
      phone: "+12025550111",
      type: "CASH",
      creditLimit: 0,
      tags: [],
    },
  ];
  store.tables = [
    { id: "main", name: "Sample · Main floor", dealer: "", status: "OPEN" },
  ];
  store.approvals = [
    request(),
    request({ id: "other-day", dayId: "yesterday" }),
    request({ id: "other-type", type: "Cash-out" }),
    request({
      id: "other-owner",
      playerId: "mei",
      requestedById: "other-cashier",
      requestedBy: "cashier.raj",
    }),
    request({
      id: "approved",
      status: "APPROVED",
      decidedBy: "admin.cho",
      votes: [
        {
          staffId: "manager",
          username: "manager.lee",
          role: "MANAGER",
          time: "2026-10-26T04:05:00Z",
        },
      ],
    }),
    request({
      id: "rejected",
      status: "REJECTED",
      rejectionReason: "Duplicate counter slip",
    }),
  ];
  store.transactions = [
    {
      id: "TX-456-789",
      dayId: "today",
      type: "Buy-in",
      amount: 50_000,
      staff: "admin.cho",
      staffId: "admin",
      time: "2026-10-26T04:05:00Z",
      note: "Chips at the counter",
      approvalId: "approved",
      cashReceived: 50_000,
      cashPayout: 0,
      creditDelta: 0,
    },
  ];
  return store;
}

test("request search supports phone, type and terms across player, table and staff", () => {
  const store = fixture();
  const filter = { view: "PENDING" as const, dayId: "today", type: "Buy-in" };
  for (const query of [
    "+1 (202) 555-0110",
    "alvarez jose",
    "nadia jose main",
    "buy-in jose",
  ]) {
    assert.deepEqual(
      filterRequests(store, { ...filter, query }).map((r) => r.id),
      ["APR-123-456"],
    );
  }
  assert.deepEqual(filterRequests(store, { ...filter, query: "Sample" }), []);
  assert.deepEqual(
    filterRequests(store, { ...filter, query: "raj mei" }).map((r) => r.id),
    ["other-owner"],
  );
});

test("request search includes reviewers, rejection reasons and linked receipt references", () => {
  const store = fixture();
  for (const query of ["manager.lee main", "admin.cho", "TX-456-789"]) {
    assert.deepEqual(
      filterRequests(store, { view: "APPROVED", query }).map((r) => r.id),
      ["approved"],
    );
  }
  assert.deepEqual(
    filterRequests(store, { view: "APPROVED", query: "456789" }),
    [],
  );
  assert.deepEqual(
    filterRequests(store, { view: "REJECTED", query: "slip duplicate" }).map(
      (r) => r.id,
    ),
    ["rejected"],
  );
});

test("search cannot bypass day, status, type or My requests constraints", () => {
  const store = fixture();
  const query = "jose main";
  assert.deepEqual(
    filterRequests(store, {
      view: "PENDING",
      dayId: "today",
      type: "Buy-in",
      query,
    }).map((r) => r.id),
    ["APR-123-456"],
  );
  assert.deepEqual(
    filterRequests(store, { view: "PENDING", dayId: "yesterday", query }).map(
      (r) => r.id,
    ),
    ["other-day"],
  );
  assert.deepEqual(
    filterRequests(store, { view: "PENDING", type: "Cash-out", query }).map(
      (r) => r.id,
    ),
    ["other-type"],
  );
  assert.deepEqual(
    filterRequests(store, { view: "MINE", userId: "other-cashier", query }),
    [],
  );
  assert.deepEqual(
    filterRequests(store, {
      view: "MINE",
      userId: "other-cashier",
      query: "mei",
    }).map((r) => r.id),
    ["other-owner"],
  );
  assert.deepEqual(
    filterRequests(store, { view: "REJECTED", query }).map((r) => r.id),
    ["rejected"],
  );
});
