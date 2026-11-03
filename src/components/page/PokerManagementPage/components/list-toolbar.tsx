"use client";

import { Children, useId, useRef, useState, type ReactNode } from "react";
import {
  ChevronDown,
  RotateCcw,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useText } from "./shared";

export type ListFilter = {
  key: string;
  label: string;
  onRemove: () => void;
  /** The criterion has a visible control, so omit its chip and popup badge count. */
  hideChip?: boolean;
};

export function ListToolbar({
  search,
  searchLabel = "Search",
  searchPlaceholder,
  onSearchChange,
  activeFilters = [],
  onClear,
  resultCount,
  loading = false,
  primaryFilters,
  orderControls,
  orderControlsClassName = "@min-[800px]/list-toolbar:hidden",
  children,
  compact = false,
}: {
  search: string;
  searchLabel?: string;
  searchPlaceholder: string;
  onSearchChange: (value: string) => void;
  activeFilters?: (string | ListFilter)[];
  onClear: () => void;
  resultCount: number | null;
  loading?: boolean;
  /** Frequently used criteria, visible without opening the filter panel. */
  primaryFilters?: ReactNode;
  /** Card-layout sorting menu, hidden when the corresponding table is visible. */
  orderControls?: ReactNode;
  /** Match the list's actual container or viewport table breakpoint. */
  orderControlsClassName?: string;
  children?: ReactNode;
  compact?: boolean;
}) {
  const t = useText();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const hasCriteria = !!search.trim() || activeFilters.length > 0;
  const hasFilters = Children.count(children) > 0;
  const advancedFilterCount = activeFilters.filter(
    (filter) => typeof filter === "string" || !filter.hideChip,
  ).length;
  const filterLabel = `${t("Filters")} · ${t(searchLabel)}`;
  return (
    <div
      className={cn(
        "@container/list-toolbar min-w-0 space-y-2.5 sm:space-y-3",
        compact && "space-y-2 sm:space-y-2",
      )}
    >
      <div className="flex flex-col gap-2 @min-[520px]/list-toolbar:flex-row @min-[520px]/list-toolbar:flex-wrap @min-[520px]/list-toolbar:items-end">
        <div className="relative min-w-0 w-full @min-[520px]/list-toolbar:flex-1 @min-[520px]/list-toolbar:basis-56">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground sm:size-4"
          />
          <Input
            ref={input}
            type="search"
            aria-label={t(searchLabel)}
            aria-describedby={`${id}-results`}
            placeholder={t(searchPlaceholder)}
            value={search}
            autoComplete="off"
            onChange={(event) => onSearchChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && search) {
                event.preventDefault();
                onSearchChange("");
              }
            }}
            className="h-10 pl-8 pr-11 sm:pl-9 [&::-webkit-search-cancel-button]:appearance-none"
          />
          {search.length > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="absolute right-0.5 top-1/2 size-10 -translate-y-1/2 sm:size-9"
              aria-label={`${t("Clear search")} · ${t(searchLabel)}`}
              onClick={() => {
                onSearchChange("");
                input.current?.focus();
              }}
            >
              <X aria-hidden="true" />
            </Button>
          )}
        </div>
        <div className="flex w-full items-end justify-end gap-2 empty:hidden @max-[280px]/list-toolbar:flex-wrap @min-[520px]/list-toolbar:ml-auto @min-[520px]/list-toolbar:w-auto">
          {primaryFilters && (
            <div className="min-w-0 flex-1 @max-[280px]/list-toolbar:basis-full @min-[520px]/list-toolbar:w-48 @min-[520px]/list-toolbar:flex-none [&_button[role=combobox]]:h-10">
              {primaryFilters}
            </div>
          )}
          {hasFilters && (
            <Popover open={open} onOpenChange={setOpen}>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  aria-label={filterLabel}
                  className={cn(
                    "h-10",
                    compact && "min-w-10 px-3 sm:min-w-11 sm:px-4",
                    advancedFilterCount > 0 && "border-primary text-primary",
                  )}
                >
                  <SlidersHorizontal aria-hidden="true" />
                  <span>{t("Filters")}</span>
                  {advancedFilterCount > 0 && (
                    <Badge className="min-w-5 justify-center px-1.5 tabular-nums">
                      {advancedFilterCount}
                    </Badge>
                  )}
                  <ChevronDown
                    aria-hidden="true"
                    className={cn(
                      open && "rotate-180",
                      compact && "hidden sm:block",
                    )}
                  />
                </Button>
              </PopoverTrigger>
              <PopoverContent
                align="end"
                className="flex max-h-[min(32rem,var(--radix-popover-content-available-height))] w-[min(22rem,calc(100vw-2rem))] flex-col gap-0 overflow-hidden p-0"
                aria-label={filterLabel}
              >
                <div className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-2 sm:gap-3 sm:px-4 sm:py-3">
                  <p className="font-semibold">{t("Filters")}</p>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-10 sm:h-8"
                    disabled={!hasCriteria}
                    onClick={onClear}
                  >
                    {t("Clear all")}
                  </Button>
                </div>
                <div className="min-h-0 space-y-3 overflow-y-auto overscroll-contain p-3 sm:space-y-4 sm:p-4 [&_input]:h-10 [&_button[role=combobox]]:h-10">
                  {children}
                </div>
                <div className="shrink-0 border-t p-2 sm:p-3">
                  <Button
                    type="button"
                    className="h-10 w-full"
                    onClick={() => setOpen(false)}
                  >
                    {resultCount === null
                      ? t("Done")
                      : `${t("Show")} ${resultCount} ${t(resultCount === 1 ? "result" : "results")}`}
                  </Button>
                </div>
              </PopoverContent>
            </Popover>
          )}
          {orderControls && (
            <div className={cn("shrink-0", orderControlsClassName)}>
              {orderControls}
            </div>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground sm:gap-2">
        <span
          id={`${id}-results`}
          className="mr-auto tabular-nums"
          role="status"
          aria-live="polite"
          aria-atomic="true"
          aria-busy={loading || undefined}
        >
          {resultCount === null
            ? t(loading ? "Updating results…" : "Results unavailable")
            : `${resultCount} ${t(resultCount === 1 ? "result" : "results")}`}
        </span>
        {hasCriteria && (
          <Button
            type="button"
            variant="ghost"
            className="h-10 gap-1.5 px-2 text-xs text-muted-foreground sm:h-8"
            onClick={onClear}
          >
            <RotateCcw aria-hidden="true" className="size-3.5" />
            {t("Clear all")}
          </Button>
        )}
        {activeFilters
          .filter((filter) => typeof filter === "string" || !filter.hideChip)
          .map((filter, index) =>
            typeof filter === "string" ? (
              <Badge
                key={`${index}-${filter}`}
                variant="secondary"
                className="max-w-full whitespace-normal font-normal"
              >
                {t(filter)}
              </Badge>
            ) : (
              <Button
                key={filter.key}
                type="button"
                variant="secondary"
                size="sm"
                className="h-auto min-h-10 max-w-full gap-2 whitespace-normal py-1.5 text-left font-normal sm:min-h-8"
                aria-label={`${t("Remove filter")}: ${t(filter.label)}`}
                onClick={filter.onRemove}
              >
                <span className="min-w-0 break-words">{t(filter.label)}</span>
                <X aria-hidden="true" className="size-3.5 shrink-0" />
              </Button>
            ),
          )}
      </div>
    </div>
  );
}
