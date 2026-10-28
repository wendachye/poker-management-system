import type { ReadQuery } from "@/domain/read-model";

/** Keep an intentionally cleared native date input editable while its report reloads. */
export function reportDateInput(
  draft: string | undefined,
  reportDate?: string,
  currentDate?: string,
) {
  return draft ?? reportDate ?? currentDate ?? "";
}

export function reportSelection(
  date: string | undefined,
  selectedDay: string,
  currentDay: string | null,
): Pick<ReadQuery, "dayId" | "date"> {
  return date ? { date } : { dayId: selectedDay || currentDay || undefined };
}
