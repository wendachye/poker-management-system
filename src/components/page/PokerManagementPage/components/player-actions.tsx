"use client";
import { useId } from "react";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import type { Player } from "@/domain/model";
import { displayName } from "@/lib/display-name";
import { usePokerManagementContext } from "../PokerManagementProvider";
import { useText } from "./shared";
import { RowActions, type RowAction } from "./row-actions";

export function PlayerActions({
  player,
  details = false,
  compact = false,
}: {
  player: Player;
  details?: boolean;
  compact?: boolean;
}) {
  const s = usePokerManagementContext(),
    t = useText();
  const operator = s.user?.role !== "DEALER";
  const supervisor = ["MANAGER", "ADMIN"].includes(s.user?.role ?? "");
  const pendingRequest = s.pendingApprovals.find(
    (r) => r.playerId === player.id,
  );
  const pending = s.store.readModel
    ? !!s.store.readModel.pendingPlayers[player.id]
    : !!pendingRequest;
  const blocked = s.locked || s.busy || s.retryRequired;
  const pendingDescriptionId = useId();
  const actions: RowAction[] = [];
  if (!details)
    actions.push({
      key: "view",
      label: "View player",
      onSelect: () => s.startOperation({ kind: "player", playerId: player.id }),
    });
  if (compact && operator && player.status === "ACTIVE")
    actions.push({
      key: "cash-out",
      label: "Cash-out",
      disabled: blocked || pending,
      onSelect: () =>
        s.startOperation({
          kind: "transaction",
          type: "Cash-out",
          playerId: player.id,
        }),
    });
  if (operator && player.status === "ACTIVE")
    actions.push({
      key: "move",
      label: "Move seat",
      disabled: blocked || pending,
      onSelect: () => s.startOperation({ kind: "move", playerId: player.id }),
    });
  if (compact && operator && player.type === "CREDIT" && player.creditUsed > 0)
    actions.push({
      key: "repay",
      label: "Credit Repayment",
      disabled: blocked || pending,
      onSelect: () =>
        s.startOperation({
          kind: "transaction",
          type: "Credit Repayment",
          playerId: player.id,
        }),
    });
  if (supervisor)
    actions.push({
      key: "edit",
      label: "Edit profile",
      disabled: s.busy,
      onSelect: () =>
        s.startOperation({ kind: "edit-player", playerId: player.id }),
    });
  return (
    <div
      className={
        compact
          ? "flex shrink-0 items-center gap-1.5"
          : "flex flex-wrap items-center gap-2"
      }
      role={compact ? "group" : undefined}
      aria-label={
        compact
          ? t("Player actions") + " · " + displayName(player.name)
          : undefined
      }
      aria-describedby={compact && pending ? pendingDescriptionId : undefined}
    >
      {pending && (
        <Button asChild size="sm" variant="outline" className="h-11 sm:h-9">
          <Link
            href="/transactions"
            aria-label={t("View request") + " · " + displayName(player.name)}
            aria-describedby={pendingDescriptionId}
            onClick={() => {
              s.setDraft("tx.status", "PENDING");
              s.setDraft("tx.day", "");
              s.setDraft("tx.filter", "");
              s.setDraft("tx.search", pendingRequest?.id ?? player.phone);
              s.setDraft("tx.page", "0");
              s.closeOperation();
            }}
          >
            {t("View request")}
          </Link>
        </Button>
      )}
      {operator && player.status === "ACTIVE" && (
        <>
          {!pending && (
            <Button
              size="sm"
              variant="outline"
              className="h-11 sm:h-9"
              aria-label={t("Buy-in") + " · " + displayName(player.name)}
              disabled={blocked || pending}
              onClick={() =>
                s.startOperation({
                  kind: "transaction",
                  type: "Buy-in",
                  playerId: player.id,
                })
              }
            >
              {t("Buy-in")}
            </Button>
          )}
          {!compact && (
            <Button
              size="sm"
              className="h-11 sm:h-9"
              aria-label={t("Cash-out") + " · " + displayName(player.name)}
              disabled={blocked || pending}
              onClick={() =>
                s.startOperation({
                  kind: "transaction",
                  type: "Cash-out",
                  playerId: player.id,
                })
              }
            >
              {t("Cash-out")}
            </Button>
          )}
        </>
      )}
      {operator &&
        player.status !== "ACTIVE" &&
        !player.tags.includes("Banned") && (
          <Button
            size="sm"
            variant="outline"
            className="h-11 sm:h-9"
            aria-label={t("Check in") + " · " + displayName(player.name)}
            disabled={
              blocked ||
              !s.tables.some(
                (table) =>
                  table.status === "OPEN" &&
                  s.activePlayers.filter((p) => p.tableId === table.id).length <
                    9,
              )
            }
            onClick={() =>
              s.startOperation({ kind: "check-in", playerId: player.id })
            }
          >
            {t("Check in")}
          </Button>
        )}
      {!compact &&
        operator &&
        player.type === "CREDIT" &&
        player.creditUsed > 0 && (
          <Button
            size="sm"
            variant="outline"
            className="h-11 sm:h-9"
            aria-label={
              t("Credit Repayment") + " · " + displayName(player.name)
            }
            disabled={blocked || pending}
            onClick={() =>
              s.startOperation({
                kind: "transaction",
                type: "Credit Repayment",
                playerId: player.id,
              })
            }
          >
            {t("Credit Repayment")}
          </Button>
        )}
      {actions.length > 0 && (
        <RowActions
          label={t("Player actions") + " · " + displayName(player.name)}
          actions={actions}
          iconOnly={compact}
        />
      )}
      {details && !operator && (
        <span className="text-xs text-muted-foreground">{t("View only")}</span>
      )}
      {pending && (
        <span
          id={pendingDescriptionId}
          className={
            compact ? "sr-only" : "basis-full text-xs text-muted-foreground"
          }
        >
          {t("Resolve pending request first")}
        </span>
      )}
    </div>
  );
}
