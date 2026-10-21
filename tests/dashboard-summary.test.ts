import test from "node:test";
import assert from "node:assert/strict";
import { dashboardSummary } from "../src/domain/dashboard-summary";
import { emptyStore } from "../src/domain/selectors";
import type {
  ApprovalRequest,
  Day,
  Store,
  Transaction,
} from "../src/domain/model";

function day(id: string, date: string, status: Day["status"] = "CLOSED"): Day {
  return {
    id,
    date,
    status,
    openedAt: `${date}T00:00:00Z`,
    openingCash: 100_000,
    closes: [],
  };
}
function tx(
  id: string,
  dayId: string,
  fields: Partial<Transaction> = {},
): Transaction {
  return {
    id,
    dayId,
    type: "Cash Received",
    amount: 0,
    staff: "Cashier",
    staffId: "cashier",
    cashReceived: 0,
    cashPayout: 0,
    creditDelta: 0,
    time: "2026-10-21T01:00:00Z",
    note: "Dashboard source record",
    approvalId: `request-${id}`,
    ...fields,
  };
}
function request(
  id: string,
  dayId: string,
  approvalLevel: ApprovalRequest["approvalLevel"],
  status: ApprovalRequest["status"] = "PENDING",
): ApprovalRequest {
  return {
    id,
    dayId,
    approvalLevel,
    status,
    type: "Cash Received",
    amount: 100_000,
    staff: "Cashier",
    note: "Unposted cash must not affect dashboard totals",
    riskReason: "Independent review",
    requestedBy: "Cashier",
    requestedById: "cashier",
    createdAt: "2026-10-21T01:00:00Z",
    votes: [],
  };
}

test("dashboard cash uses posted flows and reversals while credit includes previous business days", () => {
  const store: Store = {
    ...emptyStore(),
    currentDayId: "current",
    days: [day("previous", "2026-10-20"), day("current", "2026-10-21", "OPEN")],
    transactions: [
      tx("old-credit", "previous", {
        type: "Buy-in",
        amount: 80_000,
        creditDelta: 80_000,
      }),
      tx("new-credit", "current", {
        type: "Buy-in",
        amount: 20_000,
        creditDelta: 20_000,
      }),
      tx("repayment", "current", {
        type: "Credit Repayment",
        amount: 5_000,
        cashReceived: 5_000,
        creditDelta: -5_000,
      }),
      tx("cash-first", "current", {
        type: "Buy-in",
        amount: 25_000,
        cashReceived: 25_000,
      }),
      tx("cash-second", "current", {
        type: "Buy-in",
        amount: 50_000,
        cashReceived: 50_000,
      }),
      tx("reversal", "current", {
        type: "Reversal",
        amount: -25_000,
        cashReceived: -25_000,
        reversesId: "cash-first",
      }),
      tx("payout", "current", {
        type: "Cash-out",
        amount: 15_000,
        cashPayout: 15_000,
      }),
    ],
    approvals: [request("pending", "current", "ADMIN")],
  };
  const summary = dashboardSummary(store);
  assert.equal(summary.cashReceived, 55_000);
  assert.equal(summary.cashPayout, 15_000);
  assert.equal(summary.netCash, 40_000);
  assert.equal(summary.expectedCash, 140_000);
  assert.equal(summary.outstandingCredit, 95_000);
  assert.equal(
    summary.trend[0].netCash,
    0,
    "credit buy-ins are not cash receipts",
  );
  assert.equal(summary.trend[1].provisional, true);
});

