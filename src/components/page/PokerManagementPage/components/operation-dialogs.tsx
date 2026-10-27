"use client";
import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { displayName } from "@/lib/display-name";
import { parseCashOutDraftAmount } from "@/lib/cash-out-form";
import {
  buyInQuickAmounts,
  validBuyInDraftAmount,
} from "@/lib/operation-form-options";
import type { EntryType, PlayerType, PlayerTag } from "@/domain/model";
import { effectiveTableRules, venueSettings } from "@/domain/settings";
import { MAX_MONEY } from "@/domain/money";
import type { Operation } from "../usePokerManagementState";
import { usePokerManagementContext } from "../PokerManagementProvider";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  ActionForm,
  Badge,
  Field,
  Select,
  ChoiceButtons,
  SearchSelect,
  FormActions,
  FormGrid,
  FormSection,
  Modal,
  MoneyInput,
  useText,
} from "./shared";
import { money, parseMoney } from "../utils";
import { CashOutSummary, EntryImpact } from "./entry-impact";
import type { CheckInContinuation } from "./check-in-continuation";
import { PlayerDetails, EditPlayer } from "./player-details";
import {
  playerMoveBlockedReason,
  seatMoveBlockedReason,
  seatSwapBlockedReason,
} from "./table-seat-move";
function useFields(initial: Record<string, string>) {
  const [values, setValues] = useState(initial);
  return {
    value: (key: string, fallback = "") => values[key] ?? fallback,
    set: (key: string, value: string) =>
      setValues((old) => ({ ...old, [key]: value })),
  };
}
export function OperationDialogs() {
  const s = usePokerManagementContext();
  if (!s.operation) return null;
  switch (s.operation.kind) {
    case "transaction":
      return <TransactionDialog initial={s.operation} />;
    case "check-in":
      return <CheckInDialog initial={s.operation} />;
    case "move":
      return <MoveDialog initial={s.operation} />;
    case "swap":
      return <SwapDialog initial={s.operation} />;
    case "player":
      return <PlayerDetails playerId={s.operation.playerId} />;
    case "edit-player":
      return <EditPlayer playerId={s.operation.playerId} />;
    default:
      return null;
  }
}
export const entryTypes: EntryType[] = [
  "Buy-in",
  "Cash-out",
  "Credit Repayment",
  "Rake",
  "Tips",
  "Insurance Premium",
  "Insurance Payout",
  "Jackpot Contribution",
  "Jackpot Payout",
  "Cash Received",
  "Cash Payout",
];

