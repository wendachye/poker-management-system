"use client";
import { ApprovalQueue } from "../components/approval-queue";
import { filterRequests, type RequestView } from "@/domain/request-filters";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useState } from "react";
import { Plus, ReceiptText, RotateCcw } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  TableHeader,
  TableHead,
  TableRow,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import { Receipt } from "../components/receipt";
import type { Transaction } from "@/domain/model";
import { usePokerManagementContext } from "../PokerManagementProvider";
import { money } from "../utils";
import { displayName } from "@/lib/display-name";
import {
  ActionForm,
  Field,
  Pager,
  Select,
  Modal,
  FormActions,
  FormSection,
  EmptyState,
  DayNotice,
  useText,
  useTimestamp,
} from "../components/shared";
import { entryTypes as types } from "../components/operation-dialogs";
import { ListToolbar } from "../components/list-toolbar";
import { RecordTable } from "../components/record-list";
import { RowActions, type RowAction } from "../components/row-actions";
export function TransactionsView() {
  const s = usePokerManagementContext(),
    t = useText(),
    timestamp = useTimestamp();
  const [receipt, setReceipt] = useState<Transaction | null>(null),
    [reversing, setReversing] = useState<Transaction | null>(null);
  const val = (key: string, fallback = "") => s.draft("tx." + key, fallback),
    set = (key: string, v: string) => s.setDraft("tx." + key, v);
  const status = val("status", "PENDING") as RequestView;
  const requestFilters = {
    userId: s.user?.id,
    dayId: val("day", s.store.currentDayId ?? ""),
    type: val("filter"),
    query: val("search"),
  };
  const requests = filterRequests(s.store, { ...requestFilters, view: status });
  const clearFilters = () => {
    set("day", "");
    set("filter", "");
    set("search", "");
    set("page", "0");
  };
  const activeFilters = [
    ...(requestFilters.dayId
      ? [
          {
            key: "day",
            label:
              t("Business day") +
              ": " +
              (s.store.days.find((day) => day.id === requestFilters.dayId)
                ?.date ?? requestFilters.dayId),
            onRemove: () => {
              set("day", "");
              set("page", "0");
            },
          },
        ]
      : []),
    ...(requestFilters.type
      ? [
          {
            key: "type",
            label: t("Transaction type") + ": " + t(requestFilters.type),
            onRemove: () => {
              set("filter", "");
              set("page", "0");
            },
          },
        ]
      : []),
  ];
  const approvedIds = new Set(
    filterRequests(s.store, { ...requestFilters, view: "APPROVED" }).map(
      (r) => r.id,
    ),
  );
  const transactions = s.store.transactions.filter((tx) =>
    approvedIds.has(tx.approvalId),
  );
  const page = Math.min(
    Number(val("page", "0")),
    Math.max(0, Math.ceil(transactions.length / 20) - 1),
  );
  const quickActions: RowAction[] = [
    ...(s.user?.role !== "DEALER"
      ? ([
          {
            key: "buy-in",
            label: "Buy-in",
            disabled: s.locked || !s.activePlayers.length,
            onSelect: () =>
              s.startOperation({ kind: "transaction", type: "Buy-in" }),
          },
          {
            key: "cash-out",
            label: "Cash-out",
            disabled: s.locked || !s.activePlayers.length,
            onSelect: () =>
              s.startOperation({ kind: "transaction", type: "Cash-out" }),
          },
          {
            key: "repay",
            label: "Credit Repayment",
            disabled: s.locked || !s.players.some((p) => p.creditUsed > 0),
            onSelect: () =>
              s.startOperation({
                kind: "transaction",
                type: "Credit Repayment",
              }),
          },
        ] satisfies RowAction[])
      : []),
    {
      key: "table-entry",
      label: "Table entry",
      disabled: s.locked || !s.tables.some((table) => table.status === "OPEN"),
      onSelect: () => s.startOperation({ kind: "transaction", type: "Rake" }),
    },
  ];
  function subject(tx: Transaction) {
    return [
      displayName(
        s.players.find((p) => p.id === tx.playerId)?.name ?? t("House"),
      ),
      displayName(
        s.tables.find((table) => table.id === tx.tableId)?.name ?? "",
      ),
    ]
      .filter(Boolean)
      .join(" · ");
  }
  function rowActions(tx: Transaction) {
    const canReverse =
      !tx.reversesId &&
      !s.store.transactions.some((entry) => entry.reversesId === tx.id) &&
      tx.dayId === s.store.currentDayId &&
      s.user?.role !== "DEALER";
    return (
      <div className="flex shrink-0 items-center gap-1.5">
        <Button
          variant="outline"
          size="icon-sm"
          className="size-11 sm:size-9"
          title={t("Receipt")}
          aria-label={t("Receipt") + " · " + t(tx.type) + " · " + tx.id}
          onClick={() => setReceipt(tx)}
        >
          <ReceiptText />
        </Button>
        {canReverse && (
          <RowActions
            iconOnly
            label={t("Transaction actions") + " · " + tx.id}
            actions={[
              {
                key: "reverse",
                label: t("Request reversal"),
                icon: RotateCcw,
                destructive: true,
                disabled:
                  s.busy ||
                  s.locked ||
                  s.pendingApprovals.some((p) => p.reversesId === tx.id),
                description: s.pendingApprovals.some(
                  (p) => p.reversesId === tx.id,
                )
                  ? "Resolve pending request first"
                  : undefined,
                onSelect: () => {
                  set("reason", "");
                  s.setError("");
                  setReversing(tx);
                },
              },
            ]}
          />
        )}
      </div>
    );
  }
  return (
    <div className="space-y-5">
      <DayNotice />
      <Card className="@container/transactions gap-0 py-0 sm:py-0">
        <div className="space-y-3 p-3 sm:p-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="min-w-0 text-sm font-semibold">
              {t("Transactions and requests")}
            </h2>
            <div className="flex shrink-0 items-center gap-1.5">
              <Button
                className="size-11 p-0 sm:h-9 sm:w-auto sm:px-3"
                aria-label={t("New transaction")}
                title={t("New transaction")}
                disabled={s.locked}
                onClick={() => {
                  s.setError("");
                  s.startOperation({ kind: "transaction" });
                }}
              >
                <Plus />
                <span className="hidden sm:inline">{t("New transaction")}</span>
              </Button>
              <div className="sm:hidden">
                <RowActions
                  label={t("Transaction actions")}
                  actions={quickActions}
                  iconOnly
                />
              </div>
            </div>
          </div>
          <div className="hidden flex-wrap gap-1.5 sm:flex">
            {quickActions.map((action) => (
              <Button
                key={action.key}
                type="button"
                variant="outline"
                size="sm"
                className="h-9"
                disabled={action.disabled}
                onClick={action.onSelect}
              >
                {t(action.label)}
              </Button>
            ))}
          </div>
          <ListToolbar
            compact
            search={val("search")}
            searchLabel="Search transactions"
            searchPlaceholder="Player, table, staff, or reference"
            onSearchChange={(v) => {
              set("search", v);
              set("page", "0");
            }}
            activeFilters={activeFilters}
            onClear={clearFilters}
            resultCount={
              status === "APPROVED" ? transactions.length : requests.length
            }
          >
            <Field label="Business day">
              <Select
                value={val("day", s.store.currentDayId ?? "")}
                onValueChange={(v) => {
                  set("day", v);
                  set("page", "0");
                }}
                options={[
                  { value: "", label: "All days" },
                  ...s.store.days
                    .toReversed()
                    .map((d) => ({ value: d.id, label: d.date })),
                ]}
              />
            </Field>
            <Field label="Transaction type">
              <Select
                value={val("filter")}
                onValueChange={(v) => {
                  set("filter", v);
                  set("page", "0");
                }}
                options={[
                  { value: "", label: "All types" },
                  ...[...types, "Reversal"].map((v) => ({
                    value: v,
                    label: v,
                  })),
                ]}
              />
            </Field>
          </ListToolbar>
        </div>
        <Tabs
          value={status}
          onValueChange={(v) => {
            set("status", v);
            set("page", "0");
          }}
        >
          <div className="min-w-0 px-3 pb-1 sm:px-4">
            <TabsList
              variant="line"
              className="grid !h-auto w-full grid-cols-4 gap-1 p-0"
              aria-label={t("Request status")}
            >
              {[
                ["PENDING", "Pending"],
                ["APPROVED", "Approved"],
                ["REJECTED", "Rejected"],
                ["MINE", "My requests"],
              ].map(([value, label]) => (
                <TabsTrigger
                  key={value}
                  value={value}
                  className="h-11 min-w-0 flex-col gap-0.5 px-1 text-[11px] leading-4 sm:h-9 sm:flex-row sm:gap-1.5 sm:px-3 sm:text-sm"
                >
                  <span>{t(label)}</span>
                  <span className="text-[10px] tabular-nums sm:text-xs">
                    (
                    {
                      filterRequests(s.store, {
                        ...requestFilters,
                        view: value as RequestView,
                      }).length
                    }
                    )
                  </span>
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
          <TabsContent value="APPROVED" className="space-y-3">
            {!transactions.length ? (
              <EmptyState
                title={
                  s.store.transactions.length
                    ? "No transactions match these filters."
                    : "No approved transactions yet"
                }
                description={
                  s.store.transactions.length
                    ? "Try another search or clear the filters."
                    : "Approved transactions will appear here. Check the approval queue for pending requests."
                }
              >
                {!!s.store.transactions.length &&
                  (activeFilters.length > 0 || !!val("search").trim()) && (
                    <Button variant="outline" onClick={clearFilters}>
                      {t("Clear all")}
                    </Button>
                  )}
              </EmptyState>
            ) : (
              <>
                <ul
                  aria-label={t("Transactions")}
                  className="divide-y border-y @min-[900px]/transactions:hidden"
                >
                  {transactions.slice(page * 20, page * 20 + 20).map((tx) => (
                    <li
                      key={tx.id}
                      className="min-w-0 space-y-2 px-3 py-3 sm:px-4"
                      data-transaction-row
                    >
                      <div className="flex min-w-0 items-start justify-between gap-3 font-medium">
                        <span className="min-w-0 break-words">
                          {t(tx.type)}
                        </span>
                        <span className="shrink-0 whitespace-nowrap tabular-nums">
                          {money(tx.amount)}
                        </span>
                      </div>
                      <p
                        className="line-clamp-2 break-words text-sm [overflow-wrap:anywhere]"
                        title={subject(tx)}
                      >
                        {subject(tx)}
                      </p>
                      <div className="flex min-w-0 items-end justify-between gap-2">
                        <p className="min-w-0 text-xs leading-4 text-muted-foreground">
                          <span className="line-clamp-1 break-all">
                            {displayName(tx.staff)}
                          </span>
                          <span className="block">
                            {timestamp(tx.time, s.snapshot!.branch.timezone)}
                          </span>
                        </p>
                        {rowActions(tx)}
                      </div>
                    </li>
                  ))}
                </ul>
                <div className="hidden px-4 @min-[900px]/transactions:block [&>div]:block [&_table]:table-fixed">
                  <RecordTable label="Transactions">
                    <TableHeader>
                      <TableRow>
                        {[
                          "Transaction",
                          "Player / table",
                          "Amount",
                          "Staff",
                          "Actions",
                        ].map((x) => (
                          <TableHead
                            key={x}
                            scope="col"
                            className={
                              x === "Amount"
                                ? "w-44 text-right"
                                : x === "Actions"
                                  ? "w-28 text-right"
                                  : x === "Staff"
                                    ? "w-32"
                                    : undefined
                            }
                          >
                            {t(x)}
                          </TableHead>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {transactions
                        .slice(page * 20, page * 20 + 20)
                        .map((tx) => (
                          <TableRow key={tx.id} data-transaction-row>
                            <TableCell className="whitespace-normal py-2">
                              <p className="break-words font-medium">
                                {t(tx.type)}
                              </p>
                              <p className="mt-1 text-xs leading-4 text-muted-foreground">
                                {timestamp(
                                  tx.time,
                                  s.snapshot!.branch.timezone,
                                )}
                              </p>
                            </TableCell>
                            <TableCell className="whitespace-normal py-2">
                              <p className="line-clamp-2 break-words [overflow-wrap:anywhere]">
                                {displayName(
                                  s.players.find((p) => p.id === tx.playerId)
                                    ?.name ?? t("House"),
                                )}
                              </p>
                              <p className="mt-1 line-clamp-1 break-words text-xs text-muted-foreground [overflow-wrap:anywhere]">
                                {displayName(
                                  s.tables.find(
                                    (table) => table.id === tx.tableId,
                                  )?.name ?? "—",
                                )}
                              </p>
                            </TableCell>
                            <TableCell className="py-2 text-right font-medium tabular-nums">
                              {money(tx.amount)}
                            </TableCell>
                            <TableCell className="whitespace-normal py-2 text-xs">
                              <span className="line-clamp-2 break-words [overflow-wrap:anywhere]">
                                {displayName(tx.staff)}
                              </span>
                            </TableCell>
                            <TableCell className="py-2">
                              <div className="flex justify-end">
                                {rowActions(tx)}
                              </div>
                            </TableCell>
                          </TableRow>
                        ))}
                    </TableBody>
                  </RecordTable>
                </div>
              </>
            )}
            <div className="px-3 pb-3 sm:px-4 sm:pb-4">
              <Pager
                page={page}
                total={transactions.length}
                setPage={(p) => set("page", String(p))}
                label="Transaction pagination"
              />
            </div>
          </TabsContent>
          {["PENDING", "REJECTED", "MINE"].map((view) => (
            <TabsContent
              key={view}
              value={view}
              className="px-3 pb-3 sm:px-4 sm:pb-4"
            >
              <ApprovalQueue
                key={view + JSON.stringify(requestFilters)}
                requests={requests}
                embedded
              />
            </TabsContent>
          ))}
        </Tabs>
      </Card>
      <Modal
        open={!!reversing}
        onOpenChange={(open) => {
          if (!open) setReversing(null);
        }}
        title="Request reversal"
        description="The original entry stays in the ledger. An approved reversal records an offsetting entry."
      >
        {reversing && (
          <ActionForm
            disabled={s.locked}
            onSubmit={() =>
              s.submit({
                kind: "CORRECT",
                transactionId: reversing.id,
                reason: val("reason"),
              })
            }
            onSuccess={() => {
              setReversing(null);
              set("status", "PENDING");
              set("filter", "");
              set("search", "");
              set("day", s.store.currentDayId ?? "");
              set("reason", "");
              set("page", "0");
            }}
          >
            <FormSection title="Original transaction">
              <Alert>
                <AlertDescription>
                  <p className="font-medium">
                    {t(reversing.type)} · {money(reversing.amount)}
                  </p>
                  <p>
                    {displayName(
                      s.players.find((p) => p.id === reversing.playerId)
                        ?.name ?? t("House"),
                    )}{" "}
                    · {timestamp(reversing.time, s.snapshot!.branch.timezone)}
                  </p>
                </AlertDescription>
              </Alert>
            </FormSection>
            <Field
              label="Reason for change"
              hint="Explain why this entry needs to be reversed."
            >
              <Textarea
                required
                minLength={3}
                maxLength={500}
                value={val("reason")}
                onChange={(e) => set("reason", e.target.value)}
              />
            </Field>
            <FormActions destructive>Request reversal</FormActions>
          </ActionForm>
        )}
      </Modal>
      {receipt && (
        <Receipt transaction={receipt} close={() => setReceipt(null)} />
      )}
    </div>
  );
}
