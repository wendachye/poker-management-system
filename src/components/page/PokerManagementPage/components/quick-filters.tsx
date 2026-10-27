"use client";

import { Button } from "@/components/ui/button";
import { useText } from "./shared";

/** Common list choices stay visible; less frequent criteria belong in Filters. */
export function QuickFilters({
  label,
  value,
  onValueChange,
  options,
}: {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  options: { value: string; label: string; count?: number }[];
}) {
  const t = useText();
  return (
    <div
      role="group"
      aria-label={t(label)}
      className="flex w-full min-w-0 flex-wrap gap-1 rounded-lg border bg-muted/30 p-1 sm:w-fit"
    >
      {options.map((option) => (
        <Button
          key={option.value}
          type="button"
          variant="ghost"
          aria-pressed={value === option.value}
          aria-label={
            t(option.label) +
            (option.count === undefined ? "" : " · " + option.count)
          }
          className={`h-auto min-h-11 min-w-0 flex-1 flex-col gap-0.5 whitespace-normal px-2 py-1.5 text-xs sm:h-9 sm:min-h-9 sm:flex-none sm:flex-row sm:gap-2 sm:whitespace-nowrap sm:px-3 ${value === option.value ? "bg-background text-foreground shadow-xs hover:bg-background" : "text-muted-foreground"}`}
          onClick={() => onValueChange(option.value)}
        >
          <span>{t(option.label)}</span>
          {option.count !== undefined && (
            <span className="text-[11px] font-normal tabular-nums text-muted-foreground">
              {option.count}
            </span>
          )}
        </Button>
      ))}
    </div>
  );
}
