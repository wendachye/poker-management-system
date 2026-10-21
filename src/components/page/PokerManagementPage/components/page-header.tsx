"use client";
import type { ReactNode } from "react";
import { useText } from "./shared";

export function PageHeader({
  title,
  description,
  metadata,
  children,
}: {
  title: string;
  description?: string;
  metadata?: ReactNode;
  children?: ReactNode;
}) {
  const t = useText();
  return (
    <div className="flex min-w-0 flex-col gap-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
      <div className="min-w-0 space-y-1.5">
        <h1 className="text-[1.375rem] font-semibold leading-tight tracking-tight text-foreground sm:text-2xl">
          {t(title)}
        </h1>
        {description && (
          <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
            {t(description)}
          </p>
        )}
        {metadata && <div className="pt-1.5">{metadata}</div>}
      </div>
      {children && (
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {children}
        </div>
      )}
    </div>
  );
}
