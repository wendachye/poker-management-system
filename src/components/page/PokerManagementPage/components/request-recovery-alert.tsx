"use client";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { PokerManagementState } from "../usePokerManagementState";

type RecoveryState = Pick<
  PokerManagementState,
  | "retryRequired"
  | "recoveryError"
  | "canRetryLast"
  | "canRecoverLast"
  | "busy"
  | "retryLast"
  | "recoverLast"
  | "synchronizeRecovery"
  | "recoveredResult"
  | "notice"
>;

export function RequestRecoveryAlert({
  state,
  t,
  className,
  onRetry,
}: {
  state: RecoveryState;
  t: (text: string) => string;
  className?: string;
  onRetry?: () => void;
}) {
  if (!state.retryRequired) return null;
  return (
    <Alert className={className}>
      <AlertTitle>{t("Check previous request")}</AlertTitle>
      <AlertDescription>
        <p>
          {t(
            state.recoveryError
              ? "Saving is paused because this browser cannot access request recovery information. Check browser storage access, then try again."
              : state.canRetryLast
                ? "The last request has an unconfirmed result. Retry it before continuing."
                : "A previous request needs checking. Check whether it saved before making more changes.",
          )}
        </p>
        {state.canRecoverLast && (
          <p>
            {t(
              "If it did not save, its old request will be cancelled so you can enter it again.",
            )}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {state.canRetryLast && (
            <Button
              type="button"
              disabled={state.busy}
              onClick={onRetry ?? (() => void state.retryLast())}
            >
              {t("Retry last request")}
            </Button>
          )}
          {state.canRecoverLast && (
            <Button
              type="button"
              variant={state.canRetryLast ? "outline" : "default"}
              disabled={state.busy}
              onClick={() => void state.recoverLast()}
            >
              {t(state.busy ? "Checking…" : "Check previous request")}
            </Button>
          )}
          {state.recoveryError && (
            <Button
              type="button"
              variant="outline"
              disabled={state.busy}
              onClick={state.synchronizeRecovery}
            >
              {t("Try again")}
            </Button>
          )}
        </div>
      </AlertDescription>
    </Alert>
  );
}

export function RequestRecoveryResult({
  state,
  t,
  className,
}: {
  state: Pick<RecoveryState, "recoveredResult" | "notice">;
  t: (text: string) => string;
  className?: string;
}) {
  if (!state.recoveredResult) return null;
  return (
    <Alert role="status" className={className}>
      <AlertTitle>
        {t(
          state.recoveredResult === "saved"
            ? "Previous request saved"
            : "Previous request cancelled",
        )}
      </AlertTitle>
      <AlertDescription>{t(state.notice)}</AlertDescription>
    </Alert>
  );
}
