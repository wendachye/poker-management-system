"use client";

import { MoreHorizontal, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useText } from "./shared";

export type RowAction = {
  key: string;
  label: string;
  onSelect: () => void;
  icon?: LucideIcon;
  disabled?: boolean;
  destructive?: boolean;
  description?: string;
};

export function RowActions({
  label,
  actions,
  disabled = false,
  iconOnly = false,
}: {
  label: string;
  actions: RowAction[];
  disabled?: boolean;
  iconOnly?: boolean;
}) {
  const t = useText();
  if (!actions.length) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size={iconOnly ? "icon-sm" : "sm"}
          className={
            iconOnly ? "size-11 shrink-0 sm:size-9" : "h-11 shrink-0 sm:h-9"
          }
          aria-label={t(label)}
          disabled={disabled}
        >
          <MoreHorizontal aria-hidden="true" />
          {!iconOnly && t("Actions")}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-60 max-w-[calc(100vw-2rem)]"
        aria-label={t(label)}
      >
        <DropdownMenuLabel className="break-words text-xs font-normal text-muted-foreground">
          {t(label)}
        </DropdownMenuLabel>
        {actions.map((action) => (
          <DropdownMenuItem
            key={action.key}
            disabled={action.disabled}
            variant={action.destructive ? "destructive" : "default"}
            onSelect={action.onSelect}
            className="min-h-11 gap-2 px-3 sm:min-h-9"
          >
            {action.icon && <action.icon aria-hidden="true" />}
            <span className="min-w-0">
              <span className="block">{t(action.label)}</span>
              {action.description && (
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  {t(action.description)}
                </span>
              )}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