function CheckInDialog({
  initial,
}: {
  initial: Extract<Operation, { kind: "check-in" }>;
}) {
  const s = usePokerManagementContext(),
    t = useText();
  const settings = venueSettings(s.store);
  const [step, setStep] = useState<"player" | "seat">(
    initial.playerId ? "seat" : "player",
  );
  const stageRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    stageRef.current
      ?.querySelector<HTMLElement>(
        'input:not([type="hidden"]),[role="combobox"]',
      )
      ?.focus();
  }, [step]);
  const [moreOptions, setMoreOptions] = useState(false);
  const [buyInNext, setBuyInNext] = useState(true);
  const buyInNextId = useId();
  const submittedVisit = useRef<CheckInContinuation | null>(null);
  const openTables = s.tables.filter((table) => table.status === "OPEN");
  const freeSeats = (tableId: string) =>
    9 - s.activePlayers.filter((player) => player.tableId === tableId).length;
  const availableTables = openTables.filter((table) => freeSeats(table.id) > 0);
  const { value, set } = useFields({
    existing: initial.playerId ?? "",
    table:
      initial.tableId ??
      (availableTables.length === 1 ? availableTables[0].id : ""),
    seat: initial.seat ? String(initial.seat) : "",
    mode:
      initial.playerId ||
      s.players.some((p) => p.status !== "ACTIVE" && !p.tags.includes("Banned"))
        ? "returning"
        : "new",
  });
  const supervisor = ["MANAGER", "ADMIN"].includes(s.user!.role),
    operator = s.user?.role !== "DEALER";
  const returning = value("mode") === "returning",
    selected = s.players.find((p) => p.id === value("existing"));
  const duplicate = !returning
    ? s.players.find(
        (player) => player.phone === value("phone").replace(/[\s()-]/g, ""),
      )
    : undefined;
  const creditBlocked =
    !settings.creditEnabled &&
    (returning
      ? selected?.type === "CREDIT"
      : value("type", "CASH") === "CREDIT");
  return (
    <Modal
      open
      onOpenChange={() => s.closeOperation()}
      title="Check in player"
      description="Choose a player and an available seat to start their visit."
    >
      <ActionForm
        disabled={s.locked || !operator}
        validationKey={
          step +
          ":" +
          ((returning ? "returning" : "new:" + value("type", "CASH")) +
            ":" +
            value("table"))
        }
        onSubmit={() => {
          if (duplicate)
            throw new Error(
              "This phone number belongs to an existing player. Select that player to check in.",
            );
          if (returning && !selected) throw new Error("Select player");
          if (creditBlocked)
            throw new Error("Credit accounts are disabled in venue settings.");
          if (step === "player") {
            setStep("seat");
            return false;
          }
          submittedVisit.current = {
            branchId: s.snapshot!.branch.id,
            dayId: s.day!.id,
            playerId: returning ? selected?.id : undefined,
            phone: returning ? selected!.phone : value("phone"),
            tableId: value("table"),
            seat: Number(value("seat")),
          };
          return s.submit({
            kind: "CHECK_IN",
            playerId: returning ? selected?.id : undefined,
            name: returning ? (selected?.name ?? "") : value("name"),
            phone: returning ? (selected?.phone ?? "") : value("phone"),
            type: returning
              ? (selected?.type ?? "CASH")
              : (value("type", "CASH") as PlayerType),
            creditLimit: returning
              ? (selected?.creditLimit ?? 0)
              : value("type", "CASH") === "CASH"
                ? 0
                : parseMoney(value("credit", "0"), true),
            tags: returning
              ? (selected?.tags ?? [])
              : value("tag")
                ? [value("tag") as PlayerTag]
                : [],
            tableId: value("table"),
            seat: Number(value("seat")),
          });
        }}
        onSuccess={() => {
          if (submittedVisit.current)
            s.finishCheckIn(submittedVisit.current, buyInNext);
        }}
      >
        <ol
          aria-label={t("Check-in steps")}
          className="mb-5 grid grid-cols-2 gap-3 text-xs"
        >
          {["player", "seat"].map((stage, index) => (
            <li
              key={stage}
              aria-current={step === stage ? "step" : undefined}
              className={
                "border-b-2 pb-2 " +
                (step === stage
                  ? "border-foreground font-medium text-foreground"
                  : "border-border text-muted-foreground")
              }
            >
              {index + 1}.{" "}
              {t(stage === "player" ? "Player details" : "Seat assignment")}
            </li>
          ))}
        </ol>
        <div ref={stageRef} className="min-w-0 space-y-5">
          {step === "player" && (
            <FormSection title="Player details">
              <Tabs
                value={returning ? "returning" : "new"}
                onValueChange={(v) => set("mode", v)}
              >
                <TabsList className="h-auto w-full">
                  <TabsTrigger value="returning" className="min-h-11">
                    {t("Returning player")}
                  </TabsTrigger>
                  <TabsTrigger value="new" className="min-h-11">
                    {t("New player")}
                  </TabsTrigger>
                </TabsList>
                <TabsContent value="returning" className="space-y-4 pt-3">
                  <Field
                    label="Player"
                    hint="Returning players keep their profile, restrictions, and outstanding credit."
                  >
                    <SearchSelect
                      required
                      value={value("existing")}
                      onValueChange={(v) => set("existing", v)}
                      options={[
                        { value: "", label: "Select player" },
                        ...s.players
                          .filter(
                            (p) =>
                              p.status !== "ACTIVE" &&
                              !p.tags.includes("Banned"),
                          )
                          .map((p) => ({
                            value: p.id,
                            label: displayName(p.name) + " · " + p.phone,
                            searchTerms: [p.name],
                            phoneNumbers: [p.phone],
                            disabled:
                              p.type === "CREDIT" && !settings.creditEnabled,
                          })),
                      ]}
                    />
                  </Field>
                  {selected && (
                    <div className="flex flex-wrap items-center gap-2 rounded-lg bg-muted p-3 text-sm">
                      <Badge>{selected.type}</Badge>
                      <span>
                        {t("Outstanding credit")}: {money(selected.creditUsed)}
                      </span>
                    </div>
                  )}
                </TabsContent>
                <TabsContent value="new" className="space-y-4 pt-3">
                  <FormGrid>
                    <Field label="Player name">
                      <Input
                        required
                        maxLength={200}
                        autoComplete="name"
                        value={value("name")}
                        onChange={(e) => set("name", e.target.value)}
                      />
                    </Field>
                    <Field
                      label="Phone"
                      hint="Use the country code, for example +60123456789."
                    >
                      <Input
                        required
                        type="tel"
                        maxLength={30}
                        autoComplete="tel"
                        placeholder="+60123456789"
                        value={value("phone")}
                        onChange={(e) => set("phone", e.target.value)}
                      />
                    </Field>
                  </FormGrid>
                  {duplicate && (
                    <Alert role="status">
                      <AlertDescription className="min-w-0 space-y-3">
                        <div className="space-y-1">
                          <p className="font-medium text-foreground">
                            {t("Existing player found")}
                          </p>
                          <p className="break-words text-foreground [overflow-wrap:anywhere]">
                            {displayName(duplicate.name)} · {duplicate.phone}
                          </p>
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge>{duplicate.type}</Badge>
                            {duplicate.creditUsed > 0 && (
                              <span>
                                {t("Outstanding credit")}:{" "}
                                {money(duplicate.creditUsed)}
                              </span>
                            )}
                          </div>
                          <p>
                            {t(
                              duplicate.tags.includes("Banned")
                                ? "Banned players cannot check in."
                                : duplicate.status === "ACTIVE"
                                  ? "This player is already checked in."
                                  : duplicate.type === "CREDIT" &&
                                      !settings.creditEnabled
                                    ? "Credit accounts are disabled in venue settings."
                                    : "Use this profile to keep its history and account rules.",
                            )}
                          </p>
                        </div>
                        {!duplicate.tags.includes("Banned") && (
                          <Button
                            type="button"
                            variant="outline"
                            className="min-h-11 w-full sm:w-auto"
                            disabled={
                              duplicate.status !== "ACTIVE" &&
                              duplicate.type === "CREDIT" &&
                              !settings.creditEnabled
                            }
                            onClick={() => {
                              if (duplicate.status === "ACTIVE") {
                                s.startOperation({
                                  kind: "player",
                                  playerId: duplicate.id,
                                });
                                return;
                              }
                              set("existing", duplicate.id);
                              set("mode", "returning");
                            }}
                          >
                            {t(
                              duplicate.status === "ACTIVE"
                                ? "View player"
                                : "Use existing player",
                            )}
                          </Button>
                        )}
                      </AlertDescription>
                    </Alert>
                  )}
                  <Field
                    label="Player type"
                    hint={
                      !supervisor
                        ? "New credit accounts require a manager."
                        : undefined
                    }
                  >
                    <ChoiceButtons
                      className="grid-cols-2"
                      aria-label={t("Player type")}
                      required
                      value={value("type", "CASH")}
                      onValueChange={(v) => set("type", v)}
                      options={[
                        { value: "CASH", label: "CASH" },
                        {
                          value: "CREDIT",
                          label: "CREDIT",
                          disabled: !supervisor || !settings.creditEnabled,
                        },
                      ]}
                    />
                  </Field>
                  {value("type", "CASH") === "CREDIT" && (
                    <Field
                      label="Credit limit (RM)"
                      hint="New credit accounts require a manager."
                    >
                      <MoneyInput
                        required
                        value={value("credit")}
                        onChange={(e) => set("credit", e.target.value)}
                      />
                    </Field>
                  )}
                  <Collapsible open={moreOptions} onOpenChange={setMoreOptions}>
                    <CollapsibleTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        className="h-11 w-full justify-between px-0 text-muted-foreground"
                      >
                        {t("More options")}
                        {value("tag") ? " · " + t(value("tag")) : ""}
                        <ChevronDown
                          aria-hidden="true"
                          className={moreOptions ? "rotate-180" : undefined}
                        />
                      </Button>
                    </CollapsibleTrigger>
                    <CollapsibleContent className="pt-2">
                      <Field label="Tag" optional>
                        <Select
                          value={value("tag")}
                          onValueChange={(v) => set("tag", v)}
                          options={["", "VIP", "Risk"].map((v) => ({
                            value: v,
                            label: v || "None",
                          }))}
                        />
                      </Field>
                    </CollapsibleContent>
                  </Collapsible>
                </TabsContent>
              </Tabs>
              {!settings.creditEnabled && (
                <Alert>
                  <AlertDescription>
                    {t("Credit accounts are disabled in venue settings.")}
                  </AlertDescription>
                </Alert>
              )}
            </FormSection>
          )}
          {step === "seat" && (
            <>
              {duplicate && (
                <Alert variant="destructive" role="alert">
                  <AlertDescription>
                    {t(
                      "This phone number belongs to an existing player. Select that player to check in.",
                    )}
                  </AlertDescription>
                </Alert>
              )}
              <div className="flex min-w-0 items-start justify-between gap-3 rounded-lg border bg-muted/20 p-3">
                <div className="min-w-0 space-y-1 text-sm">
                  <p className="break-words font-medium [overflow-wrap:anywhere]">
                    {displayName(
                      returning ? (selected?.name ?? "") : value("name"),
                    )}
                  </p>
                  <p className="break-words text-xs text-muted-foreground">
                    {returning ? selected?.phone : value("phone")} ·{" "}
                    {t(
                      returning
                        ? (selected?.type ?? "CASH")
                        : value("type", "CASH"),
                    )}
                  </p>
                  {returning && selected && selected.creditUsed > 0 && (
                    <p className="text-xs text-muted-foreground">
                      {t("Outstanding credit")}: {money(selected.creditUsed)}
                    </p>
                  )}
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  className="h-11 shrink-0 px-2 text-xs"
                  onClick={() => setStep("player")}
                >
                  {t("Change player")}
                </Button>
              </div>
              <FormSection title="Seat assignment">
                <Field label="Table">
                  <Select
                    required
                    value={value("table")}
                    className="[&>span]:min-w-0"
                    onValueChange={(v) => {
                      set("table", v);
                      set("seat", "");
                    }}
                    options={[
                      { value: "", label: "Select table" },
                      ...openTables.map((table) => {
                        const rules = effectiveTableRules(s.store, table);
                        return {
                          value: table.id,
                          disabled: freeSeats(table.id) === 0,
                          label:
                            displayName(table.name) +
                            " · " +
                            money(rules.smallBlind) +
                            " / " +
                            money(rules.bigBlind) +
                            " · " +
                            freeSeats(table.id) +
                            " " +
                            t("seats available"),
                        };
                      }),
                    ]}
                  />
                </Field>
                {value("table") ? (
                  <Field
                    label="Seat"
                    hint="Choose an available seat. Occupied seats are disabled."
                  >
                    <ChoiceButtons
                      aria-label={t("Seat")}
                      required
                      value={value("seat")}
                      onValueChange={(v) => set("seat", v)}
                      options={[
                        ...Array.from({ length: 9 }, (_, i) => i + 1).map(
                          (seat) => ({
                            value: String(seat),
                            label: t("Seat") + " " + seat,
                            disabled: s.activePlayers.some(
                              (player) =>
                                player.tableId === value("table") &&
                                player.seat === seat,
                            ),
                          }),
                        ),
                      ]}
                    />
                  </Field>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {t("Select a table to see available seats.")}
                  </p>
                )}
                <p className="text-xs leading-5 text-muted-foreground">
                  {t(
                    "Check-in reserves the seat. No balance changes until a buy-in is approved.",
                  )}
                </p>
              </FormSection>
              <label
                htmlFor={buyInNextId}
                className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border p-3"
              >
                <Checkbox
                  id={buyInNextId}
                  className="mt-0.5"
                  checked={buyInNext}
                  onCheckedChange={(checked) => setBuyInNext(checked === true)}
                  aria-describedby={buyInNextId + "-hint"}
                />
                <span className="min-w-0 space-y-1 text-sm">
                  <span className="block font-medium">
                    {t("Open buy-in after check-in")}
                  </span>
                  <span
                    id={buyInNextId + "-hint"}
                    className="block text-xs leading-5 text-muted-foreground"
                  >
                    {t(
                      "A buy-in draft opens for this player. Review the amount before sending it for approval.",
                    )}
                  </span>
                </span>
              </label>
            </>
          )}
        </div>
        <FormActions disabled={creditBlocked || !!duplicate}>
          {step === "player"
            ? "Choose seat"
            : buyInNext
              ? "Check in & buy-in"
              : "Check in only"}
        </FormActions>
      </ActionForm>
    </Modal>
  );
}
function TransactionDialog({
  initial,
}: {
  initial: Extract<Operation, { kind: "transaction" }>;
}) {
  const s = usePokerManagementContext(),
    t = useText();
  const settings = venueSettings(s.store);
  const [changingType, setChangingType] = useState(!initial.type);
  const [changingPlayer, setChangingPlayer] = useState(!initial.playerId);
  const [noteOpen, setNoteOpen] = useState(false);
  const typePanel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (changingType)
      typePanel.current
        ?.querySelector<HTMLElement>('[role="combobox"]')
        ?.focus();
  }, [changingType]);
  const { value: val, set } = useFields({
    type: initial.type ?? (s.user?.role === "DEALER" ? "Rake" : "Buy-in"),
    player: initial.playerId ?? "",
    table: initial.tableId ?? "",
  });
  const type = val(
    "type",
    s.user?.role === "DEALER" ? "Rake" : "Buy-in",
  ) as EntryType;
  const sessionEntry = type === "Buy-in" || type === "Cash-out",
    repayment = type === "Credit Repayment",
    cashMovement = type === "Cash Received" || type === "Cash Payout";
  const options = sessionEntry
    ? s.activePlayers
    : repayment
      ? s.players.filter((p) => p.type === "CREDIT" && p.creditUsed > 0)
      : s.players;
  const selectedPlayer = s.players.find(
    (player) => player.id === val("player"),
  );
  const selectedTable = s.tables.find(
    (table) => table.id === selectedPlayer?.tableId,
  );
  const rules = effectiveTableRules(s.store, selectedTable);
  const creditPlayer = selectedPlayer?.type === "CREDIT";
  const pendingCredit = selectedPlayer
    ? s.pendingApprovals
        .filter(
          (request) =>
            request.playerId === selectedPlayer.id && request.type === "Buy-in",
        )
        .reduce((total, request) => total + request.amount, 0)
    : 0;
  const availableCredit = selectedPlayer
    ? Math.max(
        0,
        selectedPlayer.creditLimit - selectedPlayer.creditUsed - pendingCredit,
      )
    : 0;
  const title =
    type === "Buy-in" && selectedPlayer
      ? creditPlayer
        ? "Credit buy-in"
        : "Cash buy-in"
      : type;
  function enabled(candidate: EntryType) {
    if (candidate === "Tips") return settings.tipsEnabled;
    if (candidate === "Rake") return settings.rakeEnabled;
    if (candidate === "Insurance Premium" || candidate === "Insurance Payout")
      return settings.insuranceEnabled;
    if (candidate === "Jackpot Contribution" || candidate === "Jackpot Payout")
      return settings.jackpotEnabled;
    return true;
  }
  const disabledReason = !enabled(type)
    ? "This transaction type is disabled in venue settings. Choose another type or ask an administrator to update settings."
    : type === "Buy-in" &&
        selectedPlayer?.type === "CREDIT" &&
        !settings.creditEnabled
      ? "New credit buy-ins are disabled. Cash-out and repayment remain available."
      : "";
  const minimum =
    rules.buyInStep > 0
      ? Math.ceil(Math.max(1, rules.minBuyIn) / rules.buyInStep) *
        rules.buyInStep
      : Math.max(1, rules.minBuyIn);
  const buyInCap = creditPlayer
    ? Math.min(rules.maxBuyIn, availableCredit)
    : rules.maxBuyIn;
  const maximum =
    rules.buyInStep > 0
      ? Math.floor(buyInCap / rules.buyInStep) * rules.buyInStep
      : buyInCap;
  const cashOutAmount =
    type === "Cash-out" ? parseCashOutDraftAmount(val("amount")) : null;
  let amount = cashOutAmount ?? 0;
  if (type !== "Cash-out") {
    try {
      amount = parseMoney(val("amount", "0"), true);
    } catch {}
  }
  const quickAmounts = buyInQuickAmounts(minimum, maximum, rules.buyInStep);
  const validBuyInAmount =
    !disabledReason &&
    selectedPlayer?.status === "ACTIVE" &&
    !!selectedTable &&
    validBuyInDraftAmount(amount, minimum, maximum, rules.buyInStep);
  const validCashOutAmount =
    cashOutAmount !== null &&
    selectedPlayer?.status === "ACTIVE" &&
    selectedTable?.status === "OPEN";
  const noteField = (
    <Field
      label="Note"
      optional={!cashMovement}
      hint={
        cashMovement
          ? "Explain this cash movement."
          : "Add information for the reviewer."
      }
    >
      <Textarea
        required={cashMovement}
        minLength={cashMovement ? 3 : undefined}
        maxLength={500}
        rows={3}
        value={val("note")}
        onChange={(e) => set("note", e.target.value)}
      />
    </Field>
  );

  return (
    <Modal
      open
      onOpenChange={() => s.closeOperation()}
      title={title}
      description={
        type === "Buy-in" && selectedPlayer
          ? creditPlayer
            ? "Request chips on credit. No cash is collected."
            : "Request chips paid for in cash."
          : type === "Cash-out"
            ? "Enter the chips returned to calculate the cash payout."
            : repayment
              ? "Record cash received to reduce outstanding credit."
              : "Review the details before sending this request for independent approval."
      }
    >
      <ActionForm
        disabled={s.locked}
        validationKey={type}
        onSubmit={() => {
          if (disabledReason) throw new Error(disabledReason);
          return s.submit({
            kind: "REQUEST",
            type,
            playerId: val("player") || undefined,
            tableId:
              sessionEntry || repayment ? undefined : val("table") || undefined,
            amount: parseMoney(val("amount"), type === "Cash-out"),
            note: val("note"),
          });
        }}
        onSuccess={() => {
          s.setDraft("tx.status", "PENDING");
          s.setDraft("tx.day", s.store.currentDayId ?? "");
          s.setDraft("tx.filter", "");
          s.setDraft("tx.search", "");
          s.setDraft("tx.page", "0");
          s.closeOperation();
        }}
      >
        <FormSection title="Request details">
          {changingType ? (
            <div ref={typePanel}>
              <Field label="Transaction type">
                <Select
                  required
                  value={type}
                  onValueChange={(v) => {
                    set("type", v);
                    set("player", "");
                    set("table", "");
                    set("amount", "");
                    setChangingPlayer(true);
                    setChangingType(false);
                  }}
                  options={entryTypes
                    .filter(
                      (v) =>
                        s.user?.role !== "DEALER" ||
                        ![
                          "Buy-in",
                          "Cash-out",
                          "Credit Repayment",
                          "Cash Received",
                          "Cash Payout",
                        ].includes(v),
                    )
                    .map((v) => ({
                      value: v,
                      label: v,
                      disabled: !enabled(v),
                    }))}
                />
              </Field>
            </div>
          ) : !sessionEntry ? (
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
              <p className="min-w-0 break-words text-sm">
                <span className="font-medium">{t(title)}</span>
              </p>
              <Button
                type="button"
                variant="ghost"
                className="h-11 shrink-0 px-2 text-xs sm:h-9"
                onClick={() => setChangingType(true)}
              >
                {t("Change type")}
              </Button>
            </div>
          ) : null}
          {disabledReason && (
            <Alert>
              <AlertDescription>{t(disabledReason)}</AlertDescription>
            </Alert>
          )}
          {type === "Buy-in" && !settings.creditEnabled && !disabledReason && (
            <p className="text-sm text-muted-foreground">
              {t(
                "New credit buy-ins are disabled. Cash-out and repayment remain available.",
              )}
            </p>
          )}
          {!changingPlayer &&
          selectedPlayer &&
          options.some((player) => player.id === selectedPlayer.id) ? (
            <div className="min-w-0 space-y-1 rounded-lg border px-3 py-2">
              <div className="flex min-w-0 items-start justify-between gap-3">
                <div className="min-w-0 self-center">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-xs text-muted-foreground">
                      {t("Player")}
                    </p>
                    <Badge>{selectedPlayer.type}</Badge>
                  </div>
                  <p className="break-words text-sm font-medium [overflow-wrap:anywhere]">
                    {displayName(selectedPlayer.name)}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  className="h-11 shrink-0 px-2 text-xs sm:h-9"
                  onClick={() => setChangingPlayer(true)}
                >
                  {t("Change player")}
                </Button>
              </div>
              <p className="break-words text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]">
                {selectedPlayer.phone}
                {selectedPlayer.status === "ACTIVE" && selectedTable && (
                  <>
                    {" · "}
                    {displayName(selectedTable.name)}
                    {" · "}
                    {t("Seat")} {selectedPlayer.seat}
                  </>
                )}
              </p>
            </div>
          ) : (
            <Field label="Player" optional={!sessionEntry && !repayment}>
              <SearchSelect
                value={val("player")}
                required={sessionEntry || repayment}
                onValueChange={(v) => {
                  set("player", v);
                  set("amount", "");
                  if (v) setChangingPlayer(false);
                }}
                options={[
                  {
                    value: "",
                    label:
                      sessionEntry || repayment
                        ? "Select player"
                        : "House / no player",
                  },
                  ...options.map((p) => ({
                    value: p.id,
                    label: displayName(p.name) + " · " + p.phone,
                    searchTerms: [p.name],
                    phoneNumbers: [p.phone],
                    disabled:
                      type === "Buy-in" &&
                      p.type === "CREDIT" &&
                      !settings.creditEnabled,
                  })),
                ]}
              />
            </Field>
          )}
          {(sessionEntry || repayment) && creditPlayer && selectedPlayer && (
            <div className="min-w-0 space-y-2 text-xs">
              <dl
                className={
                  type === "Cash-out"
                    ? "space-y-2"
                    : "grid grid-cols-2 gap-x-3 gap-y-2"
                }
              >
                {[
                  ["Outstanding credit", selectedPlayer.creditUsed],
                  ...(type === "Cash-out"
                    ? []
                    : [["Available credit", availableCredit]]),
                ].map(([label, value]) => (
                  <div key={label} className="min-w-0 space-y-1">
                    <dt className="text-muted-foreground">
                      {t(String(label))}
                    </dt>
                    <dd className="break-words font-medium tabular-nums">
                      {money(Number(value))}
                    </dd>
                  </div>
                ))}
              </dl>
              {type !== "Cash-out" && (
                <p className="text-muted-foreground">
                  {t("Credit limit")}: {money(selectedPlayer.creditLimit)}
                  {pendingCredit > 0 && (
                    <>
                      {" "}
                      · {t("Reserved for pending buy-ins")}:{" "}
                      {money(pendingCredit)}
                    </>
                  )}
                </p>
              )}
            </div>
          )}
          {(sessionEntry || repayment) && !options.length && (
            <p className="text-sm text-muted-foreground">
              {t(
                sessionEntry
                  ? "Check in a player before recording a buy-in or cash-out."
                  : "No players have outstanding credit.",
              )}
            </p>
          )}
          {!sessionEntry && !repayment && (
            <Field
              label="Table"
              optional={cashMovement}
              hint={
                cashMovement ? "Optional for house cash movements." : undefined
              }
            >
              <Select
                required={!cashMovement}
                value={val("table")}
                onValueChange={(v) => set("table", v)}
                options={[
                  {
                    value: "",
                    label: cashMovement ? "House / no table" : "Select table",
                  },
                  ...s.tables
                    .filter((table) => table.status === "OPEN")
                    .map((table) => {
                      const rules = effectiveTableRules(s.store, table);
                      return {
                        value: table.id,
                        label:
                          displayName(table.name) +
                          " · " +
                          money(rules.smallBlind) +
                          " / " +
                          money(rules.bigBlind),
                      };
                    }),
                ]}
              />
            </Field>
          )}
        </FormSection>
        <FormSection title="Amount and note">
          <Field
            label={
              type === "Cash-out"
                ? "Chips returned (RM)"
                : type === "Buy-in" && selectedPlayer
                  ? creditPlayer
                    ? "Chips on credit (RM)"
                    : "Cash received (RM)"
                  : repayment
                    ? "Cash repayment (RM)"
                    : "Amount (RM)"
            }
            hint={
              type === "Cash-out"
                ? "Enter the total value of chips returned."
                : repayment
                  ? "Repayment cannot exceed outstanding credit."
                  : undefined
            }
          >
            <MoneyInput
              required
              value={val("amount")}
              onChange={(e) => set("amount", e.target.value)}
            />
          </Field>
          {type === "Cash-out" && selectedPlayer && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-auto min-h-11 max-w-full whitespace-normal text-xs sm:min-h-9"
              data-mark-dirty="true"
              onClick={() => {
                set("amount", "0.00");
                s.setError("");
              }}
            >
              {t("No chips returned")}
            </Button>
          )}
          {repayment && selectedPlayer && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-auto min-h-11 max-w-full flex-wrap whitespace-normal text-xs sm:min-h-9"
              disabled={selectedPlayer.creditUsed <= 0}
              data-mark-dirty="true"
              onClick={() => {
                set("amount", (selectedPlayer.creditUsed / 100).toFixed(2));
                s.setError("");
              }}
            >
              {t("Repay full balance")} · {money(selectedPlayer.creditUsed)}
            </Button>
          )}
          {type === "Buy-in" && selectedPlayer && selectedTable && (
            <div className="min-w-0 space-y-2 text-xs leading-5 [overflow-wrap:anywhere]">
              <p>
                {t("Buy-in range")}: {money(rules.minBuyIn)} –{" "}
                {money(rules.maxBuyIn)}
                {rules.buyInStep > 0 && (
                  <>
                    {" "}
                    · {t("Buy-in increment")}: {money(rules.buyInStep)}
                  </>
                )}
              </p>
              {!disabledReason && (
                <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
                  {rules.minBuyIn > 0 && minimum <= maximum && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-auto min-h-11 max-w-full flex-col gap-0 whitespace-normal text-xs leading-4 sm:min-h-9 sm:flex-row sm:gap-1"
                      data-mark-dirty="true"
                      onClick={() => {
                        set("amount", (minimum / 100).toFixed(2));
                        s.setError("");
                      }}
                    >
                      <span>{t("Use minimum")}</span>
                      <span className="tabular-nums">{money(minimum)}</span>
                    </Button>
                  )}
                  {quickAmounts.map((suggestedAmount) => (
                    <Button
                      key={suggestedAmount}
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-auto min-h-11 max-w-full whitespace-normal text-xs leading-4 sm:min-h-9"
                      aria-label={
                        t("Use amount") + " · " + money(suggestedAmount)
                      }
                      data-mark-dirty="true"
                      onClick={() => {
                        set("amount", (suggestedAmount / 100).toFixed(2));
                        s.setError("");
                      }}
                    >
                      {money(suggestedAmount)}
                    </Button>
                  ))}
                  {maximum < MAX_MONEY &&
                    maximum >= minimum &&
                    maximum !== minimum && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-auto min-h-11 max-w-full flex-col gap-0 whitespace-normal text-xs leading-4 sm:min-h-9 sm:flex-row sm:gap-1"
                        data-mark-dirty="true"
                        onClick={() => {
                          set("amount", (maximum / 100).toFixed(2));
                          s.setError("");
                        }}
                      >
                        <span>{t("Use maximum")}</span>
                        <span className="tabular-nums">{money(maximum)}</span>
                      </Button>
                    )}
                </div>
              )}
              {creditPlayer && availableCredit < minimum && (
                <p className="font-medium text-destructive">
                  {t(
                    "Available credit is below the table minimum. Repay credit or ask a manager to review the limit.",
                  )}
                </p>
              )}
              {creditPlayer && amount > availableCredit && (
                <p className="font-medium text-destructive">
                  {t("This amount exceeds available credit.")}
                </p>
              )}
            </div>
          )}
          {(type === "Rake" || type === "Tips") && (
            <div className="space-y-1 rounded-lg border bg-muted/40 p-3 text-sm">
              <p className="font-medium">
                {t(type === "Rake" ? "Rake guidance" : "Tips policy")}
              </p>
              {type === "Rake" ? (
                <p>
                  {settings.rakePercent}% · {t("Cap")}:{" "}
                  {settings.rakeCap ? money(settings.rakeCap) : t("No cap")}
                </p>
              ) : (
                <p className="whitespace-pre-wrap">
                  {settings.tipsPolicy || t("No tips policy has been added.")}
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                {t(
                  "Rake and tips are entered manually. No amounts are deducted automatically.",
                )}
              </p>
            </div>
          )}
          {cashMovement ? (
            noteField
          ) : (
            <Collapsible
              open={noteOpen}
              onOpenChange={setNoteOpen}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2"
            >
              <CollapsibleTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  className="h-11 w-full justify-between px-0 text-muted-foreground"
                >
                  {t(val("note").trim() ? "Edit note" : "Add note")}
                  <ChevronDown
                    aria-hidden="true"
                    className={noteOpen ? "rotate-180" : undefined}
                  />
                </Button>
              </CollapsibleTrigger>
              {sessionEntry && !changingType && (
                <Button
                  type="button"
                  variant="ghost"
                  className="h-11 px-2 text-xs text-muted-foreground"
                  onClick={() => setChangingType(true)}
                >
                  {t("Change type")}
                </Button>
              )}
              <CollapsibleContent className="col-span-2 pt-2">
                {noteField}
              </CollapsibleContent>
            </Collapsible>
          )}
        </FormSection>
        <div className="min-w-0 space-y-2">
          {(type === "Cash-out"
            ? validCashOutAmount
            : type !== "Buy-in" || validBuyInAmount) && (
            <EntryImpact
              request={{ type, amount, playerId: val("player") || undefined }}
            />
          )}
          <p className="text-xs text-muted-foreground">
            {t("Balances change only after independent approval.")}
          </p>
        </div>
        <FormActions
          disabled={
            !!disabledReason ||
            (type === "Buy-in" && !validBuyInAmount) ||
            (type === "Cash-out" && !validCashOutAmount)
          }
          summary={
            type === "Cash-out" ? (
              validCashOutAmount ? (
                <CashOutSummary
                  request={{
                    type,
                    amount,
                    playerId: val("player") || undefined,
                  }}
                  showPlayer
                />
              ) : (
                <div className="min-w-0 space-y-1" aria-live="polite">
                  {selectedPlayer && (
                    <p className="truncate text-xs text-muted-foreground">
                      {displayName(selectedPlayer.name)}
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    {t("Enter a valid chips amount.")}
                  </p>
                </div>
              )
            ) : type === "Buy-in" && selectedPlayer ? (
              <div
                className="min-w-0 space-y-1"
                aria-live="polite"
                aria-atomic="true"
              >
                <p className="truncate text-xs text-muted-foreground">
                  {displayName(selectedPlayer.name)}
                </p>
                {validBuyInAmount ? (
                  <dl>
                    <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                      <dt className="text-xs text-muted-foreground">
                        {t(creditPlayer ? "Credit requested" : "Cash received")}
                      </dt>
                      <dd className="whitespace-nowrap text-base font-semibold tabular-nums">
                        {money(amount)}
                      </dd>
                    </div>
                  </dl>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {t("Enter a valid buy-in amount.")}
                  </p>
                )}
              </div>
            ) : undefined
          }
        >
          Request approval
        </FormActions>
      </ActionForm>
    </Modal>
  );
}
function MoveDialog({
  initial,
}: {
  initial: Extract<Operation, { kind: "move" }>;
}) {
  const s = usePokerManagementContext(),
    t = useText();
  const player = s.players.find((p) => p.id === initial.playerId);
  const { value: val, set } = useFields({
    player: initial.playerId ?? "",
    destination: initial.tableId ?? player?.tableId ?? "",
    seat: initial.seat ? String(initial.seat) : "",
  });
  const operator = s.user?.role !== "DEALER";
  const selectedPlayer = s.activePlayers.find((p) => p.id === val("player"));
  const currentTable = s.tables.find(
    (table) => table.id === selectedPlayer?.tableId,
  );
  const destination = s.tables.find((table) => table.id === val("destination"));
  const destinationRules = destination
    ? effectiveTableRules(s.store, destination)
    : undefined;
  const blockedReason = val("player")
    ? (playerMoveBlockedReason(s.store, val("player")) ??
      (val("destination") && val("seat")
        ? seatMoveBlockedReason(s.store, val("player"), {
            tableId: val("destination"),
            seat: Number(val("seat")),
          })
        : null))
    : null;
  const moveDisabled = s.locked || !operator || !!blockedReason;
  return (
    <Modal
      open
      onOpenChange={() => s.closeOperation()}
      title="Move player"
      description="Review the player and destination before moving. Pending transactions must be resolved first."
      fallbackFocus={() =>
        document.querySelector<HTMLElement>(
          `[data-player-seat="${CSS.escape(val("player"))}"]`,
        ) ?? document.querySelector<HTMLElement>("[data-table-move-trigger]")
      }
    >
      <ActionForm
        disabled={s.locked || !operator}
        onSubmit={() => {
          if (blockedReason) throw new Error(blockedReason);
          return s.submit({
            kind: "MOVE",
            playerId: val("player"),
            tableId: val("destination"),
            seat: Number(val("seat")),
          });
        }}
        onSuccess={() => s.closeOperation()}
      >
        {blockedReason && (
          <Alert>
            <AlertDescription>{t(blockedReason)}</AlertDescription>
          </Alert>
        )}
        <FormSection title="Player details">
          <Field label="Player">
            <SearchSelect
              required
              value={val("player")}
              onValueChange={(v) => {
                set("player", v);
                set("seat", "");
              }}
              options={[
                { value: "", label: "Select player" },
                ...s.activePlayers.map((p) => ({
                  value: p.id,
                  label: displayName(p.name) + " · " + p.phone,
                  searchTerms: [p.name],
                  phoneNumbers: [p.phone],
                })),
              ]}
            />
          </Field>
          {selectedPlayer && (
            <p className="rounded-lg bg-muted/40 p-3 text-sm">
              <span className="text-muted-foreground">
                {t("Current seat")}:{" "}
              </span>
              {displayName(currentTable?.name ?? t("No active seat"))} ·{" "}
              {t("Seat")} {selectedPlayer.seat}
            </p>
          )}
        </FormSection>
        <FormSection title="Seat assignment">
          <FormGrid>
            <Field label="Destination table">
              <Select
                required
                value={val("destination")}
                onValueChange={(v) => {
                  set("destination", v);
                  set("seat", "");
                }}
                options={[
                  { value: "", label: "Select table" },
                  ...s.tables
                    .filter((t) => t.status === "OPEN")
                    .map((table) => {
                      const rules = effectiveTableRules(s.store, table);
                      return {
                        value: table.id,
                        label:
                          displayName(table.name) +
                          " · " +
                          money(rules.smallBlind) +
                          " / " +
                          money(rules.bigBlind),
                      };
                    }),
                ]}
              />
            </Field>
            <Field label="Seat" hint="Only available seats are listed.">
              <Select
                required
                disabled={!val("destination")}
                value={val("seat")}
                onValueChange={(v) => set("seat", v)}
                options={[
                  { value: "", label: "Select seat" },
                  ...Array.from({ length: 9 }, (_, i) => i + 1)
                    .filter(
                      (seat) =>
                        !s.activePlayers.some(
                          (p) =>
                            p.tableId === val("destination") && p.seat === seat,
                        ),
                    )
                    .map((seat) => ({
                      value: String(seat),
                      label: String(seat),
                    })),
                ]}
              />
            </Field>
          </FormGrid>
          {destinationRules && (
            <div
              className="space-y-3 rounded-lg border bg-muted/30 p-3"
              role="region"
              aria-label={t("Destination table rules")}
            >
              <dl className="grid min-w-0 gap-3 text-sm sm:grid-cols-3">
                <div className="min-w-0 space-y-1">
                  <dt className="text-xs text-muted-foreground">
                    {t("Stakes")}
                  </dt>
                  <dd className="break-words font-medium tabular-nums">
                    {money(destinationRules.smallBlind)} /{" "}
                    {money(destinationRules.bigBlind)}
                  </dd>
                </div>
                <div className="min-w-0 space-y-1">
                  <dt className="text-xs text-muted-foreground">
                    {t("Buy-in range")}
                  </dt>
                  <dd className="break-words font-medium tabular-nums">
                    {money(destinationRules.minBuyIn)} -{" "}
                    {money(destinationRules.maxBuyIn)}
                  </dd>
                </div>
                <div className="min-w-0 space-y-1">
                  <dt className="text-xs text-muted-foreground">
                    {t("Buy-in increment")}
                  </dt>
                  <dd className="break-words font-medium tabular-nums">
                    {destinationRules.buyInStep
                      ? money(destinationRules.buyInStep)
                      : t("Any amount")}
                  </dd>
                </div>
              </dl>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {t(
                  "New buy-ins use the destination table's rules. Existing balances stay unchanged.",
                )}
              </p>
            </div>
          )}
        </FormSection>
        <FormActions
          disabled={moveDisabled}
          summary={
            selectedPlayer && destination && val("seat") ? (
              <div className="min-w-0 space-y-1 text-sm">
                <p className="break-words font-medium">
                  {displayName(selectedPlayer.name)}
                </p>
                <p className="break-words text-xs leading-relaxed text-muted-foreground">
                  <span className="sr-only">{t("Current seat")}: </span>
                  {displayName(
                    currentTable?.name ?? t("No active seat"),
                  )} · {t("Seat")} {selectedPlayer.seat}
                  <span aria-hidden="true"> → </span>
                  <span className="sr-only">{t("Destination seat")}: </span>
                  {displayName(destination.name)} · {t("Seat")} {val("seat")}
                </p>
              </div>
            ) : undefined
          }
        >
          Move player
        </FormActions>
      </ActionForm>
    </Modal>
  );
}

function SwapDialog({
  initial,
}: {
  initial: Extract<Operation, { kind: "swap" }>;
}) {
  const s = usePokerManagementContext(),
    t = useText();
  const [{ first, second }] = useState(() => ({
    first: { ...initial.first },
    second: { ...initial.second },
  }));
  const operator = !!s.user && s.user.role !== "DEALER";
  const blockedReason = seatSwapBlockedReason(s.store, first, second);
  const swapDisabled = s.locked || !operator || !!blockedReason;
  return (
    <Modal
      open
      onOpenChange={() => s.closeOperation()}
      title="Swap players"
      description="Review both players and their destination seats. Their seats will be exchanged in one step."
      fallbackFocus={() =>
        document.querySelector<HTMLElement>(
          `[data-player-seat="${CSS.escape(first.playerId)}"]`,
        ) ?? document.querySelector<HTMLElement>("[data-table-move-trigger]")
      }
    >
      <ActionForm
        disabled={s.locked || !operator}
        onSubmit={() => {
          const reason = seatSwapBlockedReason(s.store, first, second);
          if (reason) throw new Error(reason);
          return s.submit({ kind: "SWAP_SEATS", first, second });
        }}
        onSuccess={() => s.closeOperation()}
      >
        {blockedReason && (
          <Alert>
            <AlertDescription>{t(blockedReason)}</AlertDescription>
          </Alert>
        )}
        <FormSection title="Seat assignment">
          <div className="space-y-3">
            {[
              { player: first, destination: second },
              { player: second, destination: first },
            ].map(({ player, destination }) => {
              const profile = s.store.profiles.find(
                (profile) => profile.id === player.playerId,
              );
              const currentTable = s.tables.find(
                (table) => table.id === player.tableId,
              );
              const destinationTable = s.tables.find(
                (table) => table.id === destination.tableId,
              );
              const rules = destinationTable
                ? effectiveTableRules(s.store, destinationTable)
                : undefined;
              const name = profile
                ? displayName(profile.name)
                : t("Player not found.");
              return (
                <div
                  key={player.playerId}
                  className="min-w-0 space-y-3 rounded-lg border bg-muted/20 p-3"
                >
                  <h3 className="text-sm font-semibold leading-relaxed [overflow-wrap:anywhere]">
                    {name}
                  </h3>
                  <dl className="grid min-w-0 grid-cols-2 gap-3 text-sm">
                    <div className="min-w-0 space-y-1">
                      <dt className="text-xs text-muted-foreground">
                        {t("Current seat")}
                      </dt>
                      <dd className="leading-relaxed [overflow-wrap:anywhere]">
                        {displayName(currentTable?.name ?? t("No active seat"))}
                        <span className="block font-medium">
                          {t("Seat")} {player.seat}
                        </span>
                      </dd>
                    </div>
                    <div className="min-w-0 space-y-1">
                      <dt className="text-xs text-muted-foreground">
                        {t("Destination seat")}
                      </dt>
                      <dd className="leading-relaxed [overflow-wrap:anywhere]">
                        {displayName(
                          destinationTable?.name ?? t("No active seat"),
                        )}
                        <span className="block font-medium">
                          {t("Seat")} {destination.seat}
                        </span>
                      </dd>
                    </div>
                  </dl>
                  {rules && (
                    <div
                      className="border-t pt-3"
                      role="region"
                      aria-label={t("Destination table rules") + " · " + name}
                    >
                      <dl className="grid min-w-0 grid-cols-2 gap-3 text-sm">
                        <div className="min-w-0 space-y-1">
                          <dt className="text-xs text-muted-foreground">
                            {t("Stakes")}
                          </dt>
                          <dd className="break-words font-medium tabular-nums">
                            {money(rules.smallBlind)} / {money(rules.bigBlind)}
                          </dd>
                        </div>
                        <div className="min-w-0 space-y-1">
                          <dt className="text-xs text-muted-foreground">
                            {t("Buy-in range")}
                          </dt>
                          <dd className="break-words font-medium tabular-nums">
                            {money(rules.minBuyIn)} - {money(rules.maxBuyIn)}
                          </dd>
                        </div>
                      </dl>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {t(
              "Existing balances stay with each player. New buy-ins follow their destination table's rules.",
            )}
          </p>
        </FormSection>
        <FormActions disabled={swapDisabled}>Swap players</FormActions>
      </ActionForm>
    </Modal>
  );
}
