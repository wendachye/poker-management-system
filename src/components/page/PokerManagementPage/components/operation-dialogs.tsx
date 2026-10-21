"use client";
import { useState } from "react";
import { displayName } from "@/lib/display-name";
import type { EntryType, PlayerType, PlayerTag } from "@/domain/model";
import { effectiveTableRules, venueSettings } from "@/domain/settings";
import { MAX_MONEY } from "@/domain/money";
import type { Operation } from "../usePokerManagementState";
import { usePokerManagementContext } from "../PokerManagementProvider";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  ActionForm,
  Badge,
  Field,
  Select,
  SearchSelect,
  FormActions,
  FormGrid,
  FormSection,
  Modal,
  MoneyInput,
  useText,
} from "./shared";
import { money, parseMoney } from "../utils";
import { EntryImpact } from "./entry-impact";
import { PlayerDetails, EditPlayer } from "./player-details";
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
  const { value, set } = useFields({
    existing: initial.playerId ?? "",
    table: initial.tableId ?? "",
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
  const creditBlocked =
    !settings.creditEnabled &&
    (returning
      ? selected?.type === "CREDIT"
      : value("type", "CASH") === "CREDIT");
  const available = s.tables.filter((table) => table.status === "OPEN");
  return (
    <Modal
      open
      onOpenChange={() => s.closeOperation()}
      title="Check in player"
      description="Choose a player and an available seat to start their visit."
    >
      <ActionForm
        disabled={s.locked || !operator}
        validationKey={returning ? "returning" : "new:" + value("type", "CASH")}
        onSubmit={() => {
          if (creditBlocked)
            throw new Error("Credit accounts are disabled in venue settings.");
          return s.submit({
            kind: "CHECK_IN",
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
        onSuccess={() => s.closeOperation()}
      >
        <FormSection title="Player details">
          <Tabs
            value={returning ? "returning" : "new"}
            onValueChange={(v) => set("mode", v)}
          >
            <TabsList className="w-full">
              <TabsTrigger value="returning">
                {t("Returning player")}
              </TabsTrigger>
              <TabsTrigger value="new">{t("New player")}</TabsTrigger>
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
                          p.status !== "ACTIVE" && !p.tags.includes("Banned"),
                      )
                      .map((p) => ({
                        value: p.id,
                        label: displayName(p.name) + " · " + p.phone,
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
              <FormGrid>
                <Field label="Player type">
                  <Select
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
              </FormGrid>
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
        <FormSection title="Seat assignment">
          <FormGrid>
            <Field label="Table">
              <Select
                required
                value={value("table")}
                onValueChange={(v) => {
                  set("table", v);
                  set("seat", "");
                }}
                options={[
                  { value: "", label: "Select table" },
                  ...available.map((table) => {
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
                disabled={!value("table")}
                value={value("seat")}
                onValueChange={(v) => set("seat", v)}
                options={[
                  { value: "", label: "Select seat" },
                  ...Array.from({ length: 9 }, (_, i) => i + 1)
                    .filter(
                      (seat) =>
                        !s.activePlayers.some(
                          (p) =>
                            p.tableId === value("table") && p.seat === seat,
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
        </FormSection>
        <FormActions disabled={creditBlocked}>Check in</FormActions>
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
  const maximum =
    rules.buyInStep > 0
      ? Math.floor(rules.maxBuyIn / rules.buyInStep) * rules.buyInStep
      : rules.maxBuyIn;
  let amount = 0;
  try {
    amount = parseMoney(val("amount", "0"), true);
  } catch {}

  return (
    <Modal
      open
      onOpenChange={() => s.closeOperation()}
      title={type}
      description="Review the details before sending this request for independent approval."
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
          s.closeOperation();
        }}
      >
        <FormSection title="Request details">
          <Field label="Transaction type">
            <Select
              required
              value={type}
              onValueChange={(v) => {
                set("type", v);
                set("player", "");
                set("table", "");
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
                .map((v) => ({ value: v, label: v, disabled: !enabled(v) }))}
            />
          </Field>
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
          <Field label="Player" optional={!sessionEntry && !repayment}>
            <SearchSelect
              value={val("player")}
              required={sessionEntry || repayment}
              onValueChange={(v) => set("player", v)}
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
                  disabled:
                    type === "Buy-in" &&
                    p.type === "CREDIT" &&
                    !settings.creditEnabled,
                })),
              ]}
            />
          </Field>
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
          {type === "Buy-in" && selectedPlayer && selectedTable && (
            <div className="space-y-2 rounded-lg border bg-muted/40 p-3 text-sm">
              <p className="font-medium">{displayName(selectedTable.name)}</p>
              <p>
                {t("Table stakes")}: {money(rules.smallBlind)} /{" "}
                {money(rules.bigBlind)}
              </p>
              <p>
                {t("Minimum buy-in")}: {money(rules.minBuyIn)} ·{" "}
                {t("Maximum buy-in")}: {money(rules.maxBuyIn)}
              </p>
              <p>
                {t("Buy-in increment")}:{" "}
                {rules.buyInStep > 0
                  ? money(rules.buyInStep)
                  : t("Any amount within the table limits.")}
              </p>
              {!disabledReason && (
                <div className="flex flex-wrap gap-2">
                  {rules.minBuyIn > 0 && minimum <= rules.maxBuyIn && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      data-mark-dirty="true"
                      onClick={() => set("amount", (minimum / 100).toFixed(2))}
                    >
                      {t("Use minimum")} · {money(minimum)}
                    </Button>
                  )}
                  {rules.maxBuyIn < MAX_MONEY &&
                    maximum > 0 &&
                    maximum !== minimum && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        data-mark-dirty="true"
                        onClick={() =>
                          set("amount", (maximum / 100).toFixed(2))
                        }
                      >
                        {t("Use maximum")} · {money(maximum)}
                      </Button>
                    )}
                </div>
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
          <Field
            label="Amount (RM)"
            hint={
              type === "Cash-out"
                ? "Zero cash-out closes the session without a cash payment."
                : type === "Buy-in"
                  ? "Use the limits and increment shown for the selected table."
                  : undefined
            }
          >
            <MoneyInput
              required
              value={val("amount")}
              onChange={(e) => set("amount", e.target.value)}
            />
          </Field>
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
        </FormSection>
        <FormSection title="Review request">
          <Alert>
            <AlertDescription>
              <p className="font-medium">
                {t(type)} · {money(amount)}
              </p>
              <p>
                {t(
                  "No cash or credit balance changes until this request is approved.",
                )}
              </p>
            </AlertDescription>
          </Alert>
          <EntryImpact
            request={{ type, amount, playerId: val("player") || undefined }}
          />
        </FormSection>
        <FormActions disabled={!!disabledReason}>Request approval</FormActions>
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
    seat: "",
  });
  const operator = s.user?.role !== "DEALER";
  const selectedPlayer = s.activePlayers.find((p) => p.id === val("player"));
  const currentTable = s.tables.find(
    (table) => table.id === selectedPlayer?.tableId,
  );
  return (
    <Modal
      open
      onOpenChange={() => s.closeOperation()}
      title="Move player"
      description="Select an available seat. Pending transactions must be resolved first."
    >
      <ActionForm
        disabled={s.locked || !operator}
        onSubmit={() =>
          s.submit({
            kind: "MOVE",
            playerId: val("player"),
            tableId: val("destination"),
            seat: Number(val("seat")),
          })
        }
        onSuccess={() => s.closeOperation()}
      >
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
                            p.tableId === val("destination") &&
                            p.seat === seat &&
                            p.id !== val("player"),
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
        </FormSection>
        <FormActions>Move player</FormActions>
      </ActionForm>
    </Modal>
  );
}
