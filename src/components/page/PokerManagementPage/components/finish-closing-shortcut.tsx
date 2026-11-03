"use client";

import { LockKeyhole, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { usePokerManagementContext } from "../PokerManagementProvider";
import { useClosingTask } from "./closing-task";
import { useText } from "./shared";

export function FinishClosingShortcut() {
  const s = usePokerManagementContext();
  const closing = useClosingTask();
  const t = useText();
  if (!closing.task) return null;
  const pending =
    s.store.readModel?.pendingCurrent ?? s.pendingApprovals.length;
  const paused = s.busy || s.retryRequired;
  return (
    <section
      aria-label={t("Closing in progress")}
      className="@container/closing-task flex min-w-0 flex-wrap items-center gap-3 rounded-lg border bg-muted/20 p-3 sm:px-4"
    >
      <LockKeyhole
        className="size-4 shrink-0 text-muted-foreground"
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="break-words text-sm font-medium">
          {t("Closing in progress")} · {closing.task.date}
        </p>
        <p className="text-xs text-muted-foreground" role="status">
          {pending} {t("pending approvals")} · {s.activePlayers.length}{" "}
          {t("active players")}
        </p>
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-1 @max-[300px]/closing-task:w-full">
        {paused ? (
          <Button
            variant="outline"
            className="h-10 sm:h-9 @max-[300px]/closing-task:flex-1"
            disabled
          >
            {t("Finish closing")}
          </Button>
        ) : (
          <Button
            variant="outline"
            className="h-10 sm:h-9 @max-[300px]/closing-task:flex-1"
            asChild
          >
            <Link
              href="/reports"
              onClick={(event) => {
                if (
                  event.button === 0 &&
                  !event.metaKey &&
                  !event.ctrlKey &&
                  !event.shiftKey &&
                  !event.altKey
                )
                  closing.requestResume();
              }}
            >
              {t("Finish closing")}
            </Link>
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-10 sm:size-9"
          onClick={closing.cancel}
          aria-label={t("Stop closing")}
          title={t("Stop closing")}
        >
          <X aria-hidden="true" />
        </Button>
      </div>
    </section>
  );
}
