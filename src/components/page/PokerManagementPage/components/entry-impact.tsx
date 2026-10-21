"use client";
import type { ApprovalRequest } from "@/domain/model";
import { ledgerImpact } from "@/domain/ledger-impact";
import { usePokerManagementContext } from "../PokerManagementProvider";
import { money } from "../utils";
import { useText } from "./shared";
export function EntryImpact({
  request,
}: {
  request: Pick<ApprovalRequest, "type" | "amount" | "playerId" | "reversesId">;
}) {
  const s = usePokerManagementContext(),
    t = useText();
  const impact = ledgerImpact(s.store, request);
  const original = s.store.transactions.find(
    (tx) => tx.id === request.reversesId,
  );
  return (
    <div className="space-y-2 rounded-lg border bg-muted/40 p-3 text-sm">
      <p className="font-medium">{t("Impact after approval")}</p>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-2">
        {[
          ["Cash received", impact.cashReceived],
          ["Cash payout", impact.cashPayout],
          ["Credit change", impact.creditDelta],
        ].map(([label, value]) => (
          <div className="contents" key={label}>
            <dt className="text-muted-foreground">{t(String(label))}</dt>
            <dd className="text-right font-medium tabular-nums">
              {money(Number(value))}
            </dd>
          </div>
        ))}
      </dl>
      {request.type === "Cash-out" && (
        <p>{t("Approval checks this player out and releases their seat.")}</p>
      )}
      {request.type === "Reversal" && original?.type === "Cash-out" && (
        <p>
          {t(
            "Approval reopens the original player session and restores their seat.",
          )}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        {t(
          "Based on current balances. Final approval revalidates the request.",
        )}
      </p>
    </div>
  );
}
