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
  const effects =
    request.type === "Cash-out"
      ? [
          ["Cash payout", impact.cashPayout],
          ["Credit change", impact.creditDelta],
          ["Cash received", impact.cashReceived],
        ]
      : [
          ["Cash received", impact.cashReceived],
          ["Cash payout", impact.cashPayout],
          ["Credit change", impact.creditDelta],
        ];
  return (
    <div className="space-y-2 rounded-lg border bg-muted/40 p-3 text-sm">
      <p className="font-medium">{t("Impact after approval")}</p>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-2">
        {effects.map(([label, value]) => {
          const payout = request.type === "Cash-out" && label === "Cash payout";
          return (
            <div
              className={
                payout
                  ? "col-span-2 flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1 rounded-md bg-background p-3"
                  : "contents"
              }
              key={label}
            >
              <dt className={payout ? "font-medium" : "text-muted-foreground"}>
                {t(String(label))}
              </dt>
              <dd
                className={`min-w-0 break-words text-right font-medium tabular-nums [overflow-wrap:anywhere] ${payout ? "text-lg font-semibold" : ""}`}
              >
                {money(Number(value))}
              </dd>
            </div>
          );
        })}
      </dl>
      {request.type === "Cash-out" && (
        <div className="space-y-1">
          <p>
            {t(
              "Cash-out first settles outstanding credit; only the remainder is paid in cash.",
            )}
          </p>
          <p>{t("Approval checks this player out and releases their seat.")}</p>
        </div>
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
