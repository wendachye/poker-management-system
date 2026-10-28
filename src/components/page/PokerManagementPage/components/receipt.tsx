"use client";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import type { Transaction } from "@/domain/model";
import { displayName } from "@/lib/display-name";
import { reversalRequestState } from "@/lib/reversal-presentation";
import { Link } from "@/i18n/navigation";
import { usePokerManagementContext } from "../PokerManagementProvider";
import { useText, useTimestamp } from "./shared";
import { money } from "../utils";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogHeader,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
export function Receipt({
  transaction: tx,
  close,
  onViewTransaction,
  onRequestReversal,
}: {
  transaction: Transaction;
  close: () => void;
  onViewTransaction: (transaction: Transaction) => void;
  onRequestReversal?: (transaction: Transaction) => void;
}) {
  const s = usePokerManagementContext(),
    t = useText(),
    timestamp = useTimestamp();
  const { focusRead, setError } = s;
  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve()
      .then(() =>
        focusRead({ resource: "receipt", id: tx.id }, controller.signal),
      )
      .catch((error: unknown) => {
        if (
          controller.signal.aborted ||
          (error instanceof DOMException && error.name === "AbortError")
        )
          return;
        setError(
          error instanceof Error ? error.message : "Cannot load receipt.",
        );
      });
    return () => controller.abort();
  }, [tx.id, focusRead, setError]);
  const original = tx.reversesId
    ? s.store.transactions.find((entry) => entry.id === tx.reversesId)
    : tx;
  const reversal = original
    ? s.store.transactions.find((entry) => entry.reversesId === original.id)
    : undefined;
  const reversalState = original
    ? reversalRequestState(s.store, original, s.user?.role, s.locked)
    : null;
  const reversalPending = reversalState?.pending;
  const cashOut = tx.type === "Cash-out" || original?.type === "Cash-out";
  const relatedPending =
    !!original &&
    (!!(
      original.playerId && s.store.readModel?.pendingPlayers[original.playerId]
    ) ||
      s.pendingApprovals.some(
        (request) =>
          (original.playerId && request.playerId === original.playerId) ||
          (original.sessionId && request.sessionId === original.sessionId),
      ));
  const sessionRequired =
    original?.type === "Buy-in" || original?.type === "Cash-out";
  const activeOriginalSession =
    !!original &&
    s.players.some(
      (player) =>
        player.id === original.playerId &&
        player.status === "ACTIVE" &&
        player.sessionId === original.sessionId,
    );
  const correctionBlocked =
    s.busy ||
    s.retryRequired ||
    relatedPending ||
    (sessionRequired && !activeOriginalSession);
  const canReplace =
    original &&
    original.type !== "Reversal" &&
    reversal &&
    original.dayId === s.store.currentDayId &&
    !s.locked &&
    s.user?.role !== "DEALER";
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          s.clearReadFocus();
          close();
        }
      }}
    >
      <DialogContent
        id="poker-receipt"
        className="max-h-[90dvh] overflow-y-auto [overflow-wrap:anywhere] sm:max-w-lg"
        closeLabel={t("Close")}
      >
        <DialogHeader>
          <DialogTitle>
            {displayName(s.snapshot!.branch.name)} · {t("Receipt")}
          </DialogTitle>
          <DialogDescription>
            {t(tx.type)} · {timestamp(tx.time, s.snapshot!.branch.timezone)}
          </DialogDescription>
        </DialogHeader>
        {onRequestReversal &&
          !tx.reversesId &&
          reversalState?.eligible &&
          !reversalPending && (
            <Button
              variant="outline"
              className="min-h-11 max-w-full whitespace-normal print:hidden sm:min-h-9"
              disabled={reversalState.blocked || s.busy || s.retryRequired}
              onClick={() => {
                if (!reversalState.blocked && !s.busy && !s.retryRequired)
                  onRequestReversal(tx);
              }}
            >
              {t("Request reversal")}
            </Button>
          )}
        {(reversal || reversalPending) && (
          <div className="space-y-3 rounded-lg border bg-muted/30 p-3 text-sm">
            <Badge variant={reversal ? "secondary" : "warning"}>
              {t(
                tx.reversesId
                  ? "Reversal posted"
                  : reversal
                    ? "Reversed"
                    : "Reversal pending",
              )}
            </Badge>
            <p className="text-muted-foreground">
              {t(
                reversal
                  ? "The reversal is posted. Both entries remain in the ledger."
                  : "The reversal is awaiting approval. The original entry has not changed.",
              )}
            </p>
            <div className="flex flex-wrap gap-2 print:hidden [&>button]:min-h-11 sm:[&>button]:min-h-9">
              {reversalPending && (
                <Button
                  variant="outline"
                  size="sm"
                  className="min-h-11 max-w-full whitespace-normal sm:min-h-9"
                  asChild
                >
                  <Link
                    href="/transactions"
                    onClick={() => {
                      s.setDraft("tx.status", "PENDING");
                      s.setDraft("tx.day", "");
                      s.setDraft("tx.filter", "");
                      s.setDraft("tx.search", reversalPending.id);
                      s.setDraft("tx.page", "0");
                      close();
                    }}
                  >
                    {t("View request")}
                  </Link>
                </Button>
              )}
              {tx.reversesId && original && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onViewTransaction(original)}
                >
                  {t("Original receipt")}
                </Button>
              )}
              {!tx.reversesId && reversal && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onViewTransaction(reversal)}
                >
                  {t("Reversal receipt")}
                </Button>
              )}
              {canReplace && original.type !== "Reversal" && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={correctionBlocked}
                  onClick={() => {
                    if (original.type === "Reversal" || correctionBlocked)
                      return;
                    close();
                    s.startOperation({
                      kind: "transaction",
                      type: original.type,
                      playerId: original.playerId,
                      tableId: original.tableId,
                    });
                  }}
                >
                  {t("Create corrected entry")}
                </Button>
              )}
            </div>
            {canReplace && (
              <p className="text-xs text-muted-foreground">
                {t(
                  "Create a corrected entry only if a replacement is needed. The new amount starts blank and requires separate approval.",
                )}
              </p>
            )}
            {canReplace && correctionBlocked && (
              <p className="text-xs text-muted-foreground">
                {t(
                  s.busy
                    ? "Saving…"
                    : s.retryRequired
                      ? "Retry the previous request before submitting a different operation."
                      : relatedPending
                        ? "Resolve pending request first"
                        : "The original player session is no longer active.",
                )}
              </p>
            )}
          </div>
        )}
        {cashOut && (
          <Alert>
            <AlertDescription className="flex min-w-0 flex-wrap items-baseline justify-between gap-2">
              <span className="font-medium">
                {t(
                  tx.reversesId
                    ? "Cash payout reversal"
                    : reversal
                      ? "Original cash payout"
                      : "Cash payout",
                )}
              </span>
              <strong className="whitespace-nowrap text-lg tabular-nums sm:text-xl">
                {money(tx.cashPayout)}
              </strong>
            </AlertDescription>
          </Alert>
        )}
        <dl className="grid grid-cols-2 gap-3 text-sm">
          {[
            ["Transaction type", t(tx.type)],
            [
              "Player",
              displayName(
                s.players.find((p) => p.id === tx.playerId)?.name ?? t("House"),
              ),
            ],
            [
              "Table",
              displayName(
                s.tables.find((table) => table.id === tx.tableId)?.name ?? "—",
              ),
            ],
            [cashOut ? "Chips returned" : "Amount", money(tx.amount)],
            ["Cash received", money(tx.cashReceived)],
            ...(cashOut
              ? [
                  [
                    tx.creditDelta > 0
                      ? "Credit debt restored"
                      : "Credit settled",
                    money(Math.abs(tx.creditDelta)),
                  ],
                ]
              : [
                  ["Cash payout", money(tx.cashPayout)],
                  ["Credit change", money(tx.creditDelta)],
                ]),
            ["Staff", displayName(tx.staff)],
            ["Date", timestamp(tx.time, s.snapshot!.branch.timezone)],
          ].map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted-foreground">{t(label)}</dt>
              <dd className="min-w-0 break-words font-medium [overflow-wrap:anywhere]">
                {value}
              </dd>
            </div>
          ))}
        </dl>
        <p className="break-words text-sm [overflow-wrap:anywhere]">
          {tx.note}
        </p>
        <p className="break-all text-xs text-muted-foreground">
          {t("Reference")}: {tx.id}
        </p>
        <p className="break-all text-xs text-muted-foreground">
          {t("Request reference")}: {tx.approvalId}
        </p>
        <p className="text-xs">
          {t("Reviewers")}:{" "}
          {s.store.approvals
            .find((r) => r.id === tx.approvalId)
            ?.votes.map((v) => displayName(v.username))
            .join(", ") || "—"}
        </p>
        {tx.reversesId && (
          <p className="break-all text-xs text-muted-foreground">
            {t("Reverses")}: {tx.reversesId}
          </p>
        )}
        <DialogFooter className="print:hidden">
          <DialogClose asChild>
            <Button variant="outline">{t("Close")}</Button>
          </DialogClose>
          <Button onClick={() => window.print()}>{t("Print receipt")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
