"use client";
import type { ReactNode } from "react";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { useText } from "./shared";

export function RecordTable({
  children,
  label = "Records",
}: {
  children: ReactNode;
  label?: string;
}) {
  const t = useText();
  return (
    <div className="hidden min-w-0 overflow-hidden rounded-lg border bg-card lg:block">
      <Table
        aria-label={t(label)}
        className="[&_th]:text-xs [&_thead]:bg-muted/40"
      >
        {children}
      </Table>
    </div>
  );
}

type RecordListProps<T> = {
  rows: T[];
  rowKey: (row: T) => string;
  label?: string;
  compact?: boolean;
  wide?: boolean;
  columns: {
    label: string;
    render: (row: T) => ReactNode;
    actions?: boolean;
    align?: "left" | "right";
    mobileSpan?: "full" | "half";
  }[];
};

export function RecordList<T>({
  rows,
  rowKey,
  columns,
  label = "Records",
  compact = false,
  wide = false,
}: RecordListProps<T>) {
  const t = useText();
  if (compact) {
    const primary = columns.find((column) => !column.actions);
    const details = columns.filter(
      (column) => column !== primary && !column.actions,
    );
    const actions = columns.filter((column) => column.actions);
    return (
      <div className="@container/records min-w-0">
        <ul
          aria-label={t(label)}
          className={cn(
            "divide-y border-y",
            wide
              ? "@min-[1000px]/records:hidden"
              : "@min-[800px]/records:hidden",
          )}
        >
          {rows.map((row) => (
            <li key={rowKey(row)} className="min-w-0 py-3" data-compact-record>
              <dl className="grid min-w-0 grid-cols-2 gap-x-4 gap-y-2">
                <div className="col-span-2 min-w-0">
                  <dt className="sr-only">{primary && t(primary.label)}</dt>
                  <dd className="flex min-w-0 items-start justify-between gap-3">
                    <div className="min-w-0 flex-1 break-words text-sm font-medium leading-5 [overflow-wrap:anywhere]">
                      {primary?.render(row)}
                    </div>
                    {actions.map((column) => (
                      <div
                        key={column.label}
                        className="max-w-[45%] shrink-0 break-words text-xs leading-5 [overflow-wrap:anywhere]"
                      >
                        <span className="sr-only">{t(column.label)}</span>
                        {column.render(row)}
                      </div>
                    ))}
                  </dd>
                </div>
                {details.map((column) => (
                  <div
                    key={column.label}
                    className={cn(
                      "min-w-0",
                      column.mobileSpan === "full" && "col-span-2",
                    )}
                  >
                    <dt className="mb-0.5 text-[11px] leading-4 text-muted-foreground">
                      {t(column.label)}
                    </dt>
                    <dd
                      className={cn(
                        "min-w-0 break-words text-xs leading-5 [overflow-wrap:anywhere]",
                        column.align === "right" && "font-medium tabular-nums",
                        column.actions && "flex flex-wrap justify-end gap-1.5",
                      )}
                    >
                      {column.render(row)}
                    </dd>
                  </div>
                ))}
              </dl>
            </li>
          ))}
        </ul>
        <div
          className={cn(
            "hidden [&>div]:block [&_table]:table-fixed",
            wide ? "@min-[1000px]/records:block" : "@min-[800px]/records:block",
          )}
        >
          <RecordTable label={label}>
            <TableHeader>
              <TableRow>
                {columns.map((column) => (
                  <TableHead
                    key={column.label}
                    scope="col"
                    className={cn(
                      "h-9 whitespace-normal",
                      (column.align === "right" || column.actions) &&
                        "text-right",
                    )}
                  >
                    {t(column.label)}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={rowKey(row)} data-compact-record>
                  {columns.map((column, index) => (
                    <TableCell
                      key={column.label}
                      className={cn(
                        "min-w-0 whitespace-normal break-words py-2 text-xs leading-5 [overflow-wrap:anywhere]",
                        index === 0 && "font-medium",
                        (column.align === "right" || column.actions) &&
                          "text-right tabular-nums",
                        column.actions && "[&>div]:justify-end",
                      )}
                    >
                      {column.render(row)}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </RecordTable>
        </div>
      </div>
    );
  }
  return (
    <>
      <div className="min-w-0 space-y-3 lg:hidden">
        {rows.map((row) => (
          <Card key={rowKey(row)} className="min-w-0 py-4">
            <CardContent className="min-w-0 px-4">
              <dl className="space-y-3">
                {columns.map((column) => (
                  <div
                    key={column.label}
                    className={
                      column.actions
                        ? "border-t pt-3 text-sm"
                        : "flex min-w-0 items-start justify-between gap-3 text-sm"
                    }
                  >
                    <dt
                      className={
                        column.actions
                          ? "sr-only"
                          : "max-w-[45%] shrink-0 text-muted-foreground"
                      }
                    >
                      {t(column.label)}
                    </dt>
                    <dd
                      className={
                        column.actions
                          ? "flex min-w-0 flex-wrap justify-end gap-2"
                          : "min-w-0 max-w-full break-words text-right font-medium"
                      }
                    >
                      {column.render(row)}
                    </dd>
                  </div>
                ))}
              </dl>
            </CardContent>
          </Card>
        ))}
      </div>
      <RecordTable label={label}>
        <TableHeader>
          <TableRow>
            {columns.map((column) => (
              <TableHead
                key={column.label}
                scope="col"
                className={
                  column.align === "right" || column.actions
                    ? "text-right"
                    : undefined
                }
              >
                {t(column.label)}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={rowKey(row)}>
              {columns.map((column) => (
                <TableCell
                  key={column.label}
                  className={`max-w-sm whitespace-normal break-words ${column.align === "right" || column.actions ? "text-right" : ""} ${column.actions ? "[&>div]:justify-end" : ""}`}
                >
                  {column.render(row)}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </RecordTable>
    </>
  );
}
