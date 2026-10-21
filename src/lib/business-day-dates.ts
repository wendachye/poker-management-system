import type { Day } from "../domain/model";
import { shiftDate } from "../domain/reporting";

/** Calendar dates for the opening form, independent of the computer's time zone. */
export function businessDayDates(
  days: readonly Pick<Day, "date">[],
  timezone: string,
  now = new Date(),
): { today: string; defaultDate: string; minDate: string | undefined } {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const latest = days.reduce(
    (latest, day) => (day.date > latest ? day.date : latest),
    "",
  );
  const minDate = latest ? shiftDate(latest, 1) : undefined;
  return {
    today,
    defaultDate: minDate && minDate > today ? minDate : today,
    minDate,
  };
}
