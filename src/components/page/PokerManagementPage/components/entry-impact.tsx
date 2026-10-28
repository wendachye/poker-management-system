"use client";
import type { ApprovalRequest } from "@/domain/model";
import { ledgerImpact } from "@/domain/ledger-impact";
import { displayName } from "@/lib/display-name";
import { reversalEffectRows } from "@/lib/reversal-presentation";
import { usePokerManagementContext } from "../PokerManagementProvider";
import { money } from "../utils";
import { useText } from "./shared";
type ImpactRequest = Pick<
  ApprovalRequest,
  "type" | "amount" | "playerId" | "reversesId"
>;

export function CashOutSummary({
  request,
  showPlayer = false,
}: {
  request: ImpactRequest;
  showPlayer?: boolean;
}) {
  const s = usePokerManagementContext(),
    t = useText();
  if (request.type !== "Cash-out") return null;
  const impact = ledgerImpact(s.store, request);
  const player = s.players.find((entry) => entry.id === request.playerId);
  const remainingCredit =
    player?.type === "CREDIT"
      ? Math.max(0, player.creditUsed + impact.creditDelta)
      : 0;
  return (
    <div className="min-w-0 space-y-1" aria-live="polite" aria-atomic="true">
      {showPlayer && player && (
        <p
          className="truncate text-xs text-muted-foreground"
          title={displayName(player.name)}
        >
          {displayName(player.name)}
        </p>
      )}
      <dl className="space-y-1">
        <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
          <dt className="text-xs text-muted-foreground">
            {t("Cash payout after approval")}
          </dt>
          <dd className="whitespace-nowrap text-base font-semibold tabular-nums">
            {money(impact.cashPayout)}
          </dd>
        </div>
        {impact.creditDelta < 0 && (
          <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
            <dt>{t("Credit settled")}</dt>
            <dd className="whitespace-nowrap tabular-nums">
              {money(-impact.creditDelta)}
            </dd>
          </div>
        )}
        {remainingCredit > 0 && (
          <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
            <dt>{t("Credit still owed")}</dt>
            <dd className="whitespace-nowrap tabular-nums">
              {money(remainingCredit)}
            </dd>
          </div>
        )}
      </dl>
    </div>
  );
}

export function EntryImpact({ request }: { request: ImpactRequest }) {
  const s = usePokerManagementContext(),
    t = useText();
  const impact = ledgerImpact(s.store, request);
  const original = s.store.transactions.find(
    (tx) => tx.id === request.reversesId,
  );
  const player = s.players.find((player) => player.id === request.playerId);
  const creditBuyIn = request.type === "Buy-in" && player?.type === "CREDIT";
  const invalidRepayment =
    request.type === "Credit Repayment" &&
    !!player &&
    request.amount > player.creditUsed;
  const creditAfter = player ? player.creditUsed + impact.creditDelta : 0;
  const effects: { label: string; value: number; primary?: boolean }[] = [];
  if (request.type === "Reversal") {
    effects.push(...reversalEffectRows(impact));
  } else {
    if (
      [
        "Cash-out",
        "Insurance Payout",
        "Jackpot Payout",
        "Cash Payout",
      ].includes(request.type)
    )
      effects.push({
        label: "Cash payout",
        value: impact.cashPayout,
        primary: true,
      });
    else if (impact.cashReceived > 0 || !creditBuyIn)
      effects.push({
        label: "Cash received",
        value: impact.cashReceived,
        primary: true,
      });
    if (impact.creditDelta !== 0 || creditBuyIn)
      effects.push({
        label: impact.creditDelta < 0 ? "Credit settled" : "Credit added",
        value: Math.abs(impact.creditDelta),
        primary: creditBuyIn,
      });
    if (
      player?.type === "CREDIT" &&
      ["Buy-in", "Cash-out", "Credit Repayment"].includes(request.type) &&
      creditAfter >= 0
    )
      effects.push({ label: "Credit still owed", value: creditAfter });
  }
  return (
    <div className="min-w-0 space-y-2 rounded-lg border bg-muted/40 p-3 text-sm">
      <p className="font-medium">{t("Impact after approval")}</p>
      {invalidRepayment ? (
        <p className="font-medium text-destructive">
          {t("Repayment cannot exceed outstanding credit.")}
        </p>
      ) : effects.length ? (
        <dl className="space-y-2">
          {effects.map(({ label, value, primary }) => (
            <div
              className={
                "flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1 " +
                (primary ? "rounded-md bg-background p-3" : "")
              }
              key={label}
            >
              <dt className={primary ? "font-medium" : "text-muted-foreground"}>
                {t(label)}
              </dt>
              <dd
                className={
                  "max-w-full whitespace-nowrap text-right font-medium tabular-nums " +
                  (primary ? "text-base font-semibold sm:text-lg" : "")
                }
              >
                {money(value)}
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-muted-foreground">
          {t("No cash or credit movement.")}
        </p>
      )}
      {creditBuyIn && <p>{t("No cash is collected for a credit buy-in.")}</p>}
      {request.type === "Cash-out" && (
        <div className="space-y-1">
          {player?.type === "CREDIT" && (
            <p>
              {t(
                "Cash-out first settles outstanding credit; only the remainder is paid in cash.",
              )}
            </p>
          )}
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
