"use client";
import { useEffect, useRef, useState } from "react";
import { ChevronDown, ReceiptText } from "lucide-react";
import { displayName } from "@/lib/display-name";
import { Button } from "@/components/ui/button";
import { Badge as UiBadge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import { canApprove } from "@/domain/operations";
import { approvalReviewProgress } from "@/domain/approval-review-progress";
import { ledgerImpact } from "@/domain/ledger-impact";
import type { ApprovalRequest, Transaction } from "@/domain/model";
import { usePokerManagementContext } from "../PokerManagementProvider";
import { money } from "../utils";
import {
  Field,
  Panel,
  Badge,
  Modal,
  ActionForm,
  FormActions,
  FormSection,
  EmptyState,
  Pager,
  useText,
  useTimestamp,
} from "./shared";
import { CashOutSummary, EntryImpact } from "./entry-impact";
import { Receipt } from "./receipt";
import { Link } from "@/i18n/navigation";

export function ApprovalQueue({
  requests,
  compact = false,
  embedded = false,
  pendingView = false,
  pagination,
  loading = false,
}: {
  requests?: ApprovalRequest[];
  compact?: boolean;
  embedded?: boolean;
  pendingView?: boolean;
  pagination?: { page: number; total: number; setPage: (page: number) => void };
  loading?: boolean;
}) {
  const s = usePokerManagementContext(),
    t = useText(),
    timestamp = useTimestamp();
  const [reviewId, setReviewId] = useState(""),
    [decision, setDecision] = useState("APPROVED");
  const [reason, setReason] = useState(""),
    [currentPage, setPage] = useState(0);
  const [receipt, setReceipt] = useState<Transaction | null>(null);
  const [openingReview, setOpeningReview] = useState(false);
  const contextRequest = useRef<AbortController | null>(null);
  useEffect(() => () => contextRequest.current?.abort(), []);
  const entries = requests ?? s.pendingApprovals;
  const emptyPendingQueue =
    (pendingView || requests === undefined) &&
    !(s.store.readModel?.pendingTotal ?? s.pendingApprovals.length);
  const page =
    pagination?.page ??
    Math.min(currentPage, Math.max(0, Math.ceil(entries.length / 20) - 1));
  const visible = compact
    ? entries.slice(0, 4)
    : pagination
      ? entries
      : entries.slice(page * 20, page * 20 + 20);
  const request = s.store.approvals.find((r) => r.id === reviewId);
  const reviewProgress = request ? approvalReviewProgress(request, t) : null;
  const requestDay = request
    ? s.store.days.find((day) => day.id === request.dayId)?.date
    : undefined;
  const reversalOriginal =
    request?.type === "Reversal"
      ? s.store.transactions.find((tx) => tx.id === request.reversesId)
      : undefined;
  const reversalImpact =
    request && reversalOriginal && request.status !== "REJECTED"
      ? request.status === "APPROVED"
        ? s.store.transactions.find((tx) => tx.approvalId === request.id)
        : ledgerImpact(s.store, request)
      : undefined;
  const cashOutReversal =
    !!reversalImpact && reversalOriginal?.type === "Cash-out";
  function canReview(request: ApprovalRequest) {
    return (
      !!s.user &&
      !s.locked &&
      request.dayId === s.store.currentDayId &&
      canApprove(s.user, request)
    );
  }
  const reviewable = !!request && canReview(request);
  function subject(r: ApprovalRequest) {
    return (
      [
        displayName(s.players.find((p) => p.id === r.playerId)?.name ?? ""),
        displayName(
          s.tables.find((table) => table.id === r.tableId)?.name ?? "",
        ),
      ]
        .filter(Boolean)
        .join(" · ") || t("House")
    );
  }
  function status(r: ApprovalRequest) {
    return (
      <UiBadge
        variant={
          r.status === "REJECTED"
            ? "destructive"
            : r.status === "APPROVED"
              ? "success"
              : "warning"
        }
        className="h-5 px-1.5 text-[10px]"
      >
        {t(r.status)}
      </UiBadge>
    );
  }
  function reviewSummary(r: ApprovalRequest) {
    const progress = approvalReviewProgress(r, t);
    const reviewers = displayName(
      r.decidedBy ??
        progress.reviewers.map((vote) => displayName(vote.username)).join(", "),
    );
    return (
      <div className="min-w-0 space-y-1 text-xs leading-4 text-muted-foreground">
        {r.status === "PENDING" && (
          <p
            className="break-words [overflow-wrap:anywhere]"
            title={progress.label}
          >
            <span className="whitespace-nowrap">
              {t("Reviewers")}: {progress.count} / {progress.minimum}
            </span>
            {progress.requirement && <> · {t(progress.requirement)}</>}
          </p>
        )}
        {reviewers && (
          <p
            className="line-clamp-2 break-words [overflow-wrap:anywhere]"
            title={reviewers}
          >
            {t("Reviewed by")}: {reviewers}
          </p>
        )}
        {r.status === "REJECTED" && r.rejectionReason && (
          <p
            className="line-clamp-2 break-words text-destructive [overflow-wrap:anywhere]"
            title={r.rejectionReason}
          >
            <span className="font-medium">{t("Rejection reason")}: </span>
            {r.rejectionReason}
          </p>
        )}
      </div>
    );
  }
  function metadata(r: ApprovalRequest) {
    const day = s.store.days.find((entry) => entry.id === r.dayId)?.date;
    const details = [
      displayName(r.requestedBy),
      timestamp(r.createdAt, s.snapshot!.branch.timezone),
      day ? `${t("Business day")}: ${day}` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    return (
      <p
        className="line-clamp-2 break-words text-xs leading-4 text-muted-foreground [overflow-wrap:anywhere]"
        title={details}
      >
        {details}
      </p>
    );
  }
  function amount(r: ApprovalRequest) {
    const original = r.reversesId
      ? s.store.transactions.find((tx) => tx.id === r.reversesId)
      : undefined;
    const cashOut = r.type === "Cash-out" || original?.type === "Cash-out";
    const impact = cashOut
      ? r.status === "PENDING"
        ? ledgerImpact(s.store, r)
        : s.store.transactions.find((tx) => tx.approvalId === r.id)
      : undefined;
    return (
      <div className="space-y-0.5 text-right tabular-nums">
        <p className="text-sm font-semibold">
          {money(impact ? impact.cashPayout : r.amount)}
        </p>
        {cashOut && (
          <>
            <p className="text-[11px] leading-4 text-muted-foreground">
              {t(
                impact
                  ? r.reversesId
                    ? "Cash payout reversal"
                    : r.status === "PENDING"
                      ? "Cash payout after approval"
                      : "Cash payout"
                  : "Chips returned",
              )}
            </p>
            {impact && (
              <>
                <p className="text-[11px] leading-4 text-muted-foreground">
                  {t("Chips returned")}: {money(impact.amount)}
                </p>
                {impact.creditDelta !== 0 && (
                  <p className="text-[11px] leading-4 text-muted-foreground">
                    {t(
                      impact.creditDelta > 0
                        ? "Credit debt restored"
                        : "Credit settled",
                    )}
                    : {money(Math.abs(impact.creditDelta))}
                  </p>
                )}
              </>
            )}
          </>
        )}
      </div>
    );
  }
  function actions(r: ApprovalRequest) {
    const posted = s.store.transactions.find((tx) => tx.approvalId === r.id);
    const actionLabel = canReview(r) ? "Review request" : "View details";
    return (
      <div className="flex shrink-0 items-center justify-end gap-1.5">
        {posted && (
          <Button
            size="icon-sm"
            variant="ghost"
            className="size-11 sm:size-9"
            aria-label={t("Receipt") + " · " + subject(r) + " · " + r.id}
            title={t("Receipt")}
            onClick={() => setReceipt(posted)}
          >
            <ReceiptText aria-hidden="true" />
          </Button>
        )}
        <Button
          size="sm"
          className="h-11 px-3 sm:h-9"
          aria-label={t(actionLabel) + " · " + subject(r) + " · " + r.id}
          variant={actionLabel === "Review request" ? "default" : "outline"}
          disabled={s.busy || openingReview}
          onClick={async () => {
            contextRequest.current?.abort();
            const controller = new AbortController();
            contextRequest.current = controller;
            s.setError("");
            setOpeningReview(true);
            try {
              await s.focusRead(
                { resource: "requests", id: r.id },
                controller.signal,
              );
              if (controller.signal.aborted) return;
              setDecision("APPROVED");
              setReason("");
              setReviewId(r.id);
            } catch (error) {
              if (!controller.signal.aborted)
                s.setError(
                  error instanceof Error
                    ? error.message
                    : "Cannot load request.",
                );
            } finally {
              if (!controller.signal.aborted) setOpeningReview(false);
            }
          }}
        >
          {t(actionLabel)}
        </Button>
      </div>
    );
  }
  const content = (
    <div className="@container/approvals min-w-0 space-y-3">
      {!entries.length && !loading && (
        <EmptyState
          title={
            emptyPendingQueue
              ? "No pending approvals."
              : requests && s.store.approvals.length
                ? "No requests match these filters."
                : requests
                  ? "No requests yet"
                  : "No pending approvals."
          }
          description={
            !emptyPendingQueue && requests && s.store.approvals.length
              ? "Try another search or clear the filters."
              : "Requests keep their status and review history here."
          }
        />
      )}
      {!!visible.length && (
        <>
          <ul
            aria-label={t("Approval queue")}
            className="divide-y border-y @min-[900px]/approvals:hidden"
          >
            {visible.map((r) => (
              <li
                key={r.id}
                className="min-w-0 space-y-2 py-3"
                data-approval-row
              >
                <div className="flex min-w-0 items-start justify-between gap-3">
                  <div className="min-w-0 flex-1 space-y-1">
                    <p className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs font-medium">
                      <span className="break-words [overflow-wrap:anywhere]">
                        {t(r.type)}
                      </span>
                      {status(r)}
                    </p>
                    <p
                      className="line-clamp-2 break-words text-sm font-medium leading-5 [overflow-wrap:anywhere]"
                      title={subject(r)}
                    >
                      {subject(r)}
                    </p>
                  </div>
                  <div className="shrink-0">{amount(r)}</div>
                </div>
                {metadata(r)}
                {r.note && (
                  <p
                    className="line-clamp-1 break-words text-xs leading-4 text-muted-foreground [overflow-wrap:anywhere]"
                    title={r.note}
                  >
                    {r.note}
                  </p>
                )}
                <div className="flex min-w-0 flex-wrap items-end justify-between gap-x-3 gap-y-2">
                  <div className="min-w-0 flex-1 basis-36">
                    {reviewSummary(r)}
                  </div>
                  {actions(r)}
                </div>
              </li>
            ))}
          </ul>
          <div className="hidden border-y @min-[900px]/approvals:block">
            <Table className="table-fixed" aria-label={t("Approval queue")}>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">{t("Request")}</TableHead>
                  <TableHead scope="col" className="w-60">
                    {t("Review")}
                  </TableHead>
                  <TableHead scope="col" className="w-44 text-right">
                    {t("Amount")}
                  </TableHead>
                  <TableHead scope="col" className="w-48 text-right">
                    {t("Actions")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((r) => (
                  <TableRow key={r.id} data-approval-row>
                    <TableCell className="space-y-0.5 whitespace-normal py-2">
                      <p
                        className="line-clamp-2 break-words font-medium leading-5 [overflow-wrap:anywhere]"
                        title={t(r.type) + " · " + subject(r)}
                      >
                        {t(r.type)}
                        <span className="font-normal text-muted-foreground">
                          {" "}
                          · {subject(r)}
                        </span>
                      </p>
                      {metadata(r)}
                      {r.note && (
                        <p
                          className="line-clamp-1 break-words text-xs leading-4 text-muted-foreground [overflow-wrap:anywhere]"
                          title={r.note}
                        >
                          {r.note}
                        </p>
                      )}
                    </TableCell>
                    <TableCell className="space-y-1.5 whitespace-normal py-2">
                      {status(r)}
                      {reviewSummary(r)}
                    </TableCell>
                    <TableCell className="py-2">{amount(r)}</TableCell>
                    <TableCell className="py-2">{actions(r)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}
      {compact ? (
        <Button variant="outline" asChild>
          <Link
            href="/transactions"
            onClick={() => {
              s.setDraft("tx.status", "PENDING");
              s.setDraft("tx.day", "");
              s.setDraft("tx.filter", "");
              s.setDraft("tx.search", "");
              s.setDraft("tx.page", "0");
            }}
          >
            {t("View all requests")}
          </Link>
        </Button>
      ) : (
        <Pager
          page={page}
          total={pagination?.total ?? entries.length}
          setPage={pagination?.setPage ?? setPage}
          label="Request pagination"
        />
      )}
      <Modal
        open={!!request}
        onOpenChange={(open) => {
          if (!open) {
            setReviewId("");
            s.clearReadFocus();
          }
        }}
        title={reviewable ? "Review request" : "Request details"}
        description={request ? subject(request) : "Request details"}
      >
        {request && reviewProgress && (
          <>
            <div className="min-w-0 space-y-2 rounded-lg bg-muted p-4 text-sm [overflow-wrap:anywhere]">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="space-y-1">
                  <p className="text-lg font-semibold">{t(request.type)}</p>
                  <p className="font-medium tabular-nums">
                    {t(
                      cashOutReversal
                        ? "Cash payout reversal"
                        : request.type === "Cash-out"
                          ? "Chips returned"
                          : "Amount",
                    )}
                    :{" "}
                    <span className="whitespace-nowrap">
                      {money(
                        reversalImpact
                          ? cashOutReversal
                            ? reversalImpact.cashPayout
                            : reversalImpact.amount
                          : request.amount,
                      )}
                    </span>
                  </p>
                  {cashOutReversal && reversalImpact && (
                    <p className="text-xs text-muted-foreground tabular-nums">
                      {t("Chips returned")}:{" "}
                      <span className="whitespace-nowrap">
                        {money(reversalImpact.amount)}
                      </span>
                    </p>
                  )}
                </div>
                <Badge>{request.status}</Badge>
              </div>
              <p>
                {t("Requested by")}: {displayName(request.requestedBy)}
              </p>
              {request.note && (
                <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                  {t("Note")}: {request.note}
                </p>
              )}
              <p>{reviewProgress.label}</p>
              <p className="text-xs text-muted-foreground">
                {t(request.riskReason)}
              </p>
            </div>
            {request.status === "PENDING" &&
              (reviewable && decision === "REJECTED" ? (
                <Alert>
                  <AlertDescription>
                    {t(
                      "Rejecting this request does not post an entry or change cash or credit.",
                    )}
                  </AlertDescription>
                </Alert>
              ) : (
                <EntryImpact request={request} />
              ))}
            {request.status === "REJECTED" && (
              <Alert>
                <AlertDescription>
                  {t(
                    "This request was rejected. Cash and credit were not changed.",
                  )}
                  {request.rejectionReason && (
                    <p className="mt-2 break-words font-medium text-foreground [overflow-wrap:anywhere]">
                      {t("Rejection reason")}: {request.rejectionReason}
                    </p>
                  )}
                </AlertDescription>
              </Alert>
            )}
            {request.reversesId && (
              <Button
                variant="outline"
                onClick={() => {
                  const original = s.store.transactions.find(
                    (tx) => tx.id === request.reversesId,
                  );
                  if (original) {
                    setReviewId("");
                    s.clearReadFocus();
                    setReceipt(original);
                  }
                }}
              >
                {t("Original receipt")}
              </Button>
            )}
            {reviewable ? (
              <ActionForm
                validationKey={request.id + ":" + decision}
                onSubmit={() =>
                  s.submit({
                    kind: "DECIDE",
                    approvalId: request.id,
                    decision: decision as "APPROVED" | "REJECTED",
                    reason: decision === "REJECTED" ? reason : undefined,
                  })
                }
                onSuccess={() => {
                  setReviewId("");
                  s.clearReadFocus();
                  if (s.draft("tx.search").trim() === request.id) {
                    s.setDraft("tx.search", "");
                    s.setDraft("tx.page", "0");
                  }
                }}
              >
                <FormSection title="Review decision">
                  <Tabs value={decision} onValueChange={setDecision}>
                    <TabsList
                      className="w-full"
                      aria-label={t("Review decision")}
                    >
                      <TabsTrigger value="APPROVED">{t("Approve")}</TabsTrigger>
                      <TabsTrigger value="REJECTED">{t("Reject")}</TabsTrigger>
                    </TabsList>
                    <TabsContent value="APPROVED">
                      <p className="text-sm text-muted-foreground">
                        {t(
                          request.approvalLevel === "DUAL"
                            ? "The entry posts after two distinct reviewers approve, including an admin."
                            : "Approving posts this entry to the ledger.",
                        )}
                      </p>
                    </TabsContent>
                    <TabsContent value="REJECTED">
                      <Field
                        label="Rejection reason"
                        hint="Explain what needs to be corrected before this request can be submitted again."
                      >
                        <Textarea
                          required
                          minLength={3}
                          maxLength={500}
                          value={reason}
                          onChange={(e) => setReason(e.target.value)}
                        />
                      </Field>
                    </TabsContent>
                  </Tabs>
                </FormSection>
                <FormActions
                  destructive={decision === "REJECTED"}
                  summary={
                    decision === "APPROVED" && request.type === "Cash-out" ? (
                      <CashOutSummary request={request} />
                    ) : undefined
                  }
                >
                  {decision === "REJECTED"
                    ? "Reject request"
                    : request.approvalLevel === "DUAL"
                      ? "Record approval"
                      : "Approve request"}
                </FormActions>
              </ActionForm>
            ) : (
              request.status === "PENDING" && (
                <p className="text-sm text-muted-foreground">
                  {t(
                    s.locked || request.dayId !== s.store.currentDayId
                      ? "Only requests for the current open business day can be reviewed."
                      : request.requestedById === s.user?.id
                        ? "Awaiting independent review"
                        : "Awaiting authorized reviewer",
                  )}
                </p>
              )
            )}
            {request.status === "APPROVED" && (
              <Button
                onClick={() => {
                  const tx = s.store.transactions.find(
                    (tx) => tx.approvalId === request.id,
                  );
                  if (tx) {
                    setReviewId("");
                    s.clearReadFocus();
                    setReceipt(tx);
                  }
                }}
              >
                {t("View posted receipt")}
              </Button>
            )}
            <Collapsible key={request.id} className="min-w-0 rounded-lg border">
              <CollapsibleTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  className="group h-auto min-h-11 w-full justify-between gap-3 whitespace-normal px-3 py-2 text-left"
                >
                  {t("Request details")}
                  <ChevronDown
                    aria-hidden="true"
                    className="size-4 shrink-0 transition-transform group-data-[state=open]:rotate-180"
                  />
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="space-y-3 border-t p-3 text-sm [overflow-wrap:anywhere]">
                <dl className="space-y-2 text-xs">
                  <div className="flex flex-wrap justify-between gap-x-3 gap-y-1">
                    <dt className="text-muted-foreground">{t("Date")}</dt>
                    <dd>
                      {timestamp(
                        request.createdAt,
                        s.snapshot!.branch.timezone,
                      )}
                    </dd>
                  </div>
                  {requestDay && (
                    <div className="flex flex-wrap justify-between gap-x-3 gap-y-1">
                      <dt className="text-muted-foreground">
                        {t("Business day")}
                      </dt>
                      <dd>{requestDay}</dd>
                    </div>
                  )}
                  {!!reviewProgress.reviewers.length && (
                    <div className="space-y-1">
                      <dt className="text-muted-foreground">
                        {t("Reviewed by")}
                      </dt>
                      <dd>
                        {reviewProgress.reviewers
                          .map((vote) => displayName(vote.username))
                          .join(", ")}
                      </dd>
                    </div>
                  )}
                  {request.decidedAt && (
                    <div className="space-y-1">
                      <dt className="text-muted-foreground">
                        {t("Decision recorded")}
                      </dt>
                      <dd>
                        {timestamp(
                          request.decidedAt,
                          s.snapshot!.branch.timezone,
                        )}{" "}
                        · {displayName(request.decidedBy ?? "")}
                      </dd>
                    </div>
                  )}
                  <div className="space-y-1">
                    <dt className="text-muted-foreground">{t("Reference")}</dt>
                    <dd className="break-all">{request.id}</dd>
                  </div>
                </dl>
              </CollapsibleContent>
            </Collapsible>
          </>
        )}
      </Modal>
      {receipt && (
        <Receipt
          transaction={receipt}
          close={() => setReceipt(null)}
          onViewTransaction={setReceipt}
        />
      )}
    </div>
  );
  return embedded ? (
    <div className="space-y-4">{content}</div>
  ) : (
    <Panel
      title="Approval queue"
      description="Review pending requests before they affect cash or credit."
    >
      {content}
    </Panel>
  );
}
