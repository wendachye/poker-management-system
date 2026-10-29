"use client";
import { useState } from "react";
import {
  Download,
  CalendarPlus,
  LockKeyhole,
  CheckCircle2,
  CircleAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { DialogClose } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { RecordList } from "../components/record-list";
import { ListToolbar } from "../components/list-toolbar";
import { RangeReport } from "../components/range-report";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Link } from "@/i18n/navigation";
import { emptyStore, playersForDay, totalsForDay } from "@/domain/selectors";
import type { Player } from "@/domain/model";
import {
  useReadCsvDownload,
  ReadStatus,
  useReadPage,
} from "../components/use-read-page";
import { venueSettings } from "@/domain/settings";
import { businessDayDates } from "@/lib/business-day-dates";
import { closingCashDraft } from "@/lib/closing-cash-draft";
import { displayName } from "@/lib/display-name";
import { matchesListSearch } from "@/lib/list-search";
import { reportDateInput, reportSelection } from "@/lib/report-selection";
import { usePokerManagementContext } from "../PokerManagementProvider";
import { money, parseMoney, toCsv } from "../utils";
import {
  ActionForm,
  Badge,
  Field,
  Panel,
  Pager,
  Select,
  Stat,
  Modal,
  FormActions,
  FormGrid,
  FormSection,
  MoneyInput,
  EmptyState,
  useText,
  useTimestamp,
} from "../components/shared";
export function ReportsView() {
  const s = usePokerManagementContext(),
    t = useText(),
    timestamp = useTimestamp();
  const [opening, setOpening] = useState(false),
    [closing, setClosing] = useState(false);
  const [closingDayId, setClosingDayId] = useState("");
  const csvDownload = useReadCsvDownload();
  const val = (key: string, fallback = "") =>
      s.draft("report." + key, fallback),
    set = (key: string, v: string) => s.setDraft("report." + key, v);
  const selected = val("day") || s.store.currentDayId || "";
  const selectedDate = s.draftValue("report.selectedDate");
  const requestedPage = Math.max(0, Number(val("playerPage")) || 0);
  const remote = useReadPage<Player>(
    {
      resource: "report",
      ...reportSelection(selectedDate, val("day"), s.store.currentDayId),
      query: val("playerSearch"),
      status: val("playerStatus"),
      page: requestedPage,
    },
    val("mode", "day") === "day" && !!(selected || selectedDate),
  );
  const day = remote.live
    ? remote.data?.day
    : s.store.days.find((d) => d.id === selected);
  const totals = remote.live
    ? (remote.data?.totals ?? totalsForDay(emptyStore()))
    : totalsForDay(s.store, selected);
  const localPlayers = remote.live
    ? []
    : playersForDay(s.store, selected).filter((p) =>
        s.store.sessions.some(
          (session) => session.playerId === p.id && session.dayId === selected,
        ),
      );
  const players = remote.live ? (remote.data?.items ?? []) : localPlayers;
  const filteredPlayers = remote.live
    ? players
    : players.filter(
        (player) =>
          (!val("playerStatus") || player.status === val("playerStatus")) &&
          matchesListSearch(
            val("playerSearch"),
            [displayName(player.name)],
            [player.phone],
          ),
      );
  const playerTotal = remote.live
    ? (remote.data?.total ?? 0)
    : filteredPlayers.length;
  const playerPage = remote.live
    ? (remote.data?.page ?? requestedPage)
    : Math.min(
        Math.max(0, Number(val("playerPage")) || 0),
        Math.max(0, Math.ceil(filteredPlayers.length / 20) - 1),
      );
  const closes = day?.closes.toReversed() ?? [];
  const filteredCloses = closes.filter((close) =>
    matchesListSearch(val("closeSearch"), [close.actor, close.reason]),
  );
  const closePage = Math.min(
    Math.max(0, Number(val("closePage")) || 0),
    Math.max(0, Math.ceil(filteredCloses.length / 20) - 1),
  );
  function clearPlayerFilters() {
    for (const key of ["playerSearch", "playerStatus", "playerPage"])
      set(key, "");
  }
  function clearCloseFilters() {
    set("closeSearch", "");
    set("closePage", "0");
  }
  function selectDay(id: string) {
    set("day", id);
    s.clearDraft("report.selectedDate");
    clearPlayerFilters();
    clearCloseFilters();
  }
  const supervisor = ["MANAGER", "ADMIN"].includes(s.user!.role);
  const setupComplete = venueSettings(s.store).setupCompleted;
  const { today, defaultDate, minDate } = businessDayDates(
    s.store.days,
    s.snapshot!.branch.timezone,
  );
  const ready =
    !s.locked &&
    !s.activePlayers.length &&
    !(s.store.readModel?.pendingCurrent ?? s.pendingApprovals.length);
  const reconciliation = closingCashDraft(
    val("count"),
    s.totals.expectedCash,
    val("reason"),
  );
  const { countedCash: counted, variance } = reconciliation;
  const closingDay = s.store.days.find((entry) => entry.id === closingDayId);
  const closingDayMatches = closingDayId === s.store.currentDayId;
  function varianceLabel(value: number) {
    return value < 0
      ? "Cash short by"
      : value > 0
        ? "Cash over by"
        : "Cash matches expected";
  }
  function varianceSummary(value: number) {
    return (
      t(varianceLabel(value)) +
      (value === 0 ? "" : " " + money(Math.abs(value)))
    );
  }
  function download() {
    if (remote.live) {
      if (!remote.data || remote.loading || remote.error || csvDownload.busy)
        return;
      s.setError("");
      void csvDownload
        .download(
          {
            resource: "report",
            dayId: day?.id,
            date: selectedDate || undefined,
          },
          "daily-close-" + (day?.date ?? "report") + ".csv",
          remote.data.context,
        )
        .catch((error: unknown) =>
          s.setError(
            error instanceof Error
              ? error.message
              : "Cannot download report. Please try again.",
          ),
        );
      return;
    }
    const rows: (string | number)[][] = [
      ["Branch", displayName(s.snapshot!.branch.name)],
      ["Business date", day?.date ?? ""],
      ["Currency", "MYR"],
      ["Metric", "Amount"],
      ["Opening cash", totals.openingCash / 100],
      ["Cash received", totals.cashReceived / 100],
      ["Cash payout", totals.cashPayout / 100],
      ["Expected cash", totals.expectedCash / 100],
      [
        "Counted cash",
        totals.countedCash === null ? "" : totals.countedCash / 100,
      ],
      ["Variance", totals.variance === null ? "" : totals.variance / 100],
      [],
      ["Player", "Buy-in", "Cash-out", "Settled P/L", "Status"],
      ...players.map((p) => [
        displayName(p.name),
        p.buyIn / 100,
        p.cashOut / 100,
        p.status === "ACTIVE" ? "Unsettled" : (p.cashOut - p.buyIn) / 100,
        p.status,
      ]),
    ];
    const url = URL.createObjectURL(
      new Blob(["\uFEFF" + toCsv(rows)], { type: "text/csv;charset=utf-8" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "daily-close-" + (day?.date ?? "report") + ".csv";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <div className="space-y-4">
      <div className="flex min-w-0 flex-col gap-3 rounded-lg border bg-muted/20 p-3 sm:flex-row sm:items-center sm:justify-between sm:px-4">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">
              {t("Current business day")}: {s.day?.date ?? t("Not opened")}
            </span>
            <Badge tone={s.locked ? "neutral" : "green"}>
              {s.locked ? "Day closed" : "Day open"}
            </Badge>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {t("Day controls always apply to the current business day.")}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2 [&>a]:w-full [&>button]:h-auto [&>button]:min-h-11 [&>button]:w-full [&>button]:whitespace-normal sm:[&>a]:w-auto sm:[&>button]:min-h-9 sm:[&>button]:w-auto">
          {supervisor &&
            (s.locked && !setupComplete ? (
              s.user?.role === "ADMIN" ? (
                <Button asChild>
                  <Link href="/settings">{t("Set up venue")}</Link>
                </Button>
              ) : (
                <Button disabled>{t("Setup required")}</Button>
              )
            ) : s.locked ? (
              <Button
                onClick={() => {
                  s.setError("");
                  set("opening", "");
                  set("date", defaultDate);
                  setOpening(true);
                }}
              >
                <CalendarPlus />
                {t(s.day ? "Open next business day" : "Open business day")}
              </Button>
            ) : (
              <Button
                onClick={() => {
                  s.setError("");
                  set("count", "");
                  set("reason", "");
                  set("date", "");
                  set("opening", "");
                  setClosingDayId(s.day?.id ?? "");
                  setClosing(true);
                }}
              >
                <LockKeyhole />
                {t("Close current day")} · {s.day?.date}
              </Button>
            ))}
        </div>
      </div>
      <Tabs value={val("mode", "day")} onValueChange={(v) => set("mode", v)}>
        <TabsList
          variant="line"
          className="border-b pb-2"
          aria-label={t("Report view")}
        >
          <TabsTrigger value="day">{t("Daily report")}</TabsTrigger>
          <TabsTrigger value="range">{t("Date range")}</TabsTrigger>
        </TabsList>
        <TabsContent value="range">
          <RangeReport today={today} />
        </TabsContent>
        <TabsContent value="day" className="space-y-4">
          {day && day.id !== s.store.currentDayId && (
            <Alert>
              <AlertDescription>
                {t("You are viewing a historical report.")} {day.date}
                <Button size="sm" variant="link" onClick={() => selectDay("")}>
                  {t("Back to current day")}
                </Button>
              </AlertDescription>
            </Alert>
          )}
          {remote.live && (
            <div className="max-w-sm">
              <Field label="Report date">
                <Input
                  type="date"
                  value={reportDateInput(selectedDate, day?.date, s.day?.date)}
                  onChange={(event) => {
                    set("selectedDate", event.target.value);
                    set("day", "");
                    clearPlayerFilters();
                    clearCloseFilters();
                  }}
                />
              </Field>
            </div>
          )}
          <ReadStatus state={remote} />
          {!day && (remote.loading || remote.error) ? null : !day ? (
            <EmptyState
              title="No business day yet"
              description={
                supervisor
                  ? "Open a business day and enter the opening cash to start operations."
                  : "Ask a manager to open a business day."
              }
            />
          ) : (
            <>
              <Panel
                compact
                title="Daily report"
                action={
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={day.status === "OPEN" ? "green" : "neutral"}>
                      {day.status}
                    </Badge>
                    <Button
                      variant="outline"
                      className="h-11 sm:h-9"
                      onClick={download}
                      aria-busy={csvDownload.busy}
                      disabled={
                        csvDownload.busy ||
                        (remote.live &&
                          (remote.loading || !!remote.error || !remote.data))
                      }
                    >
                      <Download />
                      {t(
                        csvDownload.busy
                          ? "Preparing CSV…"
                          : "Export daily CSV",
                      )}
                    </Button>
                  </div>
                }
              >
                {!remote.live && (
                  <div className="max-w-sm">
                    <Field label="Report date">
                      <Select
                        value={selected}
                        onValueChange={selectDay}
                        options={s.store.days.toReversed().map((d) => ({
                          value: d.id,
                          label: d.date + " · " + t(d.status),
                        }))}
                      />
                    </Field>
                  </div>
                )}
                <div className="grid grid-cols-2 gap-2 xl:grid-cols-3">
                  {[
                    ["Expected cash", money(totals.expectedCash)],
                    [
                      "Counted cash",
                      totals.countedCash === null
                        ? t("Not counted")
                        : money(totals.countedCash),
                    ],
                    [
                      totals.variance === null
                        ? "Variance"
                        : varianceLabel(totals.variance),
                      totals.variance === null
                        ? "—"
                        : money(Math.abs(totals.variance)),
                    ],
                    ["Opening cash", money(totals.openingCash)],
                    ["Cash received", money(totals.cashReceived)],
                    ["Cash payout", money(totals.cashPayout)],
                  ].map(([label, value]) => (
                    <Stat compact key={label} label={label} value={value} />
                  ))}
                </div>
              </Panel>
              <Panel
                compact
                title="Player results"
                description="List filters only change the rows shown. Report totals and CSV exports include all records in the selected report."
              >
                {(remote.live || players.length > 0) && (
                  <ListToolbar
                    compact
                    search={val("playerSearch")}
                    searchLabel="Search player results"
                    searchPlaceholder="Search by name or phone"
                    onSearchChange={(value) => {
                      set("playerSearch", value);
                      set("playerPage", "0");
                    }}
                    activeFilters={
                      val("playerStatus")
                        ? [
                            {
                              key: "status",
                              label:
                                t("Status") + ": " + t(val("playerStatus")),
                              onRemove: () => {
                                set("playerStatus", "");
                                set("playerPage", "0");
                              },
                            },
                          ]
                        : []
                    }
                    onClear={clearPlayerFilters}
                    resultCount={playerTotal}
                  >
                    <Field label="Status">
                      <Select
                        value={val("playerStatus")}
                        onValueChange={(value) => {
                          set("playerStatus", value);
                          set("playerPage", "0");
                        }}
                        options={[
                          { value: "", label: "All statuses" },
                          { value: "ACTIVE", label: "ACTIVE" },
                          { value: "OUT", label: "OUT" },
                        ]}
                      />
                    </Field>
                  </ListToolbar>
                )}
                {!players.length &&
                !val("playerSearch") &&
                !val("playerStatus") ? (
                  <EmptyState title="No visits for this day" />
                ) : !filteredPlayers.length ? (
                  <EmptyState title="No matching player results">
                    <Button variant="outline" onClick={clearPlayerFilters}>
                      {t("Clear all")}
                    </Button>
                  </EmptyState>
                ) : (
                  <RecordList
                    compact
                    label="Player results"
                    rows={
                      remote.live
                        ? filteredPlayers
                        : filteredPlayers.slice(
                            playerPage * 20,
                            playerPage * 20 + 20,
                          )
                    }
                    rowKey={(p) => p.id}
                    columns={[
                      {
                        label: "Player",
                        render: (p) => (
                          <span className="font-medium [overflow-wrap:anywhere]">
                            {displayName(p.name)}
                          </span>
                        ),
                      },
                      {
                        label: "Buy-in",
                        align: "right",
                        render: (p) => money(p.buyIn),
                      },
                      {
                        label: "Cash-out",
                        align: "right",
                        render: (p) => money(p.cashOut),
                      },
                      {
                        label: "P/L",
                        align: "right",
                        render: (p) =>
                          p.status === "ACTIVE"
                            ? t("Unsettled")
                            : money(p.cashOut - p.buyIn),
                      },
                      {
                        label: "Status",
                        render: (p) => <Badge>{p.status}</Badge>,
                      },
                    ]}
                  />
                )}
                <Pager
                  label="Player results"
                  page={playerPage}
                  total={playerTotal}
                  setPage={(page) => set("playerPage", String(page))}
                />
              </Panel>
              <Panel compact title="Closing history">
                {closes.length > 0 && (
                  <ListToolbar
                    compact
                    search={val("closeSearch")}
                    searchLabel="Search closing history"
                    searchPlaceholder="Search by staff or reason"
                    onSearchChange={(value) => {
                      set("closeSearch", value);
                      set("closePage", "0");
                    }}
                    onClear={clearCloseFilters}
                    resultCount={filteredCloses.length}
                  />
                )}
                {!day.closes.length ? (
                  <EmptyState title="No closing snapshot yet." />
                ) : !filteredCloses.length ? (
                  <EmptyState title="No matching closing snapshots">
                    <Button variant="outline" onClick={clearCloseFilters}>
                      {t("Clear all")}
                    </Button>
                  </EmptyState>
                ) : (
                  <RecordList
                    compact
                    label="Closing history"
                    rows={filteredCloses.slice(
                      closePage * 20,
                      closePage * 20 + 20,
                    )}
                    rowKey={(close) => close.time}
                    columns={[
                      {
                        label: "Date",
                        render: (close) =>
                          timestamp(close.time, s.snapshot!.branch.timezone),
                      },
                      {
                        label: "Staff",
                        render: (close) => displayName(close.actor),
                      },
                      {
                        label: "Counted cash",
                        align: "right",
                        render: (close) => money(close.countedCash),
                      },
                      {
                        label: "Variance",
                        align: "right",
                        render: (close) => (
                          <div
                            className={
                              close.variance < 0
                                ? "font-semibold text-destructive"
                                : ""
                            }
                          >
                            <p className="text-xs font-medium">
                              {t(varianceLabel(close.variance))}
                            </p>
                            <p className="tabular-nums">
                              {money(Math.abs(close.variance))}
                            </p>
                          </div>
                        ),
                      },
                      {
                        label: "Reason",
                        mobileSpan: "full",
                        render: (close) => (
                          <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">
                            {close.reason || "—"}
                          </span>
                        ),
                      },
                    ]}
                  />
                )}
                <Pager
                  label="Closing history"
                  page={closePage}
                  total={filteredCloses.length}
                  setPage={(page) => set("closePage", String(page))}
                />
              </Panel>
            </>
          )}
        </TabsContent>
      </Tabs>
      <Modal
        open={opening}
        onOpenChange={(open) => {
          setOpening(open);
          if (!open) {
            set("date", "");
            set("opening", "");
          }
        }}
        title="Open business day"
        description="Confirm the business date and the cash available before operations begin."
      >
        <ActionForm
          disabled={!s.locked || !supervisor}
          onSubmit={() =>
            s.submit({
              kind: "OPEN_DAY",
              date: val("date", defaultDate),
              openingCash: parseMoney(val("opening"), true),
            })
          }
          onSuccess={() => {
            setOpening(false);
            selectDay("");
            for (const k of ["date", "count", "reason", "opening"]) set(k, "");
          }}
        >
          <FormSection title="Business day details">
            <FormGrid>
              <Field label="Business date">
                <Input
                  required
                  type="date"
                  min={minDate}
                  value={val("date", defaultDate)}
                  onChange={(e) => set("date", e.target.value)}
                />
              </Field>
              <Field
                label="Opening cash (RM)"
                hint="Enter the counted cash float. Enter 0 if there is none."
              >
                <MoneyInput
                  required
                  value={val("opening")}
                  onChange={(e) => set("opening", e.target.value)}
                />
              </Field>
            </FormGrid>
          </FormSection>
          <FormActions>Open business day</FormActions>
        </ActionForm>
      </Modal>
      <Modal
        open={closing}
        onOpenChange={setClosing}
        title="Close business day"
        description={
          (closingDay?.date ?? "") +
          " · " +
          t("Count the cash physically available, then review the difference.")
        }
      >
        {!closingDayMatches ? (
          <Alert variant="warning">
            <AlertDescription>
              {t(
                "The active business day changed. Reopen the closing form and review its totals.",
              )}
            </AlertDescription>
          </Alert>
        ) : s.locked ? (
          <Alert>
            <AlertDescription>
              {t("The business day is closed.")}
            </AlertDescription>
          </Alert>
        ) : !ready ? (
          <FormSection title="Closing checklist">
            <p className="text-sm text-muted-foreground">
              {t("Complete these items before counting cash.")}
            </p>
            {[
              {
                count:
                  s.store.readModel?.pendingCurrent ??
                  s.pendingApprovals.length,
                label: "pending approvals",
                href: "/transactions",
                action: "Review requests",
              },
              {
                count: s.activePlayers.length,
                label: "active players",
                href: "/players",
                action: "Check out players",
              },
            ]
              .filter((item) => item.count > 0)
              .map(({ count, label, href, action }) => (
                <div
                  key={label}
                  className="flex flex-wrap items-center gap-2 rounded-lg border p-3 text-sm"
                >
                  <CircleAlert
                    className="size-4 shrink-0 text-amber-600"
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1">
                    {count} {t(label)}
                  </span>
                  <Button
                    variant="link"
                    size="sm"
                    className="ml-auto h-11 shrink-0 sm:h-9"
                    asChild
                  >
                    <Link
                      href={href}
                      onClick={() => {
                        if (href === "/players") {
                          s.setDraft("player.status", "ACTIVE");
                          s.setDraft("player.search", "");
                          s.setDraft("player.type", "");
                          s.setDraft("player.tag", "");
                          s.setDraft("player.page", "0");
                        } else if (href === "/transactions") {
                          s.setDraft("tx.status", "PENDING");
                          s.setDraft("tx.day", s.store.currentDayId ?? "");
                          s.setDraft("tx.filter", "");
                          s.setDraft("tx.search", "");
                          s.setDraft("tx.page", "0");
                        }
                        setClosing(false);
                      }}
                    >
                      {t(action)}
                    </Link>
                  </Button>
                </div>
              ))}
          </FormSection>
        ) : (
          <div
            className="flex items-center gap-2 rounded-lg border bg-muted/20 p-3 text-sm"
            role="status"
          >
            <CheckCircle2
              className="size-4 shrink-0 text-emerald-600"
              aria-hidden="true"
            />
            <span>{t("Ready to close")}</span>
          </div>
        )}
        {(!ready || !closingDayMatches) && (
          <DialogClose asChild>
            <Button variant="outline" className="h-11 w-full">
              {t("Cancel")}
            </Button>
          </DialogClose>
        )}
        {ready && closingDayMatches && (
          <ActionForm
            disabled={!ready || !supervisor || !closingDayMatches}
            validationKey={`${closingDayId}:${variance !== null && variance !== 0}`}
            onSubmit={() =>
              s.submit({
                kind: "CLOSE_DAY",
                dayId: closingDayId,
                countedCash: parseMoney(val("count"), true),
                reason: val("reason"),
              })
            }
            onSuccess={() => {
              setClosing(false);
              selectDay("");
              set("date", "");
              set("opening", "");
              set("count", "");
              set("reason", "");
            }}
          >
            <FormSection title="Cash reconciliation">
              <Stat
                compact
                label="Expected cash"
                value={money(s.totals.expectedCash)}
              />
              <Field
                label="Counted cash (RM)"
                hint="Count the cash physically available. Enter 0 if there is none."
              >
                <MoneyInput
                  required
                  value={val("count")}
                  onChange={(e) => set("count", e.target.value)}
                />
              </Field>
              {variance !== null && (
                <Alert variant={variance !== 0 ? "warning" : "success"}>
                  <AlertDescription>
                    <p className="font-semibold">{varianceSummary(variance)}</p>
                  </AlertDescription>
                </Alert>
              )}
              {variance !== null && (variance !== 0 || val("reason")) && (
                <Field
                  label={
                    variance !== 0 ? "Variance explanation" : "Closing note"
                  }
                  optional={variance === 0}
                  hint={
                    variance !== 0
                      ? "Explain the difference in at least 3 characters."
                      : "This note will be saved with the closing. Edit or clear it if the count changed."
                  }
                >
                  <Textarea
                    required={variance !== 0}
                    minLength={variance !== 0 ? 3 : undefined}
                    maxLength={500}
                    value={val("reason")}
                    onChange={(e) => set("reason", e.target.value)}
                  />
                </Field>
              )}
            </FormSection>
            <FormActions
              disabled={!reconciliation.valid}
              summary={
                <div className="min-w-0 space-y-1 text-xs">
                  <p className="text-muted-foreground">{closingDay?.date}</p>
                  {counted === null ? (
                    <p>{t("Enter the counted cash to continue.")}</p>
                  ) : (
                    <>
                      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                        <span className="text-muted-foreground">
                          {t("Counted cash")}
                        </span>
                        <span className="text-sm font-semibold tabular-nums">
                          {money(counted)}
                        </span>
                      </div>
                      <p>{varianceSummary(variance!)}</p>
                      {!reconciliation.valid && (
                        <p className="text-muted-foreground">
                          {t("Explain the difference before closing.")}
                        </p>
                      )}
                    </>
                  )}
                </div>
              }
            >
              Close business day
            </FormActions>
          </ActionForm>
        )}
      </Modal>
    </div>
  );
}
