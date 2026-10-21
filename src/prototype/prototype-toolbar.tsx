"use client";

import { useState, useSyncExternalStore } from "react";
import {
  ArrowRight,
  Check,
  RotateCcw,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { useRouter } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { usePokerManagementContext } from "@/components/page/PokerManagementPage/PokerManagementProvider";
import { useText } from "@/components/page/PokerManagementPage/components/shared";
import { money } from "@/components/page/PokerManagementPage/utils";
import { debt } from "@/domain/selectors";
import {
  journeyProgress,
  prototypeJourneys,
  type PrototypeJourneyId,
} from "./journeys";
import {
  getPrototypeInfo,
  prototypePersonas,
  prototypeScenarios,
  resetPrototype,
  setPrototypePersona,
  startPrototypeJourney,
  subscribePrototype,
  type PrototypeScenario,
} from "./runtime";

const serverInfo = () => null;
type ResetIntent = {
  scenario: PrototypeScenario;
  journey?: PrototypeJourneyId;
  keepRole?: boolean;
};

/** Guides only open unsaved forms or screens. Every operational action stays with staff. */
export function PrototypeToolbar() {
  const s = usePokerManagementContext();
  const t = useText();
  const router = useRouter();
  const info = useSyncExternalStore(
    subscribePrototype,
    getPrototypeInfo,
    serverInfo,
  );
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<PrototypeScenario | null>(null);
  const [journeyChoice, setJourneyChoice] =
    useState<PrototypeJourneyId>("cash");
  const [reset, setReset] = useState<ResetIntent | null>(null);
  if (!info) return null;

  const blocked = s.busy || !!s.operation || !s.snapshot;
  const run = info.journey;
  const activeJourneyId = run ? run.id : journeyChoice;
  const targetPlayerId = run ? run.playerId : undefined;
  const targetTableId = run ? run.tableId : undefined;
  const targetDayId = run ? run.dayId : "";
  const progress = run
    ? journeyProgress(run, s.store, s.snapshot?.branch.id ?? "")
    : null;
  const currentPersona = progress?.current?.persona;
  const currentRole = prototypePersonas.find(
    (persona) => persona.id === currentPersona,
  )?.label;
  const journey = prototypeJourneys.find(
    (entry) => entry.id === activeJourneyId,
  )!;
  const selectedJourney = prototypeJourneys.find(
    (entry) => entry.id === journeyChoice,
  )!;
  const selectedScenario =
    choice ?? (info.scenario === "walkthrough" ? "busy" : info.scenario);
  const scenario = prototypeScenarios.find(
    (entry) => entry.id === selectedScenario,
  );

  function selectPersona(id: string) {
    try {
      setPrototypePersona(id);
      return true;
    } catch (error) {
      toast.error(
        t(error instanceof Error ? error.message : "Cannot switch demo role."),
      );
      return false;
    }
  }
  function rolePicker(className: string) {
    return (
      <Select
        value={info!.personaId}
        disabled={blocked}
        onValueChange={selectPersona}
      >
        <SelectTrigger
          className={`h-11 min-w-0 [&>span]:truncate ${className}`}
          aria-label={t("Demo role")}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="end">
          {prototypePersonas.map((persona) => (
            <SelectItem key={persona.id} value={persona.id}>
              {t(persona.label)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }
  function startJourney(id: PrototypeJourneyId) {
    setReset({ scenario: "walkthrough", journey: id });
  }
  function transactionScreen(status: "PENDING" | "APPROVED", query: string) {
    s.setDraft("tx.status", status);
    s.setDraft("tx.day", targetDayId);
    s.setDraft("tx.filter", "");
    s.setDraft("tx.search", query);
    s.setDraft("tx.page", "0");
    router.push("/transactions");
  }
  async function continueJourney() {
    if (blocked || !run || !progress?.current || progress.problem) return;
    const step = progress.current;
    if (!selectPersona(step.persona)) return;
    setOpen(false);
    await s.refresh();
    const action = step.action;
    if (action.kind === "check-in") {
      s.setDraft(
        "player.search",
        s.store.profiles.find((player) => player.id === targetPlayerId)
          ?.phone ?? "",
      );
      s.setDraft("player.status", "OUT");
      s.setDraft("player.type", "");
      s.setDraft("player.tag", "");
      s.setDraft("player.page", "0");
      router.push("/players");
      const seat = Array.from({ length: 9 }, (_, index) => index + 1).find(
        (number) =>
          !s.activePlayers.some(
            (player) =>
              player.tableId === targetTableId && player.seat === number,
          ),
      );
      s.startOperation({
        kind: "check-in",
        playerId: targetPlayerId,
        tableId: targetTableId,
        seat,
      });
    } else if (action.kind === "request") {
      transactionScreen("PENDING", "");
      s.startOperation({
        kind: "transaction",
        type: action.type,
        playerId: targetPlayerId,
        tableId: activeJourneyId === "exceptions" ? targetTableId : undefined,
      });
    } else if (action.kind === "review") {
      transactionScreen("PENDING", action.requestId);
    } else if (action.kind === "reversal") {
      transactionScreen("APPROVED", action.transactionId);
    } else {
      s.setDraft("report.day", targetDayId);
      s.setDraft("report.mode", "day");
      router.push("/reports");
    }
  }
  async function confirmReset() {
    if (!reset || blocked) return;
    if (reset.journey) startPrototypeJourney(reset.journey);
    else {
      const persona = reset.keepRole ? info!.personaId : "admin";
      resetPrototype(reset.scenario);
      setPrototypePersona(persona);
    }
    await s.refresh();
    setReset(null);
    setChoice(null);
    setOpen(false);
    router.push(
      reset.journey
        ? reset.journey === "exceptions"
          ? "/transactions"
          : "/players"
        : "/dashboard",
    );
  }
  function continueButton(className = "") {
    return (
      <Button
        type="button"
        className={`h-11 shrink-0 ${className}`}
        disabled={blocked || !!progress?.problem}
        onClick={continueJourney}
      >
        {t("Continue")}
        <ArrowRight aria-hidden="true" />
      </Button>
    );
  }

  return (
    <>
      <div className="min-w-0 border-b bg-muted/30 px-4 py-2 sm:px-6">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <div className="flex min-w-0 flex-col gap-0.5 sm:flex-row sm:items-center sm:gap-2">
            <Badge variant="outline" className="w-fit text-[10px]">
              {t("Prototype")}
            </Badge>
            <span className="text-[10px] text-muted-foreground sm:text-xs">
              {t("Fictional data")}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {rolePicker("w-[7.75rem]")}
            <Button
              type="button"
              variant="outline"
              className="h-11 px-3"
              aria-label={t("Demo tools")}
              title={t("Demo tools")}
              disabled={blocked}
              onClick={() => {
                setChoice(null);
                setOpen(true);
              }}
            >
              <SlidersHorizontal aria-hidden="true" />
              <span className="hidden sm:inline">{t("Demo tools")}</span>
            </Button>
          </div>
        </div>
        {progress && (
          <section
            aria-label={t("Guided journey")}
            className="mt-2 flex min-w-0 items-center justify-between gap-3 border-t pt-2"
          >
            <div className="min-w-0 space-y-0.5" aria-live="polite">
              <p className="text-[10px] leading-4 text-muted-foreground sm:text-xs">
                {t(journey.label)} ·{" "}
                {progress.complete
                  ? t("Journey complete")
                  : `${t("Step")} ${progress.index + 1} ${t("of")} ${progress.steps.length}`}
                {!progress.problem && progress.current && (
                  <> · {t(currentRole ?? "")}</>
                )}
              </p>
              <p className="break-words text-xs font-medium leading-5 sm:text-sm">
                {t(
                  progress.problem ||
                    progress.current?.title ||
                    "All journey steps are complete. Review the daily report.",
                )}
              </p>
            </div>
            {progress.problem ? (
              <Button
                type="button"
                variant="outline"
                className="h-11 shrink-0"
                disabled={blocked}
                onClick={() => startJourney(activeJourneyId)}
              >
                {t("Restart journey")}
              </Button>
            ) : progress.complete ? (
              <Button
                type="button"
                variant="outline"
                className="h-11 shrink-0"
                disabled={blocked}
                onClick={() => router.push("/reports")}
              >
                {t("View report")}
              </Button>
            ) : (
              continueButton()
            )}
          </section>
        )}
      </div>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          showCloseButton={false}
          className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-md"
        >
          <SheetHeader className="relative border-b pr-16">
            <SheetTitle>{t("Demo tools")}</SheetTitle>
            <SheetDescription>
              {t(
                "Explore the workflow with fictional data. Reloading the browser starts a fresh demo.",
              )}
            </SheetDescription>
            <SheetClose asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="absolute top-2 right-2 size-11"
                aria-label={t("Close")}
              >
                <X aria-hidden="true" />
              </Button>
            </SheetClose>
          </SheetHeader>
          <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-4">
            <section className="space-y-3" aria-label={t("Guided journey")}>
              <h3 className="text-sm font-semibold">{t("Guided journey")}</h3>
              <p className="text-xs leading-5 text-muted-foreground">
                {t(
                  "The guide opens the right screen and role. You review and submit every action.",
                )}
              </p>
              <Select
                value={journeyChoice}
                onValueChange={(value) =>
                  setJourneyChoice(value as PrototypeJourneyId)
                }
                disabled={blocked}
              >
                <SelectTrigger
                  className="h-11 w-full"
                  aria-label={t("Choose a journey")}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {prototypeJourneys.map((entry) => (
                    <SelectItem value={entry.id} key={entry.id}>
                      {t(entry.label)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs leading-5 text-muted-foreground">
                {t(selectedJourney.detail)}
              </p>
              <Button
                type="button"
                variant={run ? "outline" : "default"}
                className="h-11 w-full"
                disabled={blocked}
                onClick={() => startJourney(journeyChoice)}
              >
                <RotateCcw aria-hidden="true" />
                {t(
                  run && activeJourneyId === journeyChoice
                    ? "Restart journey"
                    : "Start journey",
                )}
              </Button>
              {progress && (
                <div className="space-y-4 rounded-lg border p-3">
                  <div className="space-y-1">
                    <p className="text-xs text-muted-foreground">
                      {t(journey.label)} ·{" "}
                      {t(
                        progress.complete ? "Journey complete" : "Current step",
                      )}
                    </p>
                    <p className="text-sm font-medium">
                      {t(
                        progress.problem ||
                          progress.current?.title ||
                          "All journey steps are complete. Review the daily report.",
                      )}
                    </p>
                    {progress.current && !progress.problem && (
                      <p className="text-xs leading-5 text-muted-foreground">
                        {t(progress.current.detail)}
                      </p>
                    )}
                  </div>
                  <dl className="space-y-2 text-xs">
                    <div className="flex justify-between gap-3">
                      <dt className="text-muted-foreground">
                        {t("Expected cash")}
                      </dt>
                      <dd className="font-medium tabular-nums">
                        {money(progress.expectedCash)}
                      </dd>
                    </div>
                    {run && activeJourneyId === "credit" && (
                      <div className="flex justify-between gap-3">
                        <dt className="text-muted-foreground">
                          {t("Outstanding credit")}
                        </dt>
                        <dd className="font-medium tabular-nums">
                          {money(debt(s.store, targetPlayerId ?? ""))}
                        </dd>
                      </div>
                    )}
                    {progress.current?.action.kind === "close" && (
                      <div className="flex justify-between gap-3">
                        <dt className="text-muted-foreground">
                          {t("Counted cash")}
                        </dt>
                        <dd className="font-medium tabular-nums">
                          {money(progress.current.action.countedCash)}
                        </dd>
                      </div>
                    )}
                  </dl>
                  {progress.current &&
                    !progress.problem &&
                    continueButton("w-full")}
                  <ol className="space-y-2" aria-label={t("Journey steps")}>
                    {progress.steps.map((step, index) => (
                      <li
                        key={step.id}
                        aria-current={
                          progress.index === index ? "step" : undefined
                        }
                        className={`flex min-w-0 items-start gap-2 text-xs leading-5 ${progress.index === index ? "font-medium" : "text-muted-foreground"}`}
                      >
                        <span className="flex size-5 shrink-0 items-center justify-center rounded-full border text-[10px]">
                          {step.complete ? (
                            <Check className="size-3" aria-hidden="true" />
                          ) : (
                            index + 1
                          )}
                          <span className="sr-only">
                            {step.complete && t("Complete")}
                          </span>
                        </span>
                        <span className="min-w-0 flex-1">{t(step.title)}</span>
                        <span className="shrink-0 text-[10px] font-normal">
                          {t(
                            prototypePersonas.find(
                              (persona) => persona.id === step.persona,
                            )!.label,
                          )}
                        </span>
                      </li>
                    ))}
                  </ol>
                </div>
              )}
            </section>
            <section className="space-y-3" aria-label={t("Current demo state")}>
              <h3 className="text-sm font-semibold">
                {t("Current demo state")}
              </h3>
              <dl className="grid grid-cols-3 gap-2 rounded-lg border bg-muted/20 p-3">
                {[
                  ["Active players", String(s.activePlayers.length)],
                  ["Pending approvals", String(s.pendingApprovals.length)],
                  ["Expected cash", money(s.totals.expectedCash)],
                ].map(([label, value]) => (
                  <div className="min-w-0 space-y-1" key={label}>
                    <dt className="text-[11px] leading-4 text-muted-foreground">
                      {t(label)}
                    </dt>
                    <dd className="break-words text-sm font-semibold tabular-nums [overflow-wrap:anywhere]">
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
            <section className="space-y-3" aria-label={t("Free exploration")}>
              <h3 className="text-sm font-semibold">{t("Free exploration")}</h3>
              <Select
                value={selectedScenario}
                onValueChange={(value) => setChoice(value as PrototypeScenario)}
                disabled={blocked}
              >
                <SelectTrigger
                  className="h-11 w-full"
                  aria-label={t("Sample scenario")}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {prototypeScenarios
                    .filter((entry) => entry.id !== "walkthrough")
                    .map((entry) => (
                      <SelectItem value={entry.id} key={entry.id}>
                        {t(entry.label)}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              <p className="text-xs leading-5 text-muted-foreground">
                {scenario && t(scenario.description)}
              </p>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  type="button"
                  variant="outline"
                  className="h-11"
                  disabled={blocked}
                  onClick={() => setReset({ scenario: selectedScenario })}
                >
                  {t("Load scenario")}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="h-11"
                  disabled={blocked}
                  onClick={() =>
                    run
                      ? startJourney(activeJourneyId)
                      : setReset({ scenario: info.scenario, keepRole: true })
                  }
                >
                  <RotateCcw aria-hidden="true" />
                  {t("Reset demo")}
                </Button>
              </div>
            </section>
          </div>
        </SheetContent>
      </Sheet>
      <AlertDialog
        open={!!reset}
        onOpenChange={(value) => !value && setReset(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t(
                reset?.journey ? "Start a fresh journey?" : "Reset demo data?",
              )}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                "This clears only the fictional changes in this browser and loads the selected scenario.",
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="h-11">
              {t("Cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              className="h-11"
              onClick={confirmReset}
              disabled={blocked}
            >
              {t(reset?.journey ? "Start journey" : "Reset demo")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
