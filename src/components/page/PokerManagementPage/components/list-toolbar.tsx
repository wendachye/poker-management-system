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
  /** Keep a visible quick filter in the criteria count without repeating its chip. */
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
  children,
  compact = false,
}: {
  search: string;
  searchLabel?: string;
  searchPlaceholder: string;
  onSearchChange: (value: string) => void;
  activeFilters?: (string | ListFilter)[];
  onClear: () => void;
  resultCount: number;
  children?: ReactNode;
  compact?: boolean;
}) {
  const t = useText();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const hasCriteria = !!search.trim() || activeFilters.length > 0;
  const hasFilters = Children.count(children) > 0;
  const filterLabel = `${t("Filters")} · ${t(searchLabel)}`;
  return (
    <div className={cn("min-w-0 space-y-3", compact && "space-y-2")}>
      <div
        className={cn(
          "flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between",
          compact && "flex-row items-center gap-2",
        )}
      >
        <div
          className={cn(
            "relative w-full sm:max-w-[430px] sm:flex-1",
            compact && "min-w-0 flex-1",
          )}
        >
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            ref={input}
            type="search"
            aria-label={t(searchLabel)}
            aria-describedby={`${id}-results`}
            placeholder={t(searchPlaceholder)}
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            className="h-11 pl-9 pr-11 sm:h-10 [&::-webkit-search-cancel-button]:appearance-none"
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
        <div
          className={cn(
            "flex flex-wrap items-center gap-2 sm:ml-auto",
            compact && "shrink-0 flex-nowrap",
          )}
        >
          {hasFilters && (
            <Popover open={open} onOpenChange={setOpen}>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  aria-label={filterLabel}
                  className={cn(
                    "h-11 sm:h-10",
                    compact && "min-w-11 px-3 sm:px-4",
                    activeFilters.length > 0 && "border-primary text-primary",
                  )}
                >
                  <SlidersHorizontal aria-hidden="true" />
                  <span className={compact ? "hidden sm:inline" : undefined}>
                    {t("Filters")}
                  </span>
                  {activeFilters.length > 0 && (
                    <Badge className="min-w-5 justify-center px-1.5 tabular-nums">
                      {activeFilters.length}
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
                <div className="flex shrink-0 items-center justify-between gap-3 border-b px-4 py-3">
                  <p className="font-semibold">{t("Filters")}</p>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-11 sm:h-8"
                    disabled={!hasCriteria}
                    onClick={onClear}
                  >
                    {t("Clear all")}
                  </Button>
                </div>
                <div className="min-h-0 space-y-4 overflow-y-auto overscroll-contain p-4 [&_input]:h-11 [&_button[role=combobox]]:h-11 sm:[&_input]:h-10 sm:[&_button[role=combobox]]:h-10">
                  <p className="text-xs text-muted-foreground">
                    {t("Changes apply immediately.")}
                  </p>
                  {children}
                </div>
                <div className="shrink-0 border-t p-3">
                  <Button
                    type="button"
                    className="h-11 w-full sm:h-10"
                    onClick={() => setOpen(false)}
                  >
                    {t("Done")}
                  </Button>
                </div>
              </PopoverContent>
            </Popover>
          )}
          {hasCriteria && (
            <Button
              type="button"
              variant="ghost"
              className={cn("h-11 sm:h-10", compact && "hidden sm:inline-flex")}
              aria-label={t("Clear all")}
              onClick={onClear}
            >
              <RotateCcw aria-hidden="true" />
              <span>{t("Clear all")}</span>
            </Button>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span
          id={`${id}-results`}
          className={cn(
            "w-full tabular-nums sm:mr-auto sm:w-auto",
            compact && "mr-auto w-auto",
          )}
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {resultCount} {t(resultCount === 1 ? "result" : "results")}
        </span>
        {compact && hasCriteria && (
          <Button
            type="button"
            variant="ghost"
            className="h-11 gap-1.5 px-2 text-xs text-muted-foreground sm:hidden"
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
                className="h-auto min-h-11 max-w-full gap-2 whitespace-normal py-1.5 text-left font-normal sm:min-h-8"
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
