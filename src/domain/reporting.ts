import type { Store } from "./model";
import { totalsForDay } from "./selectors";

const DAY = 86400000;
function calendarDate(value: string) {
  const time = Date.parse(value + "T00:00:00Z");
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(time) ||
    new Date(time).toISOString().slice(0, 10) !== value
  )
    throw new Error("Choose valid start and end dates.");
  return time;
}
export function shiftDate(value: string, days: number) {
  return new Date(calendarDate(value) + days * DAY).toISOString().slice(0, 10);
}
export function reportPreset(preset: string, today: string) {
  calendarDate(today);
  if (preset === "month") return { from: today.slice(0, 7) + "-01", to: today };
  if (preset === "last-month") {
    const to = shiftDate(today.slice(0, 7) + "-01", -1);
    return { from: to.slice(0, 7) + "-01", to };
  }
  return { from: shiftDate(today, -6), to: today };
}
export const rangeMetrics = [
  ["cashReceived", "Cash received"],
  ["cashPayout", "Cash payout"],
  ["netCash", "Net cash movement"],
  ["buyInTotal", "Buy-in"],
  ["cashOutTotal", "Cash-out"],
  ["rake", "Rake"],
  ["tips", "Tips"],
  ["insurance", "Insurance net movement"],
  ["jackpot", "Jackpot net movement"],
] as const;
type Metric = (typeof rangeMetrics)[number][0];

export function rangeReport(store: Store, from: string, to: string) {
  const calendarDays = (calendarDate(to) - calendarDate(from)) / DAY + 1;
  if (calendarDays < 1)
    throw new Error("End date must be on or after start date.");
  if (calendarDays > 366) throw new Error("Choose a range of up to 366 days.");
  const days = store.days
    .filter((d) => d.date >= from && d.date <= to)
    .toSorted((a, b) => a.date.localeCompare(b.date))
    .map((day) => ({ ...day, totals: totalsForDay(store, day.id) }));
  const totals: Record<Metric, number> = {
    cashReceived: 0,
    cashPayout: 0,
    netCash: 0,
    buyInTotal: 0,
    cashOutTotal: 0,
    rake: 0,
    tips: 0,
    insurance: 0,
    jackpot: 0,
  };
  for (const day of days)
    for (const [metric] of rangeMetrics) {
      const amount =
        metric === "netCash"
          ? day.totals.cashReceived - day.totals.cashPayout
          : day.totals[metric];
      totals[metric] += amount;
      if (!Number.isSafeInteger(totals[metric]))
        throw new Error("Report total exceeds the supported amount.");
    }
  const counted = days.filter((d) => d.totals.variance !== null);
  const dayIds = new Set(days.map((d) => d.id));
  return {
    from,
    to,
    calendarDays,
    days,
    totals,
    unrecordedDays: calendarDays - days.length,
    openDays: days.filter((d) => d.status === "OPEN").length,
    countedDays: counted.length,
    variance: counted.length
      ? counted.reduce((sum, d) => sum + d.totals.variance!, 0)
      : null,
    pendingRequests: store.approvals.filter(
      (r) => dayIds.has(r.dayId) && r.status === "PENDING",
    ).length,
  };
}
export function compareReports(store: Store, from: string, to: string) {
  const current = rangeReport(store, from, to);
  const previous = rangeReport(
    store,
    shiftDate(from, -current.calendarDays),
    shiftDate(from, -1),
  );
  return { current, previous };
}
