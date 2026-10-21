"use client";
import { useState } from "react";
import { displayName } from "@/lib/display-name";
import { usePokerManagementContext } from "../PokerManagementProvider";
import { PlayerActions } from "./player-actions";
import {
  ActionForm,
  Badge,
  Field,
  Modal,
  FormActions,
  FormGrid,
  FormSection,
  MoneyInput,
  EmptyState,
  Pager,
  Select,
  useText,
  useTimestamp,
} from "./shared";
import { Button } from "@/components/ui/button";
import { RecordList } from "./record-list";
import { ListToolbar } from "./list-toolbar";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Field as UiField, FieldLabel } from "@/components/ui/field";
import type { PlayerTag } from "@/domain/model";
import { money, parseMoney } from "../utils";
export function PlayerDetails({ playerId }: { playerId: string }) {
  const s = usePokerManagementContext(),
    t = useText();
  const history = s.players.find((p) => p.id === playerId);
  return (
    <Modal
      open={!!history}
      trackChanges={false}
      onOpenChange={() => s.closeOperation()}
      title="Player details"
      description={
        history ? displayName(history.name) + " · " + history.phone : "Player"
      }
    >
      {history && (
        <>
          <div className="flex flex-wrap gap-2">
            <Badge>{history.status}</Badge>
            <Badge>{history.type}</Badge>
            {history.tags.map((tag) => (
              <Badge key={tag}>{tag}</Badge>
            ))}
          </div>
          <p className="text-sm">
            {displayName(
              s.tables.find((table) => table.id === history.tableId)?.name ??
                t("No active seat"),
            )}
            {history.seat ? " · " + t("Seat") + " " + history.seat : ""}
          </p>
          <PlayerActions player={history} details />
          <p className="text-sm font-medium">
            {t("Current business day")}: {s.day?.date ?? "—"}
          </p>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <p>
              {t("Buy-in")}: {money(history.buyIn)}
            </p>
            <p>
              {t("Cash-out")}: {money(history.cashOut)}
            </p>
            <p>
              {t("P/L")}:{" "}
              {history.status === "ACTIVE"
                ? t("Unsettled")
                : money(history.cashOut - history.buyIn)}
            </p>
            <p>
              {t("Outstanding credit")}: {money(history.creditUsed)}
            </p>
          </div>
          <SessionHistory key={history.id} playerId={history.id} />
        </>
      )}
    </Modal>
  );
}
function SessionHistory({ playerId }: { playerId: string }) {
  const s = usePokerManagementContext(),
    t = useText(),
    timestamp = useTimestamp();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [requestedPage, setPage] = useState(0);
  const sessions = s.store.sessions
    .filter((session) => session.playerId === playerId)
    .toReversed();
  const filtered = sessions.filter((session) => {
    const date =
      s.store.days.find((day) => day.id === session.dayId)?.date ?? "";
    const table = displayName(
      s.tables.find((table) => table.id === session.tableId)?.name ?? "",
    );
    return (
      (!status || session.status === status) &&
      [date, table].some((value) =>
        value.toLowerCase().includes(search.trim().toLowerCase()),
      )
    );
  });
  const page = Math.min(
    requestedPage,
    Math.max(0, Math.ceil(filtered.length / 20) - 1),
  );
  function clearFilters() {
    setSearch("");
    setStatus("");
    setPage(0);
  }
  return (
    <section className="min-w-0 space-y-4" aria-label={t("Session history")}>
      <h3 className="text-sm font-semibold">{t("Session history")}</h3>
      {sessions.length > 0 && (
        <ListToolbar
          search={search}
          searchLabel="Search session history"
          searchPlaceholder="Search by date or table"
          onSearchChange={(value) => {
            setSearch(value);
            setPage(0);
          }}
          activeFilters={
            status
              ? [
                  {
                    key: "status",
                    label: t("Status") + ": " + t(status),
                    onRemove: () => {
                      setStatus("");
                      setPage(0);
                    },
                  },
                ]
              : []
          }
          resultCount={filtered.length}
          onClear={clearFilters}
        >
          <Field label="Status">
            <Select
              value={status}
              onValueChange={(value) => {
                setStatus(value);
                setPage(0);
              }}
              options={[
                { value: "", label: "All statuses" },
                { value: "ACTIVE", label: "ACTIVE" },
                { value: "OUT", label: "OUT" },
              ]}
            />
          </Field>
        </ListToolbar>
      )}
      {!sessions.length ? (
        <EmptyState title="No session history yet" />
      ) : !filtered.length ? (
        <EmptyState title="No matching sessions">
          <Button variant="outline" onClick={clearFilters}>
            {t("Clear all")}
          </Button>
        </EmptyState>
      ) : (
        <RecordList
          label="Session history"
          rows={filtered.slice(page * 20, page * 20 + 20)}
          rowKey={(session) => session.id}
          columns={[
            {
              label: "Business day",
              render: (session) => (
                <>
                  {s.store.days.find((day) => day.id === session.dayId)?.date ??
                    "—"}
                  <p className="text-xs text-muted-foreground">
                    {timestamp(
                      session.sessionStart,
                      s.snapshot!.branch.timezone,
                    )}
                  </p>
                </>
              ),
            },
            {
              label: "Table / seat",
              render: (session) =>
                displayName(
                  s.tables.find((table) => table.id === session.tableId)
                    ?.name ?? "—",
                ) +
                " / " +
                session.seat,
            },
            {
              label: "Status",
              render: (session) => (
                <Badge tone={session.status === "ACTIVE" ? "green" : "neutral"}>
                  {session.status}
                </Badge>
              ),
            },
          ]}
        />
      )}
      <Pager
        label="Session history"
        page={page}
        total={filtered.length}
        setPage={setPage}
      />
    </section>
  );
}
export function EditPlayer({ playerId }: { playerId: string }) {
  const s = usePokerManagementContext(),
    t = useText();
  const edit = s.players.find((p) => p.id === playerId);
  const [values, setValues] = useState<Record<string, string>>({
    editName: edit?.name ?? "",
    editTags: edit?.tags.join(",") ?? "",
    editCredit: String((edit?.creditLimit ?? 0) / 100),
    reason: "",
  });
  const value = (key: string) => values[key] ?? "",
    set = (key: string, value: string) =>
      setValues((old) => ({ ...old, [key]: value }));
  const tags = value("editTags").split(",").filter(Boolean) as PlayerTag[];
  return (
    <Modal
      open={!!edit}
      onOpenChange={() => s.closeOperation()}
      title="Edit player profile"
      description={
        edit ? displayName(edit.name) + " · " + edit.phone : "Player"
      }
    >
      {edit && (
        <ActionForm
          onSubmit={() =>
            s.submit({
              kind: "UPDATE_PROFILE",
              playerId: edit.id,
              name: value("editName"),
              tags,
              creditLimit:
                edit.type === "CASH"
                  ? 0
                  : parseMoney(value("editCredit"), true),
              reason: value("reason"),
            })
          }
          onSuccess={() => s.closeOperation()}
        >
          <FormSection title="Profile details">
            <Field label="Player name">
              <Input
                required
                maxLength={200}
                autoComplete="name"
                value={value("editName")}
                onChange={(e) => set("editName", e.target.value)}
              />
            </Field>
            <FormGrid>
              <div className="space-y-1 text-sm">
                <p className="text-muted-foreground">{t("Phone")}</p>
                <p className="break-words">{edit.phone}</p>
              </div>
              <div className="space-y-1 text-sm">
                <p className="text-muted-foreground">{t("Player type")}</p>
                <Badge>{edit.type}</Badge>
              </div>
            </FormGrid>
          </FormSection>
          <FormSection title="Account details">
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">
                {t("Tags")}{" "}
                <span className="font-normal text-muted-foreground">
                  ({t("Optional")})
                </span>
              </legend>
              <div className="grid gap-2 sm:grid-cols-3">
                {(["VIP", "Risk", "Banned"] as PlayerTag[]).map((tag) => (
                  <UiField
                    key={tag}
                    orientation="horizontal"
                    className="relative min-w-0 gap-3 rounded-lg border px-3 py-3 has-data-[state=checked]:border-primary/50 has-data-[state=checked]:bg-primary/5"
                  >
                    <Checkbox
                      id={"tag-" + tag}
                      checked={tags.includes(tag)}
                      onCheckedChange={(checked) =>
                        set(
                          "editTags",
                          (checked
                            ? [...tags, tag]
                            : tags.filter((v) => v !== tag)
                          ).join(","),
                        )
                      }
                    />
                    <FieldLabel
                      htmlFor={"tag-" + tag}
                      className="min-h-5 flex-1 cursor-pointer after:absolute after:inset-0"
                    >
                      {t(tag)}
                    </FieldLabel>
                  </UiField>
                ))}
              </div>
            </fieldset>
            {edit.type === "CREDIT" && (
              <Field label="Credit limit (RM)">
                <MoneyInput
                  required
                  value={value("editCredit")}
                  onChange={(e) => set("editCredit", e.target.value)}
                />
              </Field>
            )}
            <p className="text-sm text-muted-foreground">
              {t("Outstanding credit")}: {money(edit.creditUsed)}
            </p>
          </FormSection>
          <FormSection title="Audit details">
            <Field
              label="Reason for change"
              hint="Explain the change for the audit history."
            >
              <Textarea
                required
                minLength={3}
                maxLength={500}
                rows={3}
                value={value("reason")}
                onChange={(e) => set("reason", e.target.value)}
              />
            </Field>
          </FormSection>
          <FormActions>Save profile</FormActions>
        </ActionForm>
      )}
    </Modal>
  );
}
