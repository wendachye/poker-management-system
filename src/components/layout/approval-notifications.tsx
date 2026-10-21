"use client";

import { useId, useState } from "react";
import {
  ArrowRight,
  Bell,
  BellRing,
  LoaderCircle,
  RefreshCw,
  X,
} from "lucide-react";
import { approvalNotifications } from "@/domain/approval-notifications";
import { approvalReviewProgress } from "@/domain/approval-review-progress";
import { displayName } from "@/lib/display-name";
import { Link } from "@/i18n/navigation";
import { money } from "@/components/page/PokerManagementPage/utils";
import { usePokerManagementContext } from "@/components/page/PokerManagementPage/PokerManagementProvider";
import {
  useText,
  useTimestamp,
} from "@/components/page/PokerManagementPage/components/shared";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";

export function ApprovalNotifications() {
  const s = usePokerManagementContext();
  const t = useText();
  const timestamp = useTimestamp();
  const titleId = useId();
  const descriptionId = useId();
  const [open, setOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const loaded = !!s.snapshot;
  const summary = approvalNotifications(s.store, s.user);
  const error = s.refreshError || (!loaded ? s.error : "");
  const countLabel = loaded
    ? `${summary.total} ${t("pending approvals")}`
    : t(error ? "Cannot load branch records." : "Loading branch records…");

  function openQueue() {
    s.setDraft("tx.status", "PENDING");
    s.setDraft("tx.day", "");
    s.setDraft("tx.filter", "");
    s.setDraft("tx.search", "");
    s.setDraft("tx.page", "0");
    setOpen(false);
  }

  async function refresh() {
    setRefreshing(true);
    try {
      await s.refresh();
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative size-10"
          aria-label={`${t("Approval queue")}: ${countLabel}`}
          title={countLabel}
        >
          <Bell className="size-5" />
          {loaded && summary.total > 0 && (
            <Badge
              className="absolute -right-0.5 -top-0.5 h-5 min-w-5 justify-center rounded-full px-1 text-[10px] tabular-nums"
              aria-hidden="true"
            >
              {summary.total > 99 ? "99+" : summary.total}
            </Badge>
          )}
          {!loaded && !error && (
            <LoaderCircle className="absolute -right-0.5 -top-0.5 size-3 animate-spin" />
          )}
          {!loaded && error && (
            <span className="absolute right-0 top-0 size-2 rounded-full bg-destructive" />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        collisionPadding={12}
        className="max-h-[var(--radix-popover-content-available-height)] w-[min(24rem,calc(100vw-1.5rem))] gap-0 overflow-hidden p-0"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <PopoverHeader className="shrink-0 border-b p-4">
          <div className="flex items-center justify-between gap-2">
            <PopoverTitle id={titleId}>{t("Approval queue")}</PopoverTitle>
            <Button
              size="icon"
              variant="ghost"
              aria-label={t("Close")}
              onClick={() => setOpen(false)}
            >
              <X />
            </Button>
          </div>
          <PopoverDescription id={descriptionId} aria-live="polite">
            {countLabel}
            {loaded && summary.reviewable > 0 && (
              <>
                {" "}
                · {t("Ready for your review")}: {summary.reviewable}
              </>
            )}
          </PopoverDescription>
        </PopoverHeader>
        {error && (
          <div className="p-3">
            <Alert variant="destructive">
              <AlertDescription>
                <p>{t(error)}</p>
                {loaded && <p>{t("Showing the latest loaded records.")}</p>}
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  disabled={refreshing}
                  onClick={() => void refresh()}
                >
                  <RefreshCw className={refreshing ? "animate-spin" : ""} />
                  {t("Refresh")}
                </Button>
              </AlertDescription>
            </Alert>
          </div>
        )}
        {!loaded ? (
          !error && (
            <div
              className="flex items-center gap-2 p-5 text-muted-foreground"
              role="status"
            >
              <LoaderCircle className="size-4 animate-spin" />
              {t("Loading branch records…")}
            </div>
          )
        ) : summary.total === 0 ? (
          <Empty className="gap-3 py-7">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <BellRing />
              </EmptyMedia>
              <EmptyTitle className="text-sm">
                {t("No pending approvals.")}
              </EmptyTitle>
              <EmptyDescription>
                {t("New transaction requests will appear here for review.")}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ul className="min-h-0 max-h-[min(24rem,50dvh)] divide-y overflow-y-auto overscroll-contain">
            {summary.entries.map(({ request, status, businessDate }) => {
              const subject = [
                s.store.profiles.find(
                  (player) => player.id === request.playerId,
                )?.name,
                s.store.tables.find((table) => table.id === request.tableId)
                  ?.name,
              ]
                .filter((name): name is string => !!name)
                .map(displayName)
                .join(" · ");
              return (
                <li key={request.id}>
                  <Link
                    href="/transactions"
                    onClick={openQueue}
                    className="block space-y-1.5 p-4 outline-none transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2 font-medium">
                      <span>{t(request.type)}</span>
                      <span className="tabular-nums">
                        {money(request.amount)}
                      </span>
                    </div>
                    <p className="break-words text-sm">
                      {subject || t("House")}
                    </p>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge
                        variant={
                          status === "Ready for your review"
                            ? "default"
                            : "outline"
                        }
                        className="h-auto max-w-full whitespace-normal py-0.5 text-[11px]"
                      >
                        {t(status)}
                      </Badge>
                      {request.approvalLevel === "DUAL" && (
                        <span className="text-xs text-muted-foreground">
                          {approvalReviewProgress(request, t).label}
                        </span>
                      )}
                    </div>
                    <p className="break-words text-xs text-muted-foreground">
                      {displayName(request.requestedBy)} ·{" "}
                      {timestamp(
                        request.createdAt,
                        s.snapshot!.branch.timezone,
                      )}
                      {businessDate && <> · {businessDate}</>}
                    </p>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
        {loaded && (
          <div className="shrink-0 border-t p-3">
            <Button variant="outline" className="w-full" asChild>
              <Link href="/transactions" onClick={openQueue}>
                {t("View all requests")}
                <ArrowRight />
              </Link>
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
