"use client";

import { useState } from "react";
import { Plus, RefreshCcw, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type {
  ApprovalRequest,
  AuditLog,
  CheckInForm,
  Player,
  PlayerTag,
  PlayerType,
  PokerTable,
  SetState,
  Transaction,
} from "../types";
import { durationLabel, minutesBetween, money } from "../utils";
import { Badge, FormField, FormSelect } from "../components/shared";

type PlayersViewProps = {
  players: Player[];
  playerSearch: string;
  setPlayerSearch: (value: string) => void;
  checkIn: CheckInForm;
  setCheckIn: SetState<CheckInForm>;
  tables: PokerTable[];
  handleCheckIn: () => void;
  refreshCredit: () => void;
  transactions: Transaction[];
  auditLogs: AuditLog[];
  pendingApprovals: ApprovalRequest[];
};

export function PlayersView({
  players,
  playerSearch,
  setPlayerSearch,
  checkIn,
  setCheckIn,
  tables,
  handleCheckIn,
  refreshCredit,
  transactions,
  auditLogs,
  pendingApprovals,
}: PlayersViewProps) {
  const [filter, setFilter] = useState<
    "ALL" | "ACTIVE" | "PENDING" | "CREDIT" | "RISK" | "BANNED"
  >("ALL");
  const visiblePlayers = players.filter((player) => {
    if (filter === "ACTIVE") return player.status === "ACTIVE";
    if (filter === "CREDIT") return player.type === "CREDIT";
    if (filter === "RISK") return player.tags.includes("Risk");
    if (filter === "BANNED") return player.tags.includes("Banned");
    if (filter === "PENDING") {
      return pendingApprovals.some(
        (approval) => approval.playerId === player.id,
      );
    }

    return true;
  });

  return (
    <div className="grid gap-4 xl:grid-cols-[0.8fr_1.2fr]">
      <Card className="rounded-lg">
        <CardHeader>
          <CardTitle>Create or check-in player</CardTitle>
          <CardDescription>
            CASH has no limit. CREDIT uses available limit.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <FormField label="Player name">
            <Input
              value={checkIn.name}
              onChange={(event) =>
                setCheckIn((value) => ({ ...value, name: event.target.value }))
              }
              placeholder="Player name"
            />
          </FormField>
          <FormField label="Phone">
            <Input
              value={checkIn.phone}
              inputMode="tel"
              onChange={(event) =>
                setCheckIn((value) => ({ ...value, phone: event.target.value }))
              }
              placeholder="Phone"
            />
          </FormField>
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="Player type">
              <FormSelect
                value={checkIn.type}
                onValueChange={(value) =>
                  setCheckIn((current) => ({
                    ...current,
                    type: value as PlayerType,
                  }))
                }
                options={["CASH", "CREDIT"]}
              />
            </FormField>
            <FormField label="Credit limit" hint="Used only for CREDIT players.">
              <Input
                value={checkIn.creditLimit}
                inputMode="decimal"
                onChange={(event) =>
                  setCheckIn((value) => ({
                    ...value,
                    creditLimit: event.target.value,
                  }))
                }
                placeholder="Credit limit"
              />
            </FormField>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <FormField label="Table">
              <FormSelect
                value={checkIn.tableId}
                onValueChange={(value) =>
                  setCheckIn((current) => ({ ...current, tableId: value }))
                }
                options={tables.map((table) => table.id)}
              />
            </FormField>
            <FormField label="Seat">
              <Input
                value={checkIn.seat}
                inputMode="numeric"
                onChange={(event) =>
                  setCheckIn((value) => ({ ...value, seat: event.target.value }))
                }
                placeholder="Seat 1-9"
              />
            </FormField>
            <FormField label="Tag">
              <FormSelect
                value={checkIn.tag}
                onValueChange={(value) =>
                  setCheckIn((current) => ({
                    ...current,
                    tag: value as PlayerTag,
                  }))
                }
                options={["VIP", "Risk", "Banned"]}
              />
            </FormField>
          </div>
          <div className="grid gap-2 sm:flex sm:flex-wrap">
            <Button className="w-full sm:w-auto" onClick={handleCheckIn}>
              <Plus /> Check in
            </Button>
            <Button
              className="w-full sm:w-auto"
              variant="outline"
              onClick={refreshCredit}
            >
              <RefreshCcw /> Refresh credit
            </Button>
          </div>
        </CardContent>
      </Card>
      <Card className="rounded-lg">
        <CardHeader>
          <CardTitle>Player search</CardTitle>
          <CardDescription>
            Create, edit, find tags, and review session data
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2 rounded-lg border px-2">
            <Search className="size-4 text-muted-foreground" />
            <Input
              className="border-0 focus-visible:ring-0"
              value={playerSearch}
              onChange={(event) => setPlayerSearch(event.target.value)}
              placeholder="Search by name, phone, or ID"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            {(["ALL", "ACTIVE", "PENDING", "CREDIT", "RISK", "BANNED"] as const).map(
              (item) => (
                <Button
                  key={item}
                  size="sm"
                  variant={filter === item ? "default" : "outline"}
                  onClick={() => setFilter(item)}
                >
                  {item}
                </Button>
              ),
            )}
          </div>
          {visiblePlayers.length === 0 && (
            <div className="rounded-lg border p-3 text-sm text-muted-foreground">
              No players match this filter.
            </div>
          )}
          {visiblePlayers.map((player) => {
            const playerTransactions = transactions.filter(
              (tx) => tx.playerId === player.id,
            );
            const playerLogs = auditLogs.filter((log) => log.entity === player.id);

            return (
            <div
              key={player.id}
              className="grid gap-3 rounded-lg border p-3 lg:grid-cols-[minmax(0,1fr)_auto]"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-medium">{player.name}</p>
                  <Badge tone={player.status === "ACTIVE" ? "green" : "neutral"}>
                    {player.status}
                  </Badge>
                  <Badge tone={player.type === "CREDIT" ? "blue" : "neutral"}>
                    {player.type}
                  </Badge>
                  {player.tags.map((tag) => (
                    <Badge
                      key={tag}
                      tone={
                        tag === "Banned" ? "red" : tag === "Risk" ? "amber" : "green"
                      }
                    >
                      {tag}
                    </Badge>
                  ))}
                </div>
                <p className="text-sm text-muted-foreground">
                  {player.id} | {player.phone}
                </p>
              </div>
              <div className="grid min-w-0 grid-cols-1 gap-2 text-sm sm:grid-cols-2 xl:grid-cols-4">
                <span className="break-words">Buy-in: {money(player.buyIn)}</span>
                <span className="break-words">Cash-out: {money(player.cashOut)}</span>
                <span className="break-words">
                  P/L: {money(player.cashOut - player.buyIn)}
                </span>
                <span>
                  Time:{" "}
                  {durationLabel(
                    minutesBetween(player.sessionStart, player.sessionEnd),
                  )}
                </span>
              </div>
              <details className="lg:col-span-2">
                <summary className="cursor-pointer text-sm font-medium">
                  Profile history
                </summary>
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  <div className="rounded-lg border p-3 text-sm">
                    <p className="font-medium">Recent transactions</p>
                    {playerTransactions.length === 0 && (
                      <p className="text-muted-foreground">No transaction history.</p>
                    )}
                    {playerTransactions.slice(0, 3).map((tx) => (
                      <p key={tx.id} className="text-muted-foreground">
                        {tx.time} | {tx.type} | {money(tx.amount)}
                      </p>
                    ))}
                  </div>
                  <div className="rounded-lg border p-3 text-sm">
                    <p className="font-medium">Notes and audit</p>
                    {playerLogs.length === 0 && (
                      <p className="text-muted-foreground">No audit notes yet.</p>
                    )}
                    {playerLogs.slice(0, 3).map((log) => (
                      <p key={log.id} className="text-muted-foreground">
                        {log.time} | {log.action} | {log.reason}
                      </p>
                    ))}
                  </div>
                </div>
              </details>
            </div>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}
