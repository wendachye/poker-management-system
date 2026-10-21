"use client";

import { useState, useSyncExternalStore } from "react";
import { Check, RotateCcw, SlidersHorizontal, X } from "lucide-react";
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
import {
  getPrototypeInfo,
  prototypePersonas,
  prototypeScenarios,
  resetPrototype,
  setPrototypePersona,
  subscribePrototype,
  type PrototypeScenario,
} from "./runtime";

const serverInfo = () => null;
type ResetIntent = {
  scenario: PrototypeScenario;
  guided: boolean;
  keepRole: boolean;
};

/** Presentation controls for exploring the existing screens with fictional data. */
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
  const [reset, setReset] = useState<ResetIntent | null>(null);
  if (!info) return null;

  const blocked = s.busy || !!s.operation || !s.snapshot;
  const selectedScenario = choice ?? info.scenario;
  const scenario = prototypeScenarios.find(
    (entry) => entry.id === selectedScenario,
  );
  const currentRequests = s.store.approvals.filter(
    (entry) => entry.dayId === s.store.currentDayId,
  );
  const currentEntries = s.store.transactions.filter(
    (entry) => entry.dayId === s.store.currentDayId,
  );
  const buyInPosted = currentEntries.some((entry) => entry.type === "Buy-in");
  const cashOutPosted = currentEntries.some(
    (entry) => entry.type === "Cash-out",
  );
  const pendingBuyIn = currentRequests.some(
    (entry) => entry.type === "Buy-in" && entry.status === "PENDING",
  );
  const pendingCashOut = currentRequests.some(
    (entry) => entry.type === "Cash-out" && entry.status === "PENDING",
  );
  const eligiblePlayers = s.activePlayers.filter(
    (player) =>
      !s.pendingApprovals.some((entry) => entry.playerId === player.id),
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

  function players(role: string, status: string) {
    if (!selectPersona(role)) return;
    ["search", "type", "tag"].forEach((key) => s.setDraft("player." + key, ""));
    s.setDraft("player.status", status);
    s.setDraft("player.page", "0");
    setOpen(false);
    router.push("/players");
  }

  function review(type: "Buy-in" | "Cash-out", role: string, pending: boolean) {
    if (!selectPersona(role)) return;
    s.setDraft("tx.status", pending ? "PENDING" : "APPROVED");
    s.setDraft("tx.day", s.store.currentDayId ?? "");
    s.setDraft("tx.filter", type);
    s.setDraft("tx.search", "");
    s.setDraft("tx.page", "0");
    setOpen(false);
    router.push("/transactions");
  }

  const steps = [
    {
      title: "Check in a player",
      detail: "Choose a player and a free seat.",
      role: "Cashier",
      complete: s.store.sessions.some(
        (entry) => entry.dayId === s.store.currentDayId,
      ),
      available: !s.locked,
      action: () => players("cashier", "OUT"),
    },
    {
      title: "Request a buy-in",
      detail: "Enter an amount using the table limits.",
      role: "Cashier",
      complete: currentRequests.some((entry) => entry.type === "Buy-in"),
      available: !s.locked && !!eligiblePlayers.length,
      action: () => players("cashier", "ACTIVE"),
    },
    {
      title: "Review the buy-in",
      detail: "Approve as a different staff member.",
      role: "Manager",
      complete: buyInPosted,
      available: pendingBuyIn || buyInPosted,
      action: () => review("Buy-in", "manager", pendingBuyIn),
    },
    {
      title: "Request a cash-out",
      detail: "Use the player actions menu to return chips.",
      role: "Cashier",
      complete: currentRequests.some((entry) => entry.type === "Cash-out"),
      available: !s.locked && buyInPosted && !!eligiblePlayers.length,
      action: () => players("cashier", "ACTIVE"),
    },
    {
      title: "Review the cash-out",
      detail: "Review the cash payout and credit settlement.",
      role: "Admin",
      complete: cashOutPosted,
      available: pendingCashOut || cashOutPosted,
      action: () => review("Cash-out", "admin", pendingCashOut),
    },
    {
      title: "Close the day",
      detail: "Resolve the checklist, count cash and close the day.",
      role: "Admin",
      complete: s.day?.status === "CLOSED",
      available: cashOutPosted || s.day?.status === "CLOSED",
      action: () => {
        if (!selectPersona("admin")) return;
        setOpen(false);
        router.push("/reports");
      },
    },
  ];

  function confirmReset() {
    if (!reset || blocked) return;
    const persona = reset.keepRole
      ? info!.personaId
      : reset.scenario === "walkthrough"
        ? "cashier"
        : "admin";
    resetPrototype(reset.scenario);
    setPrototypePersona(persona);
    setReset(null);
    setChoice(null);
    setOpen(false);
    router.push(reset.guided ? "/players" : "/dashboard");
  }

  return (
    <>
      <div className="flex min-w-0 items-center justify-between gap-2 border-b bg-muted/30 px-4 py-2 sm:px-6">
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
              {rolePicker("w-full")}
              {!!s.operation && (
                <p className="text-xs text-muted-foreground">
                  {t("Close the current form before changing demo controls.")}
                </p>
              )}
            </section>
            <section className="space-y-3" aria-label={t("Sample scenario")}>
              <h3 className="text-sm font-semibold">{t("Sample scenario")}</h3>
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
                  {prototypeScenarios.map((entry) => (
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
                  onClick={() =>
                    setReset({
                      scenario: selectedScenario,
                      guided: false,
                      keepRole: false,
                    })
                  }
                >
                  {t("Load scenario")}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="h-11"
                  disabled={blocked}
                  onClick={() =>
                    setReset({
                      scenario: info.scenario,
                      guided: false,
                      keepRole: true,
                    })
                  }
                >
                  <RotateCcw aria-hidden="true" />
                  {t("Reset demo")}
                </Button>
              </div>
            </section>
            <section className="space-y-3" aria-label={t("Guided walkthrough")}>
              <h3 className="text-sm font-semibold">
                {t("Guided walkthrough")}
              </h3>
              <p className="text-xs leading-5 text-muted-foreground">
                {t(
                  info.scenario === "walkthrough"
                    ? "Select a step to switch roles and open its screen."
                    : "Start the guided walkthrough for a fresh player visit, from check-in to day closing.",
                )}
              </p>
              <Button
                type="button"
                className="h-11 w-full"
                disabled={blocked}
                onClick={() =>
                  setReset({
                    scenario: "walkthrough",
                    guided: true,
                    keepRole: false,
                  })
                }
              >
                {t("Start guided walkthrough")}
              </Button>
              {info.scenario === "walkthrough" && (
                <ol className="space-y-2">
                  {steps.map((step, index) => (
                    <li key={step.title}>
                      <Button
                        type="button"
                        variant="outline"
                        className="h-auto min-h-16 w-full min-w-0 flex-col items-stretch gap-1 whitespace-normal px-3 py-3 text-left"
                        aria-label={t(step.title)}
                        disabled={blocked || !step.available}
                        onClick={step.action}
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="flex size-6 shrink-0 items-center justify-center rounded-full border text-xs">
                            {step.complete ? (
                              <Check className="size-3.5" aria-hidden="true" />
                            ) : (
                              index + 1
                            )}
                          </span>
                          <span className="min-w-0 flex-1 text-sm font-medium">
                            {t(step.title)}
                          </span>
                          <span className="shrink-0 text-[10px] font-normal text-muted-foreground">
                            {t(step.role)}
                          </span>
                          {step.complete && (
                            <span className="sr-only">{t("Complete")}</span>
                          )}
                        </span>
                        <span className="pl-8 text-xs font-normal leading-5 text-muted-foreground">
                          {t(step.detail)}
                        </span>
                      </Button>
                    </li>
                  ))}
                </ol>
              )}
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
            <AlertDialogTitle>{t("Reset demo data?")}</AlertDialogTitle>
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
              {t(reset?.guided ? "Start walkthrough" : "Reset demo")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
