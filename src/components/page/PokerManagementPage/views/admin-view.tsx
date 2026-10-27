"use client";
import { useState } from "react";
import { Eye } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { RecordList } from "../components/record-list";
import { ListToolbar } from "../components/list-toolbar";
import { QuickFilters } from "../components/quick-filters";
import { auditChanges, auditReason } from "@/lib/audit-presentation";
import { businessDayDates } from "@/lib/business-day-dates";
import { displayName } from "@/lib/display-name";
import { matchesListSearch } from "@/lib/list-search";
import { shiftDate } from "@/domain/reporting";
import type { AuditLog } from "@/domain/model";
import { usePokerManagementContext } from "../PokerManagementProvider";

import {
  ActionForm,
  Field,
  Pager,
  Panel,
  Modal,
  FormActions,
  FormSection,
  EmptyState,
  useText,
  useTimestamp,
  Select,
} from "../components/shared";
export function AdminView({
  section = "audit",
}: {
  section?: "audit" | "policy" | "recovery";
}) {
  const s = usePokerManagementContext(),
    t = useText(),
    timestamp = useTimestamp();
  const [reopen, setReopen] = useState(false),
    [detail, setDetail] = useState<AuditLog | null>(null);
  const val = (key: string) => s.draft("audit." + key);
  const set = (key: string, value: string) => {
    s.setDraft("audit." + key, value);
    s.setDraft("audit.page", "0");
  };
  const clearCriteria = () =>
    ["search", "staff", "action", "from", "to"].forEach((key) => set(key, ""));
  const { today } = businessDayDates([], s.snapshot!.branch.timezone);
  const weekStart = shiftDate(today, -6);
  const datePreset =
    !val("from") && !val("to")
      ? "all"
      : val("from") === today && val("to") === today
        ? "today"
        : val("from") === weekStart && val("to") === today
          ? "week"
          : "";
  const query = val("search"),
    logs = s.store.auditLogs.filter((log) => {
      const date = new Intl.DateTimeFormat("en-CA", {
        timeZone: s.snapshot!.branch.timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date(log.time));
      return (
        matchesListSearch(query, [
          log.actor,
          displayName(log.actor),
          log.action,
          t(log.action),
          auditReason(log, s.store),
          t(auditReason(log, s.store)),
          log.entity,
        ]) &&
        (!val("staff") || log.actor === val("staff")) &&
        (!val("action") || log.action === val("action")) &&
        (!val("from") || date >= val("from")) &&
        (!val("to") || date <= val("to"))
      );
    });
  const page = Math.min(
    Number(s.draft("audit.page", "0")),
    Math.max(0, Math.ceil(logs.length / 20) - 1),
  );
  if (section === "recovery" && s.user?.role !== "ADMIN") {
    return <EmptyState title="Admin access required." />;
  }
  return (
    <div className="space-y-5">
      {section === "policy" && (
        <Panel title="Approval policy">
          <ul className="list-inside list-disc space-y-2 text-sm">
            {[
              "Every request requires an independent reviewer.",
              "Payouts, reversals, and amounts from RM10,000 require an admin.",
              "Amounts from RM25,000 require two reviewers, including an admin.",
              "Cashiers handle players and cash; dealers submit table entries.",
              "Credit balances only change through approved ledger entries.",
            ].map((text) => (
              <li key={text}>{t(text)}</li>
            ))}
          </ul>
        </Panel>
      )}
      {section === "recovery" && (
        <Panel
          title="Reopen current day"
          description="Previous closing snapshots are preserved."
        >
          <p className="text-sm text-muted-foreground">
            {s.day?.status === "CLOSED"
              ? s.day.date
              : t("Only a closed business day can be reopened.")}
          </p>
          <Button
            variant="outline"
            disabled={s.day?.status !== "CLOSED"}
            onClick={() => {
              s.setError("");
              s.setDraft("reopen.reason", "");
              setReopen(true);
            }}
          >
            {t("Reopen day")}
          </Button>
        </Panel>
      )}
      {section === "audit" && (
        <Panel title="Audit history" compact>
          <QuickFilters
            label="Activity dates"
            value={datePreset}
            onValueChange={(value) => {
              set(
                "from",
                value === "all" ? "" : value === "today" ? today : weekStart,
              );
              set("to", value === "all" ? "" : today);
            }}
            options={[
              { value: "all", label: "All time" },
              { value: "today", label: "Today" },
              { value: "week", label: "Last 7 days" },
            ]}
          />
          <ListToolbar
            compact
            search={val("search")}
            searchLabel="Search audit history"
            searchPlaceholder="Staff, action, reason, or reference"
            onSearchChange={(value) => set("search", value)}
            activeFilters={[
              ["staff", "Staff"],
              ["action", "Action"],
              ["from", "From date"],
              ["to", "To date"],
            ]
              .filter(([key]) => val(key))
              .map(([key, label]) => ({
                key,
                label:
                  t(label) +
                  ": " +
                  t(key === "staff" ? displayName(val(key)) : val(key)),
                onRemove: () => set(key, ""),
                hideChip: (key === "from" || key === "to") && !!datePreset,
              }))}
            onClear={clearCriteria}
            resultCount={logs.length}
          >
            <Field label="Staff">
              <Select
                value={val("staff")}
                onValueChange={(v) => set("staff", v)}
                options={[
                  { value: "", label: "All staff" },
                  ...[...new Set(s.store.auditLogs.map((log) => log.actor))]
                    .sort()
                    .map((value) => ({ value, label: displayName(value) })),
                ]}
              />
            </Field>
            <Field label="Action">
              <Select
                value={val("action")}
                onValueChange={(v) => set("action", v)}
                options={[
                  { value: "", label: "All actions" },
                  ...[...new Set(s.store.auditLogs.map((log) => log.action))]
                    .sort()
                    .map((value) => ({ value, label: value })),
                ]}
              />
            </Field>
            <Field label="From date">
              <Input
                type="date"
                value={val("from")}
                max={val("to") || undefined}
                onChange={(e) => set("from", e.target.value)}
              />
            </Field>
            <Field label="To date">
              <Input
                type="date"
                value={val("to")}
                min={val("from") || undefined}
                onChange={(e) => set("to", e.target.value)}
              />
            </Field>
          </ListToolbar>
          {!logs.length ? (
            <EmptyState
              title={
                s.store.auditLogs.length
                  ? "No matching activity"
                  : "No activity yet"
              }
              description={
                s.store.auditLogs.length
                  ? "Try another search or clear the filters."
                  : "Activity will appear here as staff use this location."
              }
            >
              {s.store.auditLogs.length > 0 && (
                <Button variant="outline" onClick={clearCriteria}>
                  {t("Clear all")}
                </Button>
              )}
            </EmptyState>
          ) : (
            <RecordList
              compact
              label="Audit history"
              rows={logs.slice(page * 20, page * 20 + 20)}
              rowKey={(log) => log.id}
              columns={[
                {
                  label: "Action",
                  render: (log) => (
                    <div className="min-w-0 space-y-0.5">
                      <p className="font-medium [overflow-wrap:anywhere]">
                        {t(log.action)}
                      </p>
                      <p
                        className="max-w-64 truncate text-xs font-normal text-muted-foreground"
                        title={t("Reference") + ": " + log.entity}
                      >
                        {t("Reference")}: {log.entity}
                      </p>
                    </div>
                  ),
                },
                {
                  label: "Staff",
                  mobileSpan: "half",
                  render: (log) => (
                    <span className="[overflow-wrap:anywhere]">
                      {displayName(log.actor)}
                    </span>
                  ),
                },
                {
                  label: "Date",
                  mobileSpan: "half",
                  render: (log) => (
                    <span className="font-normal text-muted-foreground">
                      {timestamp(log.time, s.snapshot!.branch.timezone)}
                    </span>
                  ),
                },
                {
                  label: "Reason",
                  mobileSpan: "full",
                  render: (log) => (
                    <p className="line-clamp-2 max-w-md font-normal [overflow-wrap:anywhere]">
                      {t(auditReason(log, s.store)) || "—"}
                    </p>
                  ),
                },
                {
                  label: "Actions",
                  actions: true,
                  render: (log) => (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="size-11 sm:size-9"
                      title={t("View details")}
                      aria-label={
                        t("View details") +
                        " · " +
                        t(log.action) +
                        " · " +
                        displayName(log.actor) +
                        " · " +
                        timestamp(log.time, s.snapshot!.branch.timezone)
                      }
                      onClick={() => setDetail(log)}
                    >
                      <Eye aria-hidden="true" />
                    </Button>
                  ),
                },
              ]}
            />
          )}
          <Pager
            label="Audit history pages"
            page={page}
            total={logs.length}
            setPage={(p) => s.setDraft("audit.page", String(p))}
          />
        </Panel>
      )}
      {section === "recovery" && (
        <Modal
          open={reopen}
          onOpenChange={setReopen}
          title="Reopen current day"
          description="This enables new operations for the current day. Previous closing snapshots are preserved."
        >
          <ActionForm
            disabled={s.day?.status !== "CLOSED" || s.user?.role !== "ADMIN"}
            onSubmit={() =>
              s.submit({ kind: "REOPEN_DAY", reason: s.draft("reopen.reason") })
            }
            onSuccess={() => {
              setReopen(false);
              s.setDraft("reopen.reason", "");
            }}
          >
            <FormSection title="Current business day">
              <p className="text-sm font-medium">{s.day?.date}</p>
            </FormSection>
            <Field
              label="Reason for change"
              hint="Explain why the day needs to be reopened."
            >
              <Textarea
                required
                minLength={3}
                maxLength={500}
                value={s.draft("reopen.reason")}
                onChange={(e) => s.setDraft("reopen.reason", e.target.value)}
              />
            </Field>
            <FormActions>Reopen business day</FormActions>
          </ActionForm>
        </Modal>
      )}
      {section === "audit" && (
        <Modal
          open={!!detail}
          onOpenChange={(open) => {
            if (!open) setDetail(null);
          }}
          title="Audit details"
          description={
            detail
              ? t(detail.action) + " · " + displayName(detail.actor)
              : "Details"
          }
        >
          {detail && (
            <div className="min-w-0 space-y-4 text-sm">
              <p>{timestamp(detail.time, s.snapshot!.branch.timezone)}</p>
              <p className="[overflow-wrap:anywhere]">
                {t(auditReason(detail, s.store))}
              </p>
              <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                {t("Reference")}: {detail.entity}
              </p>
              {(detail.before || detail.after) && (
                <div className="space-y-3">
                  {auditChanges(detail, s.store).map((change) => (
                    <div
                      key={change.label}
                      className="min-w-0 rounded-lg border p-3"
                    >
                      <p className="font-medium">{t(change.label)}</p>
                      <dl className="mt-2 grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
                        <dt className="text-muted-foreground">{t("Before")}</dt>
                        <dd className="min-w-0 [overflow-wrap:anywhere]">
                          {t(change.before)}
                        </dd>
                        <dt className="text-muted-foreground">{t("After")}</dt>
                        <dd className="min-w-0 [overflow-wrap:anywhere]">
                          {change.label === "Date" && change.after !== "—"
                            ? timestamp(
                                change.after,
                                s.snapshot!.branch.timezone,
                              )
                            : t(change.after)}
                        </dd>
                      </dl>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