test("seat utilization excludes closed tables and previous-day sessions", () => {
  const store = emptyStore();
  store.currentDayId = "current";
  store.days = [day("current", "2026-10-21", "OPEN")];
  store.tables = [
    { id: "main", name: "Main floor", dealer: "", status: "OPEN" },
    { id: "reserve", name: "Reserve", dealer: "", status: "OPEN" },
    { id: "training", name: "Training", dealer: "", status: "CLOSED" },
  ];
  store.sessions = [
    {
      id: "a",
      playerId: "a",
      dayId: "current",
      tableId: "main",
      seat: 1,
      status: "ACTIVE",
      sessionStart: "2026-10-21T00:00:00Z",
    },
    {
      id: "b",
      playerId: "b",
      dayId: "current",
      tableId: "main",
      seat: 2,
      status: "ACTIVE",
      sessionStart: "2026-10-21T00:00:00Z",
    },
    {
      id: "c",
      playerId: "c",
      dayId: "current",
      tableId: "reserve",
      seat: 1,
      status: "ACTIVE",
      sessionStart: "2026-10-21T00:00:00Z",
    },
    {
      id: "old",
      playerId: "old",
      dayId: "previous",
      tableId: "main",
      seat: 3,
      status: "ACTIVE",
      sessionStart: "2026-10-20T00:00:00Z",
    },
    {
      id: "out",
      playerId: "out",
      dayId: "current",
      tableId: "reserve",
      seat: 2,
      status: "OUT",
      sessionStart: "2026-10-21T00:00:00Z",
    },
  ];
  const summary = dashboardSummary(store);
  assert.equal(summary.activePlayers, 3);
  assert.equal(summary.occupied, 3);
  assert.equal(summary.capacity, 18);
  assert.equal(summary.utilization, 17);
  assert.equal(summary.closedTables, 1);
  assert.deepEqual(
    summary.occupancy.map((table) => [table.name, table.occupied]),
    [
      ["Main floor", 2],
      ["Reserve", 1],
    ],
  );
});

test("pending attention counts only current unresolved requests, including both admin review levels", () => {
  const store = emptyStore();
  store.currentDayId = "current";
  store.days = [day("current", "2026-10-21", "OPEN")];
  store.approvals = [
    request("manager", "current", "MANAGER"),
    request("admin", "current", "ADMIN"),
    request("dual", "current", "DUAL"),
    request("posted", "current", "ADMIN", "APPROVED"),
    request("rejected", "current", "ADMIN", "REJECTED"),
    request("old", "previous", "ADMIN"),
  ];
  assert.equal(dashboardSummary(store).pending, 3);
  assert.equal(dashboardSummary(store).adminReview, 2);
});

test("recent trends preserve only seven recorded dates and retain negative flows without filling missing dates", () => {
  const store = emptyStore();
  const dates = ["01", "03", "04", "06", "08", "09", "12", "20", "21"];
  store.days = dates
    .map((date) =>
      day(date, `2026-10-${date}`, date === "21" ? "OPEN" : "CLOSED"),
    )
    .reverse();
  store.currentDayId = "21";
  store.transactions = [
    tx("negative", "20", {
      type: "Cash Payout",
      amount: 5_000,
      cashPayout: 5_000,
    }),
  ];
  const before = structuredClone(store);
  const summary = dashboardSummary(store);
  assert.deepEqual(
    summary.trend.map((entry) => entry.date),
    dates.slice(-7).map((date) => `2026-10-${date}`),
  );
  assert.equal(
    summary.trend.find((entry) => entry.id === "20")!.netCash,
    -5_000,
  );
  assert.equal(
    summary.trend.find((entry) => entry.id === "21")!.provisional,
    true,
  );
  assert.equal(
    summary.trend.some((entry) => entry.date === "2026-10-05"),
    false,
  );
  assert.deepEqual(
    store,
    before,
    "building analytics must not reorder the saved day history",
  );
});

test("an empty venue reports no utilization or invented business-day trend", () => {
  const summary = dashboardSummary(emptyStore());
  assert.equal(summary.day, undefined);
  assert.equal(summary.utilization, null);
  assert.equal(summary.capacity, 0);
  assert.equal(summary.activePlayers, 0);
  assert.equal(summary.outstandingCredit, 0);
  assert.deepEqual(summary.trend, []);
});
