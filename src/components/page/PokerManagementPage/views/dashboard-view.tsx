"use client";
import { displayName } from "@/lib/display-name";

import { ArrowRight, Clock3 } from "lucide-react";
import { dashboardSummary } from "@/domain/dashboard-summary";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader } from "@/components/ui/card";
import { Link } from "@/i18n/navigation";
import { usePokerManagementContext } from "../PokerManagementProvider";
import { money } from "../utils";
import { Panel, Stat, useText } from "../components/shared";

export function DashboardView() {
  const s = usePokerManagementContext();
  const t = useText();
  const summary = dashboardSummary(s.store);
  const scale = Math.max(
    1,
    ...summary.trend.map((day) => Math.abs(day.netCash)),
  );

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Stat label="Active players" value={String(summary.activePlayers)} />
        <Card>
          <CardHeader>
            <CardDescription className="text-xs font-medium uppercase tracking-wide">
              {t("Open-table utilization")}
            </CardDescription>
            <p className="min-w-0 break-words text-lg font-semibold tabular-nums sm:text-2xl">
              {summary.utilization === null ? "—" : `${summary.utilization}%`}
            </p>
            <p className="text-xs text-muted-foreground">
              {summary.occupied} / {summary.capacity} {t("seats occupied")}
            </p>
          </CardHeader>
        </Card>
        <Stat
          label="Expected cash"
          value={summary.day ? money(summary.expectedCash) : "—"}
        />
        <Stat
          label="Outstanding credit"
          value={money(summary.outstandingCredit)}
        />
      </div>

      {summary.pending > 0 && (
        <Alert>
          <Clock3 />
          <AlertDescription className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
            <p>
              <span className="font-medium text-foreground">
                {summary.pending} {t("pending approvals")}
              </span>
              {summary.adminReview > 0 && (
                <span className="ml-2 text-muted-foreground">
                  · {summary.adminReview} {t("require admin review")}
                </span>
              )}
            </p>
            <Button variant="outline" size="sm" asChild>
              <Link
                href="/transactions"
                onClick={() => {
                  s.setDraft("tx.status", "PENDING");
                  s.setDraft("tx.day", s.store.currentDayId ?? "");
                  s.setDraft("tx.filter", "");
                  s.setDraft("tx.search", "");
                  s.setDraft("tx.page", "0");
                }}
              >
                {t("Review requests")}
                <ArrowRight />
              </Link>
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-5">
          <Panel
            title="Business-day cash flow"
            description="Posted cash movements for the selected business day."
          >
            <dl className="grid gap-4 sm:grid-cols-3">
              {[
                ["Cash received", summary.cashReceived],
                ["Cash payout", summary.cashPayout],
                ["Net cash movement", summary.netCash],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt className="text-xs text-muted-foreground">
                    {t(String(label))}
                  </dt>
                  <dd className="mt-1 break-words text-lg font-semibold tabular-nums">
                    {summary.day ? money(Number(value)) : "—"}
                  </dd>
                </div>
              ))}
            </dl>
            <p className="text-xs text-muted-foreground">
              {t(
                "Includes player and house cash movements. Credit buy-ins are excluded until paid.",
              )}
              {summary.day?.status === "OPEN" &&
                ` ${t("Open-day figures are provisional.")}`}
            </p>
          </Panel>

          <Panel
            title="Recent cash movement"
            description="Last 7 recorded business days. Open-day figures are provisional."
          >
            {!summary.trend.length ? (
              <p className="py-5 text-center text-sm text-muted-foreground">
                {t("No recorded business days yet.")}
              </p>
            ) : (
              <>
                <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                  <span>{t("Business day")}</span>
                  <span>{t("Net cash movement")}</span>
                </div>
                <ol
                  aria-label={t("Recent cash movement")}
                  className="space-y-3"
                >
                  {summary.trend.map((day) => {
                    const width = (Math.abs(day.netCash) / scale) * 50;
                    return (
                      <li
                        key={day.id}
                        className="grid grid-cols-[6.5rem_minmax(0,1fr)_auto] items-center gap-3"
                      >
                        <div>
                          <time
                            dateTime={day.date}
                            className="text-xs tabular-nums"
                          >
                            {day.date}
                          </time>
                          {day.provisional && (
                            <p className="text-[11px] text-muted-foreground">
                              {t("Provisional")}
                            </p>
                          )}
                        </div>
                        <div
                          aria-hidden="true"
                          className="relative h-5 min-w-0 overflow-hidden rounded bg-muted/50"
                        >
                          <div className="absolute inset-y-0 left-1/2 w-px bg-border" />
                          <div
                            className="absolute inset-y-1 rounded-sm bg-primary/70"
                            style={{
                              left: `${day.netCash < 0 ? 50 - width : 50}%`,
                              width: `${width}%`,
                            }}
                          />
                        </div>
                        <span className="text-right text-xs font-medium tabular-nums">
                          {money(day.netCash)}
                        </span>
                      </li>
                    );
                  })}
                </ol>
                <p className="text-xs text-muted-foreground">
                  {t(
                    "Unrecorded dates are omitted. Net cash movement includes buy-ins and payouts.",
                  )}
                </p>
              </>
            )}
          </Panel>
        </div>

        <Panel title="Table occupancy">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>
              {t("Open")}: {summary.occupancy.length}
            </span>
            <span>
              {t("Closed")}: {summary.closedTables}
            </span>
          </div>
          {!summary.occupancy.length ? (
            <p className="py-5 text-center text-sm text-muted-foreground">
              {t("No open tables.")}
            </p>
          ) : (
            <ul className="space-y-4">
              {summary.occupancy.map((table) => (
                <li key={table.id} className="space-y-2">
                  <div className="flex items-center justify-between gap-3 text-sm">
                    <span className="min-w-0 break-words font-medium">
                      {displayName(table.name)}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                      {table.occupied} / {table.capacity}
                    </span>
                  </div>
                  <div
                    role="progressbar"
                    aria-label={
                      displayName(table.name) + " · " + t("Table occupancy")
                    }
                    aria-valuemin={0}
                    aria-valuemax={table.capacity}
                    aria-valuenow={table.occupied}
                    aria-valuetext={`${table.occupied} / ${table.capacity} ${t("seats occupied")}`}
                    className="h-1.5 overflow-hidden rounded-full bg-muted"
                  >
                    <div
                      className="h-full rounded-full bg-primary"
                      style={{
                        width: `${(table.occupied / table.capacity) * 100}%`,
                      }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}
