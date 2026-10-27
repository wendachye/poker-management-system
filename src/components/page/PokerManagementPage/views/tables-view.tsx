"use client";
import { useState } from "react";
import { Plus, ArrowRightLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import type { PokerTable } from "@/domain/model";
import { effectiveTableRules } from "@/domain/settings";
import { displayName } from "@/lib/display-name";
import { matchesListSearch } from "@/lib/list-search";
import { usePokerManagementContext } from "../PokerManagementProvider";
import { money, parseMoney } from "../utils";
import { ListToolbar } from "../components/list-toolbar";
import { VenueRulesButton } from "../components/venue-rules";
import { TableFloorCard } from "../components/table-floor-card";
import { TableSeatDragProvider } from "../components/table-seat-drag";
import {
  ActionForm,
  Field,
  Pager,
  Select,
  Modal,
  FormActions,
  FormGrid,
  FormSection,
  EmptyState,
  DayNotice,
  useText,
  MoneyInput,
} from "../components/shared";
export function TablesView() {
  const s = usePokerManagementContext(),
    t = useText();
  const val = (key: string, fallback = "") => s.draft("table." + key, fallback),
    set = (key: string, v: string) => s.setDraft("table." + key, v);
  const manager = ["MANAGER", "ADMIN"].includes(s.user!.role),
    operator = s.user?.role !== "DEALER";
  const [settings, setSettings] = useState(false);
  function edit(table?: PokerTable) {
    set("id", table?.id ?? "");
    set("name", table?.name ?? "");
    set("dealer", table?.dealer ?? "");
    set("status", table?.status ?? "OPEN");
    for (const key of [
      "smallBlind",
      "bigBlind",
      "minBuyIn",
      "maxBuyIn",
      "buyInStep",
    ] as const)
      set(key, table?.[key] === undefined ? "" : String(table[key] / 100));
    s.setError("");
    setSettings(true);
  }
  const occupied = s.activePlayers.some((p) => p.tableId === val("id"));
  const pending = s.pendingApprovals.some((p) => p.tableId === val("id"));
  const visibleTables = s.tables.filter((table) => {
    const full =
      s.activePlayers.filter((p) => p.tableId === table.id).length >= 9;
    const filter = val("filter", "ALL");
    return (
      matchesListSearch(val("search"), [
        table.name,
        displayName(table.name),
        table.dealer,
        displayName(table.dealer),
      ]) &&
      (filter === "ALL" ||
        (filter === "FULL"
          ? table.status === "OPEN" && full
          : filter === "AVAILABLE"
            ? table.status === "OPEN" && !full
            : table.status === filter))
    );
  });
  const page = Math.max(
    0,
    Math.min(
      Number(val("page", "0")) || 0,
      Math.max(0, Math.ceil(visibleTables.length / 20) - 1),
    ),
  );
  const clearFilters = () => {
    set("search", "");
    set("filter", "ALL");
    set("page", "0");
  };
  return (
    <div className="space-y-5">
      <DayNotice />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {s.tables.filter((t) => t.status === "OPEN").length}{" "}
          {t("open tables")} · {s.activePlayers.length} {t("active players")}
        </p>
        <div className="flex flex-wrap gap-2">
          <VenueRulesButton />
          {operator && !s.locked && s.activePlayers.length > 0 && (
            <Button
              variant="outline"
              data-table-move-trigger
              disabled={s.locked || !s.activePlayers.length}
              onClick={() => {
                s.setError("");
                s.startOperation({ kind: "move" });
              }}
            >
              <ArrowRightLeft />
              {t("Move player")}
            </Button>
          )}
          {manager && (
            <Button onClick={() => edit()}>
              <Plus />
              {t("Add table")}
            </Button>
          )}
        </div>
      </div>
      {!s.tables.length && (
        <EmptyState
          title="No tables yet"
          description="Add and open a table before checking in players."
        />
      )}
      {!!s.tables.length && (
        <ListToolbar
          search={val("search")}
          searchLabel="Search tables"
          searchPlaceholder="Table name or dealer"
          onSearchChange={(v) => {
            set("search", v);
            set("page", "0");
          }}
          activeFilters={
            val("filter", "ALL") === "ALL"
              ? []
              : [
                  {
                    key: "availability",
                    label:
                      t("Availability") +
                      ": " +
                      t(
                        val("filter") === "AVAILABLE"
                          ? "Available seats"
                          : val("filter") === "FULL"
                            ? "Full tables"
                            : "Closed tables",
                      ),
                    onRemove: () => {
                      set("filter", "ALL");
                      set("page", "0");
                    },
                    hideChip: true,
                  },
                ]
          }
          onClear={clearFilters}
          resultCount={visibleTables.length}
          primaryFilters={
            <Field label="Availability">
              <Select
                value={val("filter", "ALL")}
                onValueChange={(v) => {
                  set("filter", v);
                  set("page", "0");
                }}
                options={[
                  { value: "ALL", label: "All tables" },
                  { value: "AVAILABLE", label: "Available seats" },
                  { value: "FULL", label: "Full tables" },
                  { value: "CLOSED", label: "Closed tables" },
                ]}
              />
            </Field>
          }
        />
      )}
      {!!s.tables.length && !visibleTables.length && (
        <EmptyState
          title="No matching tables"
          description="Try another search or clear the filters."
        >
          <Button variant="outline" onClick={clearFilters}>
            {t("Clear all")}
          </Button>
        </EmptyState>
      )}
      {operator &&
        !s.locked &&
        visibleTables.some(
          (table) =>
            table.status === "OPEN" &&
            s.activePlayers.some((player) => player.tableId === table.id),
        ) && (
          <p className="text-xs leading-relaxed text-muted-foreground">
            {t(
              "Drag to an empty seat to move, or onto a player to swap. On a phone, press and hold.",
            )}
          </p>
        )}
      <TableSeatDragProvider>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,560px),1fr))] items-start gap-6">
          {visibleTables.slice(page * 20, page * 20 + 20).map((table) => (
            <TableFloorCard
              key={table.id}
              table={table}
              players={s.activePlayers.filter(
                (player) => player.tableId === table.id,
              )}
              rules={effectiveTableRules(s.store, table)}
              busy={s.busy}
              canCheckIn={operator && !s.locked && table.status === "OPEN"}
              onEdit={manager ? () => edit(table) : undefined}
              onSeatSelect={(seat, player) => {
                s.startOperation(
                  player
                    ? { kind: "player", playerId: player.id }
                    : { kind: "check-in", tableId: table.id, seat },
                );
              }}
            />
          ))}
        </div>
      </TableSeatDragProvider>
      <Pager
        page={page}
        total={visibleTables.length}
        setPage={(value) => set("page", String(value))}
        label="Table pagination"
      />
      <Modal
        open={settings}
        onOpenChange={setSettings}
        title={val("id") ? "Edit table" : "Add table"}
        description="Configure the table, stakes, buy-in limits, dealer, and availability."
      >
        <ActionForm
          disabled={!manager}
          onSubmit={() =>
            s.submit({
              kind: "TABLE",
              tableId: val("id") || undefined,
              name: val("name"),
              dealer: val("dealer"),
              status: val("status", "OPEN") as "OPEN" | "CLOSED",
              ...Object.fromEntries(
                [
                  "smallBlind",
                  "bigBlind",
                  "minBuyIn",
                  "maxBuyIn",
                  "buyInStep",
                ].map((key) => [
                  key,
                  val(key).trim() ? parseMoney(val(key), true) : null,
                ]),
              ),
            })
          }
          onSuccess={() => setSettings(false)}
        >
          <FormSection
            title="Table details"
            description="Name the table and set its availability. You can assign a dealer later."
          >
            <FormGrid>
              <Field label="Table name">
                <Input
                  required
                  maxLength={200}
                  placeholder={t("For example, Table 1")}
                  value={val("name")}
                  onChange={(e) => set("name", e.target.value)}
                />
              </Field>
              <Field label="Dealer" optional>
                <Input
                  maxLength={100}
                  placeholder={t("Dealer name")}
                  value={val("dealer")}
                  onChange={(e) => set("dealer", e.target.value)}
                />
              </Field>
            </FormGrid>
            <Field
              label="Status"
              hint="Only open tables accept player check-ins."
            >
              <Select
                required
                value={val("status", "OPEN")}
                onValueChange={(v) => set("status", v)}
                options={[
                  { value: "OPEN", label: "Open" },
                  {
                    value: "CLOSED",
                    label: "Closed",
                    disabled: !!val("id") && (occupied || pending),
                  },
                ]}
              />
            </Field>
            {(occupied || pending) && (
              <Alert>
                <AlertDescription>
                  {t(
                    "Move players and resolve pending approvals before closing this table.",
                  )}
                </AlertDescription>
              </Alert>
            )}
          </FormSection>
          <FormSection
            title="Table stakes and buy-ins"
            description="Leave rule fields blank to use the venue defaults. Set both blinds together for custom stakes."
          >
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant={
                  val("smallBlind") === "5" && val("bigBlind") === "10"
                    ? "secondary"
                    : "outline"
                }
                size="sm"
                aria-pressed={
                  val("smallBlind") === "5" && val("bigBlind") === "10"
                }
                data-mark-dirty="true"
                onClick={() => {
                  set("smallBlind", "5");
                  set("bigBlind", "10");
                }}
              >
                RM 5 / RM 10
              </Button>
              <Button
                type="button"
                variant={
                  val("smallBlind") === "10" && val("bigBlind") === "25"
                    ? "secondary"
                    : "outline"
                }
                size="sm"
                aria-pressed={
                  val("smallBlind") === "10" && val("bigBlind") === "25"
                }
                data-mark-dirty="true"
                onClick={() => {
                  set("smallBlind", "10");
                  set("bigBlind", "25");
                }}
              >
                RM 10 / RM 25
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-mark-dirty="true"
                onClick={() => {
                  for (const key of [
                    "smallBlind",
                    "bigBlind",
                    "minBuyIn",
                    "maxBuyIn",
                    "buyInStep",
                  ])
                    set(key, "");
                }}
              >
                {t("Use venue defaults")}
              </Button>
            </div>
            <FormGrid>
              {(
                [
                  ["smallBlind", "Small blind (RM)"],
                  ["bigBlind", "Big blind (RM)"],
                  ["minBuyIn", "Minimum buy-in (RM)"],
                  ["maxBuyIn", "Maximum buy-in (RM)"],
                  ["buyInStep", "Buy-in increment (RM)"],
                ] as const
              ).map(([key, label]) => (
                <Field
                  key={key}
                  label={label}
                  optional
                  hint={
                    t("Venue default") +
                    ": " +
                    money(effectiveTableRules(s.store)[key])
                  }
                >
                  <MoneyInput
                    value={val(key)}
                    placeholder={String(
                      effectiveTableRules(s.store)[key] / 100,
                    )}
                    onChange={(e) => set(key, e.target.value)}
                  />
                </Field>
              ))}
            </FormGrid>
          </FormSection>
          <FormActions>{val("id") ? "Save table" : "Create table"}</FormActions>
        </ActionForm>
      </Modal>
    </div>
  );
}
