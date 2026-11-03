"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Primary actions come first for mobile focus; desktop choices align to their left. */
export function ListActions({
  actions,
  children,
  className,
}: {
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  if (!actions && !children) return null;
  return (
    <div
      className={cn(
        "flex min-w-0 flex-wrap items-center gap-2 sm:gap-3",
        className,
      )}
      data-list-actions
    >
      {actions && (
        <div className="ml-auto flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2 sm:order-2 [&>button]:h-10 sm:[&>button]:h-9 [&>a]:h-10 sm:[&>a]:h-9">
          {actions}
        </div>
      )}
      {children && (
        <div className="w-full min-w-0 sm:order-1 sm:w-auto sm:flex-1">
          {children}
        </div>
      )}
    </div>
  );
}
