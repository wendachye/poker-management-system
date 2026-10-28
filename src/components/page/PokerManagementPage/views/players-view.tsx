"use client";
import { Clock3, Plus } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import { Link } from "@/i18n/navigation";
import { displayName } from "@/lib/display-name";
import { matchesListSearch } from "@/lib/list-search";
import { usePokerManagementContext } from "../PokerManagementProvider";
import type { Player } from "@/domain/model";
import { money } from "../utils";
import {
  Field,
  Pager,
  Select,
  EmptyState,
  DayNotice,
  useText,
} from "../components/shared";

import { PlayerActions } from "../components/player-actions";
import { ListToolbar } from "../components/list-toolbar";
import { RecordTable } from "../components/record-list";
import { QuickFilters } from "../components/quick-filters";
import { ReadStatus, useReadPage } from "../components/use-read-page";

export function PlayersView() {
  const s = usePokerManagementContext(),
    t = useText();
  const operator = s.user?.role !== "DEALER";
  const value = (key: string, fallback = "") =>
    s.draft("player." + key, fallback);
  const set = (key: string, v: string) => s.setDraft("player." + key, v);
  const setCriteria = (key: string, next: string) => {
    set(key, next);
    set("page", "0");
  };
  const clearCriteria = () => {
    ["search", "status", "type", "tag"].forEach((key) => set(key, ""));
    set("page", "0");
  };
  const available = s.tables.filter(
    (table) =>
      table.status === "OPEN" &&
      s.activePlayers.filter((p) => p.tableId === table.id).length < 9,
  );
  const matchingPlayers = s.players.filter(
    (p) =>
      matchesListSearch(
        value("search"),
        [p.name, displayName(p.name), p.phone, p.id],
        [p.phone],
      ) &&
      (!value("type") || p.type === value("type")) &&
      (!value("tag") || p.tags.some((tag) => tag === value("tag"))),
  );
  const localFiltered = matchingPlayers.filter(
    (p) => !value("status") || p.status === value("status"),
  );
  const requestedPage = Math.max(0, Number(value("page", "0")) || 0);
  const remote = useReadPage<Player>({
    resource: "players",
    query: value("search"),
    status: value("status"),
    type: value("type"),
    tag: value("tag"),
    page: requestedPage,
  });
  const filtered = remote.live ? (remote.data?.items ?? []) : localFiltered;
  const total = remote.live ? (remote.data?.total ?? 0) : filtered.length;
  const statusOptions = [
    {
      value: "",
      label: "All players",
      count: remote.live
        ? (remote.data?.counts.ALL ?? 0)
        : matchingPlayers.length,
    },
    {
      value: "ACTIVE",
      label: "ACTIVE",
      count: remote.live
        ? (remote.data?.counts.ACTIVE ?? 0)
        : matchingPlayers.filter((p) => p.status === "ACTIVE").length,
    },
    {
      value: "OUT",
      label: "OUT",
      count: remote.live
        ? (remote.data?.counts.OUT ?? 0)
        : matchingPlayers.filter((p) => p.status === "OUT").length,
    },
  ];
  const page = remote.live
    ? (remote.data?.page ?? requestedPage)
    : Math.min(
        Number(value("page", "0")),
        Math.max(0, Math.ceil(filtered.length / 20) - 1),
      );
  const visible = remote.live
    ? filtered
    : filtered.slice(page * 20, page * 20 + 20);
  function startCheckIn() {
    s.startOperation({ kind: "check-in" });
  }
  function rowActions(p: Player) {
    return <PlayerActions player={p} compact />;
  }
  function playerIdentity(p: Player) {
    const pending = s.store.readModel
      ? !!s.store.readModel.pendingPlayers[p.id]
      : s.pendingApprovals.some((r) => r.playerId === p.id);
    return (
      <Button
        variant="link"
        className="h-auto min-h-11 w-full min-w-0 shrink justify-start whitespace-normal p-0 text-left @min-[800px]/players:min-h-0"
        aria-label={t("View player") + " · " + displayName(p.name)}
        aria-description={[
          p.phone,
          t(p.type),
          ...p.tags.map(t),
          pending ? t("Resolve pending request first") : "",
        ]
          .filter(Boolean)
          .join(" · ")}
        onClick={() => s.startOperation({ kind: "player", playerId: p.id })}
      >
        <span className="block min-w-0 max-w-full space-y-1">
          <span className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className="line-clamp-2 max-w-full break-words font-medium leading-5 [overflow-wrap:anywhere]">
              {displayName(p.name)}
            </span>
            {p.tags.map((tag) => (
              <Badge
                key={tag}
                variant={
                  tag === "Banned"
                    ? "destructive"
                    : tag === "Risk"
                      ? "warning"
                      : "secondary"
                }
                className="h-5 px-1.5 text-[10px]"
              >
                {t(tag)}
              </Badge>
            ))}
            {pending && (
              <Badge
                variant="outline"
                className="h-5 gap-1 px-1.5 text-[10px] font-normal text-muted-foreground"
                title={t("Resolve pending request first")}
              >
                <Clock3 aria-hidden="true" />
                {t("Pending")}
              </Badge>
            )}
          </span>
          <span className="flex flex-wrap gap-x-1.5 text-xs font-normal leading-4 text-muted-foreground">
            <span>{p.phone}</span>
            <span aria-hidden="true">·</span>
            <span>{t(p.type)}</span>
          </span>
        </span>
      </Button>
    );
  }
  function playerStatus(p: Player) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground">
        <span
          aria-hidden="true"
          className={`size-1.5 rounded-full ${p.status === "ACTIVE" ? "bg-emerald-500" : "bg-muted-foreground/50"}`}
        />
        {t(p.status)}
      </span>
    );
  }
  function playerSeat(p: Player) {
    if (p.status !== "ACTIVE") return "—";
    return (
      <span className="flex min-w-0 flex-wrap items-baseline gap-x-1">
        <span className="line-clamp-2 min-w-0 max-w-full break-words [overflow-wrap:anywhere]">
          {displayName(
            s.tables.find((table) => table.id === p.tableId)?.name ?? "—",
          )}
        </span>
        <span className="shrink-0 whitespace-nowrap">
          · {t("Seat")} {p.seat}
        </span>
      </span>
    );
  }
  return (
    <div className="space-y-5">
      <DayNotice />
      <Card className="@container/players gap-0 py-0 sm:py-0">
        <div className="space-y-3 p-3 sm:p-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold">{t("Player directory")}</h2>
            {operator && (
              <Button
                className="h-11 shrink-0 px-3 sm:h-9"
                aria-label={t("Check in player")}
                disabled={s.locked || !available.length}
                onClick={() => startCheckIn()}
              >
                <Plus />
                <span className="sm:hidden">{t("Check in")}</span>
                <span className="hidden sm:inline">{t("Check in player")}</span>
              </Button>
            )}
          </div>
          {!available.length && operator && (
            <p className="text-sm text-muted-foreground">
              {t(
                s.tables.some((table) => table.status === "OPEN")
                  ? "All open tables are full. Free a seat or open another table."
                  : "An open table is needed for check-in.",
              )}{" "}
              <Link className="underline underline-offset-4" href="/tables">
                {t("Go to tables")}
              </Link>
            </p>
          )}
          <QuickFilters
            label="Player status"
            value={value("status")}
            onValueChange={(next) => setCriteria("status", next)}
            options={statusOptions}
          />
          <ListToolbar
            compact
            search={value("search")}
            searchLabel="Search players"
            searchPlaceholder="Name, phone, or ID"
            onSearchChange={(v) => setCriteria("search", v)}
            primaryFilters={
              <Field label="Player type">
                <Select
                  value={value("type")}
                  onValueChange={(v) => setCriteria("type", v)}
                  options={[
                    { value: "", label: "All player types" },
                    { value: "CASH", label: "CASH" },
                    { value: "CREDIT", label: "CREDIT" },
                  ]}
                />
              </Field>
            }
            activeFilters={[
              ["status", "Status"],
              ["type", "Player type"],
              ["tag", "Tag"],
            ]
              .filter(([key]) => value(key))
              .map(([key, label]) => ({
                key,
                label: t(label) + ": " + t(value(key)),
                onRemove: () => setCriteria(key, ""),
                hideChip: key === "status" || key === "type",
              }))}
            onClear={clearCriteria}
            resultCount={total}
          >
            <Field label="Tag">
              <Select
                value={value("tag")}
                onValueChange={(v) => setCriteria("tag", v)}
                options={[
                  { value: "", label: "All tags" },
                  ...["VIP", "Risk", "Banned"].map((tag) => ({
                    value: tag,
                    label: tag,
                  })),
                ]}
              />
            </Field>
          </ListToolbar>
        </div>
        <ReadStatus state={remote} />
        {!filtered.length && !remote.loading && !remote.error ? (
          <EmptyState
            title={
              s.players.length ||
              value("search") ||
              value("type") ||
              value("status") ||
              value("tag")
                ? "No matching players."
                : "No players yet"
            }
            description={
              s.players.length
                ? "Try another search or clear the filters."
                : "Check in your first player to create their profile and visit."
            }
          >
            {s.players.length > 0 && (
              <Button variant="outline" onClick={clearCriteria}>
                {t("Clear all")}
              </Button>
            )}
          </EmptyState>
        ) : (
          <>
            <ul
              aria-label={t("Players")}
              className="divide-y border-t @min-[800px]/players:hidden"
            >
              {visible.map((p) => (
                <li
                  key={p.id}
                  className="min-w-0 space-y-2 px-3 py-3 sm:px-4"
                  data-player-row
                >
                  <div className="flex min-w-0 items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">{playerIdentity(p)}</div>
                    <span className="pt-1">{playerStatus(p)}</span>
                  </div>
                  {p.creditUsed > 0 && (
                    <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs leading-4 text-muted-foreground">
                      <span>{t("Outstanding credit")}</span>
                      <span className="whitespace-nowrap font-medium tabular-nums text-foreground">
                        {money(p.creditUsed)}
                      </span>
                    </p>
                  )}
                  <div className="flex min-w-0 items-end justify-between gap-2">
                    <div className="min-w-0 flex-1 space-y-1 text-xs text-muted-foreground">
                      {p.status === "ACTIVE" && <p>{playerSeat(p)}</p>}
                    </div>
                    <div className="shrink-0">{rowActions(p)}</div>
                  </div>
                </li>
              ))}
            </ul>
            <div className="hidden px-4 pb-1 @min-[800px]/players:block [&>div]:block">
              <RecordTable label="Players">
                <TableHeader>
                  <TableRow>
                    {[
                      "Player",
                      "Status",
                      "Table / seat",
                      "Outstanding credit",
                      "Actions",
                    ].map((x) => (
                      <TableHead
                        key={x}
                        scope="col"
                        className={
                          x === "Actions" || x === "Outstanding credit"
                            ? "text-right"
                            : undefined
                        }
                      >
                        {t(x)}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visible.map((p) => (
                    <TableRow key={p.id} data-player-row>
                      <TableCell className="w-[38%] max-w-80 whitespace-normal py-2">
                        {playerIdentity(p)}
                      </TableCell>
                      <TableCell className="py-2">{playerStatus(p)}</TableCell>
                      <TableCell className="max-w-48 whitespace-normal py-2 text-xs">
                        {playerSeat(p)}
                      </TableCell>
                      <TableCell
                        className={`py-2 text-right tabular-nums ${p.creditUsed ? "font-medium" : "text-muted-foreground"}`}
                      >
                        {money(p.creditUsed)}
                      </TableCell>
                      <TableCell className="py-2">
                        <div className="flex justify-end">{rowActions(p)}</div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </RecordTable>
            </div>
          </>
        )}
        <div className="px-3 pb-3 sm:px-4 sm:pb-4">
          <Pager
            label="Player pages"
            page={page}
            total={total}
            setPage={(p) => set("page", String(p))}
          />
        </div>
      </Card>
    </div>
  );
}
