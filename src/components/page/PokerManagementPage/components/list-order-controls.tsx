"use client";

import { useId } from "react";
import {
  ArrowDownWideNarrow,
  ArrowUpDown,
  ArrowUpWideNarrow,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
} from "@/components/ui/pagination";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type Translate = (value: string) => string;
const identity: Translate = (value) => value;

export function ListOrderControls({
  options,
  value,
  direction,
  onChange,
  label = "Sort by",
  t = identity,
}: {
  options: { value: string; label: string }[];
  value: string;
  direction: "asc" | "desc";
  onChange: (value: string, direction: "asc" | "desc") => void;
  label?: string;
  t?: Translate;
}) {
  const selected = options.some((option) => option.value === value)
    ? value
    : "";
  const directionLabel = t(direction === "asc" ? "Ascending" : "Descending");
  const Icon = !selected
    ? ArrowUpDown
    : direction === "asc"
      ? ArrowUpWideNarrow
      : ArrowDownWideNarrow;
  const description = selected
    ? `${t(options.find((option) => option.value === selected)!.label)} · ${directionLabel}`
    : t("Default order");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className={`size-10 shrink-0${selected ? " border-primary text-primary" : ""}`}
          aria-label={t(label)}
          aria-description={description}
          title={`${t(label)} · ${description}`}
        >
          <Icon aria-hidden="true" className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-56 max-w-[calc(100vw-2rem)]"
        aria-label={t(label)}
      >
        <DropdownMenuLabel>{t(label)}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          aria-label={t(label)}
          value={selected || "__default_order__"}
          onValueChange={(next) => {
            const actual = next === "__default_order__" ? "" : next;
            if (options.some((option) => option.value === actual))
              onChange(actual, actual ? direction : "asc");
          }}
        >
          {options.map((option) => (
            <DropdownMenuRadioItem
              key={option.value || "__default_order__"}
              value={option.value || "__default_order__"}
              className="min-h-10 sm:min-h-9"
              onSelect={(event) => event.preventDefault()}
            >
              {t(option.label)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup
          aria-label={t("Change sort direction")}
          value={selected ? direction : ""}
          onValueChange={(next) => {
            if (selected && (next === "asc" || next === "desc"))
              onChange(selected, next);
          }}
        >
          {(["asc", "desc"] as const).map((order) => (
            <DropdownMenuRadioItem
              key={order}
              value={order}
              disabled={!selected}
              className="min-h-10 sm:min-h-9"
              onSelect={(event) => event.preventDefault()}
            >
              {t(order === "asc" ? "Ascending" : "Descending")}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ListPager({
  page,
  total,
  setPage,
  pageSize = 20,
  onPageSizeChange,
  label = "Record pages",
  loading = false,
  t = identity,
}: {
  page: number;
  total: number | null;
  setPage: (value: number) => void;
  pageSize?: number;
  onPageSizeChange?: (value: number) => void;
  label?: string;
  loading?: boolean;
  t?: Translate;
}) {
  const id = useId();
  const size = Number.isFinite(pageSize)
    ? Math.max(1, Math.floor(pageSize))
    : 20;
  const count =
    total !== null && Number.isFinite(total)
      ? Math.max(0, Math.floor(total))
      : null;
  const pages = Math.max(1, Math.ceil((count ?? 0) / size));
  const current = Math.min(
    Math.max(0, Number.isFinite(page) ? Math.floor(page) : 0),
    pages - 1,
  );
  if ((count === null || count <= size) && !onPageSizeChange) return null;
  return (
    <div
      className="flex flex-col gap-2 border-t pt-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-3 sm:pt-4"
      data-list-controls
      aria-busy={loading || undefined}
    >
      {count !== null && (
        <p
          className="text-sm text-muted-foreground"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {t("Showing")} {count ? current * size + 1 : 0}–
          {Math.min((current + 1) * size, count)} {t("of")} {count}
        </p>
      )}
      {onPageSizeChange && (
        <div className="flex items-center gap-2 sm:ml-auto">
          <label htmlFor={id} className="text-xs text-muted-foreground">
            {t("Rows per page")}
          </label>
          <Select
            value={String(size)}
            onValueChange={(value) => {
              const next = Number(value);
              if ((next === 20 || next === 50) && next !== size) {
                setPage(0);
                onPageSizeChange(next);
              }
            }}
          >
            <SelectTrigger
              id={id}
              aria-label={`${t("Rows per page")} · ${t(label)}`}
              className="h-10 w-20 sm:h-9"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="20">20</SelectItem>
              <SelectItem value="50">50</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}
      {count !== null && count > size && (
        <Pagination className="mx-0 w-auto" aria-label={t(label)}>
          <PaginationContent className="gap-1">
            {pages > 2 && (
              <PaginationItem>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="size-10 sm:size-9"
                  aria-label={t("First page")}
                  disabled={current === 0}
                  onClick={() => setPage(0)}
                >
                  <ChevronsLeft aria-hidden="true" />
                </Button>
              </PaginationItem>
            )}
            <PaginationItem>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-10 px-3 sm:h-9"
                aria-label={t("Previous page")}
                disabled={current === 0}
                onClick={() => setPage(current - 1)}
              >
                <ChevronLeft aria-hidden="true" />
                <span className="hidden sm:inline">{t("Previous")}</span>
              </Button>
            </PaginationItem>
            <PaginationItem>
              <span
                className="whitespace-nowrap px-2 text-xs tabular-nums sm:text-sm"
                aria-current="page"
              >
                <span className="sr-only">{t("Page")} </span>
                {current + 1} / {pages}
              </span>
            </PaginationItem>
            <PaginationItem>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-10 px-3 sm:h-9"
                aria-label={t("Next page")}
                disabled={current + 1 >= pages}
                onClick={() => setPage(current + 1)}
              >
                <span className="hidden sm:inline">{t("Next")}</span>
                <ChevronRight aria-hidden="true" />
              </Button>
            </PaginationItem>
            {pages > 2 && (
              <PaginationItem>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="size-10 sm:size-9"
                  aria-label={t("Last page")}
                  disabled={current + 1 >= pages}
                  onClick={() => setPage(pages - 1)}
                >
                  <ChevronsRight aria-hidden="true" />
                </Button>
              </PaginationItem>
            )}
          </PaginationContent>
        </Pagination>
      )}
    </div>
  );
}
