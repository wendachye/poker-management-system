"use client";

import { useRef, useState } from "react";
import {
  ArrowRightLeft,
  BookOpen,
  ChevronDown,
  Info,
  Plus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useText } from "./shared";
import { VenueRulesButton, VenueRulesDialog } from "./venue-rules";

export function TableActions({
  canManage,
  canMove,
  hasTables,
  onAdd,
  onMove,
}: {
  canManage: boolean;
  canMove: boolean;
  hasTables: boolean;
  onAdd: () => void;
  onMove: () => void;
}) {
  const t = useText();
  const [rulesOpen, setRulesOpen] = useState(false);
  const manageTrigger = useRef<HTMLButtonElement>(null);
  return (
    <>
      {canMove && (
        <Button
          type="button"
          className="h-10 sm:h-9"
          data-table-move-trigger
          onClick={onMove}
        >
          <ArrowRightLeft aria-hidden="true" />
          {t("Move player")}
        </Button>
      )}
      {canManage && !hasTables && (
        <Button
          type="button"
          className="h-10 sm:h-9"
          data-table-add-trigger
          onClick={onAdd}
        >
          <Plus aria-hidden="true" />
          {t("Add table")}
        </Button>
      )}
      {canManage && hasTables ? (
        <>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                ref={manageTrigger}
                type="button"
                variant="outline"
                className="h-10 sm:h-9"
                data-table-manage-trigger
              >
                {t("Manage tables")}
                <ChevronDown aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              aria-label={t("Manage tables")}
              onCloseAutoFocus={(event) => {
                if (rulesOpen) event.preventDefault();
              }}
            >
              <DropdownMenuItem
                onSelect={onAdd}
                className="min-h-10 sm:min-h-9"
              >
                <Plus aria-hidden="true" />
                {t("Add table")}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => setRulesOpen(true)}
                className="min-h-10 sm:min-h-9"
              >
                <BookOpen aria-hidden="true" />
                {t("Venue rules")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <VenueRulesDialog
            open={rulesOpen}
            onOpenChange={setRulesOpen}
            fallbackFocus={() => manageTrigger.current}
          />
        </>
      ) : (
        <VenueRulesButton />
      )}
    </>
  );
}

export function TableSeatingHelp() {
  const t = useText();
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-10 shrink-0 text-muted-foreground sm:size-9"
          aria-label={t("Seating help")}
        >
          <Info aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[min(20rem,calc(100vw-2rem))] p-3 text-sm sm:p-4"
        aria-label={t("Seating help")}
      >
        {t(
          "Drag to an empty seat to move, or onto a player to swap. On a phone, press and hold.",
        )}
      </PopoverContent>
    </Popover>
  );
}
