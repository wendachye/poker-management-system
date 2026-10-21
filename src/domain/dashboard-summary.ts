import type { Store } from "./model";
import { currentDay, totalsForDay } from "./selectors";

export function dashboardSummary(store: Store) {
  const day = currentDay(store);
  const active = store.sessions.filter(
    (session) => session.dayId === day?.id && session.status === "ACTIVE",
  );
  const occupancy = store.tables
    .filter((table) => table.status === "OPEN")
    .map((table) => ({
      id: table.id,
      name: table.name,
      occupied: active.filter((session) => session.tableId === table.id).length,
      capacity: 9,
    }));
  const capacity = occupancy.length * 9;
  const occupied = occupancy.reduce((sum, table) => sum + table.occupied, 0);
  const totals = totalsForDay(store);
  const pending = store.approvals.filter(
    (request) => request.dayId === day?.id && request.status === "PENDING",
  );
  // Use recorded business dates, rather than inventing zero activity on missing days.
  const trend = [...store.days]
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-7)
    .map((recordedDay) => {
      const daily = totalsForDay(store, recordedDay.id);
      return {
        id: recordedDay.id,
        date: recordedDay.date,
        provisional: recordedDay.status === "OPEN",
        cashReceived: daily.cashReceived,
        cashPayout: daily.cashPayout,
        netCash: daily.cashReceived - daily.cashPayout,
      };
    });
  return {
    day,
    activePlayers: active.length,
    occupancy,
    occupied,
    capacity,
    utilization: capacity ? Math.round((occupied / capacity) * 100) : null,
    closedTables: store.tables.length - occupancy.length,
    outstandingCredit: store.transactions.reduce(
      (sum, tx) => sum + tx.creditDelta,
      0,
    ),
    pending: pending.length,
    adminReview: pending.filter(
      (request) => request.approvalLevel !== "MANAGER",
    ).length,
    cashReceived: totals.cashReceived,
    cashPayout: totals.cashPayout,
    netCash: totals.cashReceived - totals.cashPayout,
    expectedCash: totals.expectedCash,
    trend,
  };
}
