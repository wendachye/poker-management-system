export function money(value: number) {
  return `RM ${value.toLocaleString("en-MY")}`;
}

export function currentIso() {
  return new Date().toISOString();
}

export function minutesBetween(start?: string, end?: string) {
  if (!start) return 0;
  return Math.max(
    0,
    Math.round((Date.parse(end || currentIso()) - Date.parse(start)) / 60000),
  );
}

export function durationLabel(minutes: number) {
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function currentTimeLabel() {
  return new Date().toLocaleTimeString("en-MY", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function createId(prefix: string) {
  const randomId =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  return `${prefix}-${randomId}`;
}

type ParseNumberResult =
  | { ok: true; value: number }
  | { ok: false; error: string };

export function parsePositiveAmount(
  value: string,
  label = "Amount",
): ParseNumberResult {
  const amount = Number(value);

  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: `${label} must be greater than 0.` };
  }

  return { ok: true, value: amount };
}

export function parseRequiredText(value: string, label: string) {
  const text = value.trim();

  if (!text) {
    return { ok: false, error: `${label} is required.` } as const;
  }

  return { ok: true, value: text } as const;
}

export function parseSeat(value: string): ParseNumberResult {
  const seat = Number(value);

  if (!Number.isInteger(seat) || seat < 1 || seat > 9) {
    return { ok: false, error: "Seat must be a whole number from 1 to 9." };
  }

  return { ok: true, value: seat };
}

export function escapeCsvValue(value: unknown) {
  const text = String(value ?? "");
  const escaped = text.replaceAll('"', '""');

  return /[",\n\r]/.test(escaped) ? `"${escaped}"` : escaped;
}

export function toCsv(rows: unknown[][]) {
  return rows.map((row) => row.map(escapeCsvValue).join(",")).join("\n");
}
