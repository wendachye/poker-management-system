"use client";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { compareReports, rangeMetrics, reportPreset } from "@/domain/reporting";
import { displayName } from "@/lib/display-name";
import { usePokerManagementContext } from "../PokerManagementProvider";
import { money, toCsv } from "../utils";
import {
  Badge,
  EmptyState,
  Field,
  Panel,
  Pager,
  Select,
  Stat,
  useText,
} from "./shared";
import { RecordList } from "./record-list";
import { ListToolbar } from "./list-toolbar";
import type { Day, Totals } from "@/domain/model";
import { downloadReadCsv, ReadStatus, useReadPage } from "./use-read-page";

export function RangeReport({ today }: { today: string }) {
  const s = usePokerManagementContext(),
    t = useText();
  const preset = s.draft("range.preset", "week");
  const defaults = reportPreset(preset, today);
  const from =
    preset === "custom" ? s.draft("range.from", defaults.from) : defaults.from;
  const to =
    preset === "custom" ? s.draft("range.to", defaults.to) : defaults.to;
  const query = s.draft("range.search"),
    status = s.draft("range.status");
  const requestedPage = Math.max(0, Number(s.draft("range.page")) || 0);
  const remote = useReadPage<Day & { totals: Totals }>({
    resource: "range",
    from,
    to,
    query,
    status,
    page: requestedPage,
  });
  function clearFilters() {
    for (const key of ["search", "status", "page"])
      s.setDraft("range." + key, "");
  }
  function custom(key: string, value: string) {
    s.setDraft("range.from", from);
    s.setDraft("range.to", to);
    s.setDraft("range." + key, value);
    s.setDraft("range.preset", "custom");
    s.setDraft("range.page", "0");
  }
  let reports: ReturnType<typeof compareReports> | null = remote.live
      ? (remote.data?.report ?? null)
      : null,
    error = "";
  try {
    if (!remote.live) reports = compareReports(s.store, from, to);
  } catch (e) {
    error =
      e instanceof Error ? e.message : "Choose valid start and end dates.";
  }
  const filteredDays = remote.live
    ? (remote.data?.items ?? [])
    : (reports?.current.days ?? []).filter(
        (day) =>
          (!status || day.status === status) && day.date.includes(query.trim()),
      );
  const total = remote.live ? (remote.data?.total ?? 0) : filteredDays.length;
  const page = remote.live
    ? (remote.data?.page ?? requestedPage)
    : Math.min(
        Math.max(0, Number(s.draft("range.page")) || 0),
        Math.max(0, Math.ceil(filteredDays.length / 20) - 1),
      );
  function download() {
    if (remote.live) {
      void downloadReadCsv(
        { resource: "range", from, to },
        `period-report-${from}-${to}.csv`,
      ).catch((error: unknown) =>
        s.setError(
          error instanceof Error
            ? error.message
            : "Cannot download report. Please try again.",
        ),
      );
      return;
    }
    if (!reports) return;
    const { current, previous } = reports;
    const rows: (string | number)[][] = [
      ["Branch", displayName(s.snapshot!.branch.name)],
      ["Currency", "MYR"],
      ["Period", from, to],
      ["Comparison period", previous.from, previous.to],
      [
        "Recorded days",
        current.days.length,
        "Comparison recorded days",
        previous.days.length,
      ],
      [
        "Open days",
        current.openDays,
        "Comparison open days",
        previous.openDays,
      ],
      [
        "Pending requests (excluded from totals)",
        current.pendingRequests,
        "Comparison pending",
        previous.pendingRequests,
      ],
      [
        "Unrecorded dates are not verified zero activity. Totals contain posted entries only.",
      ],
      ["Metric", "Selected period", "Previous period", "Change"],
      ...rangeMetrics.map(([key, label]) => [
        label,
        current.totals[key] / 100,
        previous.days.length ? previous.totals[key] / 100 : "",
        current.days.length && previous.days.length
          ? (current.totals[key] - previous.totals[key]) / 100
          : "",
      ]),
      [
        "Closed-day variance",
        current.variance === null ? "" : current.variance / 100,
        previous.variance === null ? "" : previous.variance / 100,
      ],
      [],
      [
        "Daily balances are individual snapshots and must not be added together.",
      ],
      [
        "Business date",
        "Status",
        "Cash received",
        "Cash payout",
        "Opening cash",
        "Expected cash",
        "Counted cash",
        "Variance",
      ],
      ...current.days.map((d) => [
        d.date,
        d.status,
        d.totals.cashReceived / 100,
        d.totals.cashPayout / 100,
        d.openingCash / 100,
        d.totals.expectedCash / 100,
        d.totals.countedCash === null ? "" : d.totals.countedCash / 100,
        d.totals.variance === null ? "" : d.totals.variance / 100,
      ]),
    ];
    const url = URL.createObjectURL(
      new Blob(["\uFEFF" + toCsv(rows)], { type: "text/csv;charset=utf-8" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `period-report-${from}-${to}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <div className="space-y-4">
      <Panel
        compact
        title="Period summary"
        description="Compare posted cash movements across business dates. Open days are provisional."
        action={
          <Button
            variant="outline"
            className="h-11 sm:h-9"
            onClick={download}
            disabled={!reports?.current.days.length}
          >
            <Download />
            {t("Export period CSV")}
          </Button>
        }
      >
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Period">
            <Select
              value={preset}
              onValueChange={(v) => {
                if (v === "custom") {
                  s.setDraft("range.from", from);
                  s.setDraft("range.to", to);
                }
                s.setDraft("range.preset", v);
                s.setDraft("range.page", "0");
              }}
              options={[
                { value: "week", label: "Last 7 days" },
                { value: "month", label: "Month to date" },
                { value: "last-month", label: "Previous month" },
                { value: "custom", label: "Custom range" },
              ]}
            />
          </Field>
          <Field label="From date">
            <Input
              type="date"
              value={from}
              max={to || undefined}
              onChange={(e) => custom("from", e.target.value)}
            />
          </Field>
          <Field label="To date">
            <Input
              type="date"
              value={to}
              min={from || undefined}
              onChange={(e) => custom("to", e.target.value)}
            />
          </Field>
        </div>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{t(error)}</AlertDescription>
          </Alert>
        )}
        <ReadStatus state={remote} />
        {reports && (
          <>
            <div className="flex flex-wrap gap-2 text-sm">
              <Badge>
                {reports.current.days.length +
                  " / " +
                  reports.current.calendarDays +
                  " " +
                  t("recorded days")}
              </Badge>
              <Badge tone={reports.current.openDays ? "amber" : "neutral"}>
                {reports.current.openDays + " " + t("open days")}
              </Badge>
              <Badge>
                {reports.current.pendingRequests +
                  " " +
                  t("pending requests excluded")}
              </Badge>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {t(
                "Unrecorded dates are not treated as verified zero activity. Opening and closing balances are not added across days.",
              )}
            </p>
            {!reports.current.days.length ? (
              <EmptyState
                title="No business days in this range"
                description="Choose dates that include recorded business days."
              />
            ) : (
              <div className="grid grid-cols-2 gap-2 xl:grid-cols-4">
                <Stat
                  compact
                  label="Cash received"
                  value={money(reports.current.totals.cashReceived)}
                />
                <Stat
                  compact
                  label="Cash payout"
                  value={money(reports.current.totals.cashPayout)}
                />
                <Stat
                  compact
                  label="Net cash movement"
                  value={money(reports.current.totals.netCash)}
                />
                <Stat
                  compact
                  label="Closed-day variance"
                  value={
                    reports.current.variance === null
                      ? "—"
                      : money(reports.current.variance)
                  }
                />
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              {t("Closed-day variance includes counted, closed days only.")}{" "}
              {reports.current.countedDays} {t("counted days")}
            </p>
          </>
        )}
      </Panel>
      {reports && reports.current.days.length > 0 && (
        <>
          <Panel
            compact
            title="Period comparison"
            description="The comparison uses the immediately preceding interval with the same number of calendar days."
          >
            <div className="space-y-1 text-xs leading-relaxed text-muted-foreground">
              <p className="font-medium text-foreground">
                {t("Selected period")}: {from} – {to}
              </p>
              <p>
                {t("Previous period")}: {reports.previous.from} –{" "}
                {reports.previous.to} · {reports.previous.days.length}{" "}
                {t("recorded days")} · {reports.previous.openDays}{" "}
                {t("open days")} · {reports.previous.pendingRequests}{" "}
                {t("pending requests excluded")}
              </p>
            </div>
            {!reports.previous.days.length && (
              <Alert>
                <AlertDescription>
                  {t(
                    "No recorded days in the comparison period. Changes are unavailable.",
                  )}
                </AlertDescription>
              </Alert>
            )}
            <RecordList
              compact
              label="Period comparison"
              rows={rangeMetrics.map(([key, label]) => ({
                key,
                label,
                current: reports!.current.totals[key],
                previous: reports!.previous.totals[key],
              }))}
              rowKey={(r) => r.key}
              columns={[
                {
                  label: "Metric",
                  render: (r) => (
                    <span className="font-medium">{t(r.label)}</span>
                  ),
                },
                {
                  label: "Selected period",
                  align: "right",
                  render: (r) => money(r.current),
                },
                {
                  label: "Previous period",
                  align: "right",
                  render: (r) =>
                    reports!.previous.days.length ? money(r.previous) : "—",
                },
                {
                  label: "Change",
                  align: "right",
                  render: (r) =>
                    reports!.previous.days.length
                      ? money(r.current - r.previous)
                      : "—",
                },
              ]}
            />
          </Panel>
          <Panel
            compact
            title="Daily breakdown"
            description="Each cash balance belongs to its own business day."
          >
            <p className="text-xs leading-relaxed text-muted-foreground">
              {t(
                "List filters only change the rows shown. Report totals and CSV exports include all records in the selected report.",
              )}
            </p>
            <ListToolbar
              compact
              search={query}
              searchLabel="Search daily breakdown"
              searchPlaceholder="Search by business date"
              onSearchChange={(value) => {
                s.setDraft("range.search", value);
                s.setDraft("range.page", "0");
              }}
              activeFilters={
                status
                  ? [
                      {
                        key: "status",
                        label: t("Status") + ": " + t(status),
                        onRemove: () => {
                          s.setDraft("range.status", "");
                          s.setDraft("range.page", "0");
                        },
                      },
                    ]
                  : []
              }
              onClear={clearFilters}
              resultCount={total}
            >
              <Field label="Status">
                <Select
                  value={status}
                  onValueChange={(value) => {
                    s.setDraft("range.status", value);
                    s.setDraft("range.page", "0");
                  }}
                  options={[
                    { value: "", label: "All statuses" },
                    { value: "OPEN", label: "OPEN" },
                    { value: "CLOSED", label: "CLOSED" },
                  ]}
                />
              </Field>
            </ListToolbar>
            {!filteredDays.length ? (
              <EmptyState title="No matching business days">
                <Button variant="outline" onClick={clearFilters}>
                  {t("Clear all")}
                </Button>
              </EmptyState>
            ) : (
              <RecordList
                compact
                wide
                label="Daily breakdown"
                rows={
                  remote.live
                    ? filteredDays
                    : filteredDays.slice(page * 20, page * 20 + 20)
                }
                rowKey={(d) => d.id}
                columns={[
                  {
                    label: "Business date",
                    render: (d) => (
                      <Button
                        variant="link"
                        className="h-11 justify-start px-0 sm:h-9"
                        aria-label={t("View daily report") + ": " + d.date}
                        onClick={() => {
                          s.setDraft("report.day", d.id);
                          s.clearDraft("report.selectedDate");
                          for (const key of [
                            "playerSearch",
                            "playerStatus",
                            "playerPage",
                            "closeSearch",
                            "closePage",
                          ]) {
                            s.setDraft("report." + key, "");
                          }
                          s.setDraft("report.mode", "day");
                        }}
                      >
                        {d.date}
                      </Button>
                    ),
                  },
                  {
                    label: "Status",
                    render: (d) => (
                      <Badge tone={d.status === "OPEN" ? "green" : "neutral"}>
                        {d.status}
                      </Badge>
                    ),
                  },
                  {
                    label: "Cash received",
                    align: "right",
                    render: (d) => money(d.totals.cashReceived),
                  },
                  {
                    label: "Cash payout",
                    align: "right",
                    render: (d) => money(d.totals.cashPayout),
                  },
                  {
                    label: "Expected cash",
                    align: "right",
                    render: (d) => money(d.totals.expectedCash),
                  },
                  {
                    label: "Variance",
                    align: "right",
                    render: (d) =>
                      d.totals.variance === null
                        ? "—"
                        : money(d.totals.variance),
                  },
                ]}
              />
            )}
            <Pager
              label="Daily breakdown"
              page={page}
              total={total}
              setPage={(value) => s.setDraft("range.page", String(value))}
            />
          </Panel>
        </>
      )}
    </div>
  );
}
