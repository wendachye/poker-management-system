export { formatMoney as money, parseMoney, csv as toCsv } from "@/domain/money";
export function minutesBetween(start?: string, end?: string, now = Date.now()) {
  return start
    ? Math.max(
        0,
        Math.floor(((end ? Date.parse(end) : now) - Date.parse(start)) / 60000),
      )
    : 0;
}
export function durationLabel(minutes: number) {
  return Math.floor(minutes / 60) + "h " + (minutes % 60) + "m";
}
export function timestamp(value: string, timezone: string, locale = "en") {
  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-MY", {
    timeZone: timezone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
