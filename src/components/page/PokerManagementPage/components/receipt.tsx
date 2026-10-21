"use client";
import { Button } from "@/components/ui/button";
import type { Transaction } from "@/domain/model";
import { displayName } from "@/lib/display-name";
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
}: {
  transaction: Transaction;
  close: () => void;
}) {
  const s = usePokerManagementContext(),
    t = useText(),
    timestamp = useTimestamp();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
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
          <DialogDescription className="break-all">{tx.id}</DialogDescription>
        </DialogHeader>
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
            ["Amount", money(tx.amount)],
            ["Cash received", money(tx.cashReceived)],
            ["Cash payout", money(tx.cashPayout)],
            ["Credit change", money(tx.creditDelta)],
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
        <p className="break-all text-xs">
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
          <p className="break-all text-xs">
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
