"use client";

import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { TableHead } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { useText } from "./shared";

export type ListSorting = {
  value: string;
  direction: "asc" | "desc";
  options: readonly { value: string; label: string }[];
  onChange(value: string, direction: "asc" | "desc"): void;
};

/** Headers delegate to the existing full-result sort; they never reorder a server page. */
export function SortableTableHead({
  label,
  sortKey,
  sorting,
  className,
  align = "left",
}: {
  label: string;
  sortKey?: string;
  sorting?: ListSorting;
  className?: string;
  align?: "left" | "right";
}) {
  const t = useText();
  if (
    !sortKey ||
    !sorting ||
    !sorting.options.some((option) => option.value === sortKey)
  ) {
    return (
      <TableHead
        scope="col"
        className={cn(align === "right" && "text-right", className)}
      >
        {t(label)}
      </TableHead>
    );
  }
  const active = sorting.value === sortKey;
  const nextDirection = active && sorting.direction === "asc" ? "desc" : "asc";
  const Icon = !active
    ? ArrowUpDown
    : sorting.direction === "asc"
      ? ArrowUp
      : ArrowDown;
  const action = `${t("Sort by")} ${t(label)} · ${t(nextDirection === "asc" ? "Ascending" : "Descending")}`;
  return (
    <TableHead
      scope="col"
      aria-label={t(label)}
      aria-sort={
        active
          ? sorting.direction === "asc"
            ? "ascending"
            : "descending"
          : undefined
      }
      className={cn(
        "p-0 select-none",
        align === "right" && "text-right",
        className,
      )}
    >
      <button
        type="button"
        aria-label={action}
        title={action}
        onClick={() => sorting.onChange(sortKey, nextDirection)}
        className={cn(
          "flex h-full min-h-9 w-full cursor-pointer items-center gap-1.5 px-3 py-2 text-left font-medium hover:bg-muted/50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
          active && "text-foreground",
          align === "right" && "justify-end text-right",
        )}
      >
        <span className="min-w-0">{t(label)}</span>
        <Icon
          aria-hidden="true"
          className={cn("size-3.5 shrink-0", !active && "opacity-50")}
        />
      </button>
    </TableHead>
  );
}
