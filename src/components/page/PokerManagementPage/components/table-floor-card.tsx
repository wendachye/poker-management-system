"use client";

import { useId, useState } from "react";
import { ChevronDown, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import type { Player, PokerTable } from "@/domain/model";
import type { effectiveTableRules } from "@/domain/settings";
import { displayName } from "@/lib/display-name";
import { money } from "../utils";
import { PokerTableMap } from "./poker-table-map";
import { useText } from "./shared";

export function TableFloorCard({
  table,
  players,
  rules,
  busy,
  canCheckIn,
  onSeatSelect,
  onEdit,
}: {
  table: PokerTable;
  players: Player[];
  rules: ReturnType<typeof effectiveTableRules>;
  busy: boolean;
  canCheckIn: boolean;
  onSeatSelect: (seat: number, player?: Player) => void;
  onEdit?: () => void;
}) {
  const t = useText();
  const tableName = displayName(table.name);
  const id = useId();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const number = new Intl.NumberFormat("en-MY", {
    maximumFractionDigits: 2,
  });
  const stakes = `RM ${number.format(rules.smallBlind / 100)} / ${number.format(rules.bigBlind / 100)}`;
  return (
    <Card className="gap-0 py-0 sm:py-0" role="region" aria-labelledby={id}>
      <div className="space-y-4 px-4 pt-4 sm:px-5 sm:pt-5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-2 pt-1">
            <h2
              id={id}
              className="min-w-0 break-words text-base font-semibold leading-6 tracking-tight"
            >
              {tableName}
            </h2>
            <Badge
              variant="outline"
              className="h-6 gap-1.5 rounded-full border-border/70 px-2 text-xs font-normal text-muted-foreground"
            >
              <span
                aria-hidden="true"
                className={`size-1 rounded-full ${table.status === "OPEN" ? "bg-emerald-500" : "bg-muted-foreground/60"}`}
              />
              {t(table.status === "OPEN" ? "Open" : "Closed")}
            </Badge>
          </div>
          {onEdit && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="-mr-1 -mt-1 size-11 shrink-0 p-0 text-muted-foreground hover:text-foreground sm:mt-0 sm:h-9 sm:w-auto sm:px-3"
              aria-label={`${t("Edit table")} · ${tableName}`}
              onClick={onEdit}
            >
              <Pencil aria-hidden="true" />
              <span className="hidden sm:inline">{t("Edit")}</span>
            </Button>
          )}
        </div>
        <div className="flex items-end justify-between gap-3">
          <p className="min-w-0 text-sm font-medium tabular-nums text-foreground sm:text-base">
            <span className="sr-only">{t("Stakes")} </span>
            {stakes}
          </p>
          <div className="w-24 shrink-0 space-y-1.5">
            <p className="text-right text-xs leading-none tabular-nums text-muted-foreground">
              <span className="font-medium text-foreground">
                {players.length}
              </span>
              {" / 9 "}
              {t("seated")}
            </p>
            <div
              role="progressbar"
              aria-label={`${t("Table occupancy")} · ${tableName}`}
              aria-valuemin={0}
              aria-valuemax={9}
              aria-valuenow={players.length}
              aria-valuetext={`${players.length} / 9 ${t("seated")}`}
              className="grid grid-cols-9 gap-1"
            >
              {Array.from({ length: 9 }, (_, index) => (
                <span
                  key={index}
                  aria-hidden="true"
                  className={`h-1 rounded-full ${index < players.length ? "bg-foreground/60" : "bg-foreground/10"}`}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
      <div className="pb-2 pt-1 sm:px-5">
        <PokerTableMap
          table={table}
          players={players}
          disabled={busy}
          canCheckIn={canCheckIn}
          onSeatSelect={onSeatSelect}
        />
      </div>
      <Collapsible open={detailsOpen} onOpenChange={setDetailsOpen}>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t bg-muted/10 px-4 py-3 sm:px-5">
          <div className="min-w-0 text-xs">
            <p className="text-muted-foreground">{t("Buy-in range")}</p>
            <p className="mt-1 break-words text-[13px] font-medium tabular-nums">
              {money(rules.minBuyIn)} – {money(rules.maxBuyIn)}
            </p>
          </div>
          <CollapsibleTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="-mr-1 h-11 shrink-0 text-muted-foreground hover:text-foreground sm:h-9"
              aria-label={`${t("Table details")} · ${tableName}`}
            >
              {t("Details")}
              <ChevronDown
                aria-hidden="true"
                className={`motion-safe:transition-transform ${detailsOpen ? "rotate-180" : ""}`}
              />
            </Button>
          </CollapsibleTrigger>
        </div>
        <CollapsibleContent>
          <div className="space-y-3 border-t bg-muted/20 px-4 py-4 sm:px-5">
            <dl className="grid grid-cols-2 gap-4 text-xs">
              {[
                [
                  "Buy-in increment",
                  rules.buyInStep ? money(rules.buyInStep) : t("Any amount"),
                ],
                ["Rake", money(table.rake)],
                ["Insurance", money(table.insurance)],
                ["Jackpot", money(table.jackpot)],
              ].map(([label, value]) => (
                <div key={label} className="min-w-0 space-y-1">
                  <dt className="text-muted-foreground">{t(label)}</dt>
                  <dd className="break-words font-medium tabular-nums">
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {t("Table totals for the current business day.")}
            </p>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}
