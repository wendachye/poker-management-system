import { Bell } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type {
  AuditLog,
  NotificationItem,
  Player,
  PokerTable,
  Totals,
  Transaction,
} from "../types";
import { durationLabel, minutesBetween, money } from "../utils";
import { StatCard } from "../components/shared";

type DashboardViewProps = {
  totals: Totals;
  activePlayers: Player[];
  tables: PokerTable[];
  transactions: Transaction[];
  players: Player[];
  auditLogs: AuditLog[];
  notifications: NotificationItem[];
};

export function DashboardView({
  totals,
  activePlayers,
  tables,
  transactions,
  players,
  auditLogs,
  notifications,
}: DashboardViewProps) {
  const timeline = [
    ...auditLogs.slice(0, 4).map((log) => ({
      id: log.id,
      time: log.time,
      title: log.action,
      body: `${log.actor} | ${log.reason}`,
    })),
    ...transactions.slice(0, 2).map((tx) => ({
      id: tx.id,
      time: tx.time,
      title: tx.type,
      body: `${tx.playerId || tx.tableId || "House"} ${money(tx.amount)}`,
    })),
  ].slice(0, 5);

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <StatCard
          label="Buy-in today"
          value={money(totals.buyInTotal)}
          hint="Cash and credit"
          tone="text-emerald-700"
        />
        <StatCard
          label="Cash-out today"
          value={money(totals.cashOutTotal)}
          hint="Player payouts"
          tone="text-rose-700"
        />
        <StatCard
          label="Rake"
          value={money(totals.rake)}
          hint="Accumulated by table"
          tone="text-sky-700"
        />
        <StatCard
          label="Insurance"
          value={money(totals.insurance)}
          hint="Premium less payout"
          tone="text-amber-700"
        />
        <StatCard
          label="Jackpot"
          value={money(totals.jackpot)}
          hint="Manual JP entries"
          tone="text-fuchsia-700"
        />
        <StatCard
          label="Tips"
          value={money(totals.tips)}
          hint="By dealer or personal"
          tone="text-teal-700"
        />
      </div>
      <div className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
        <Card className="rounded-lg">
          <CardHeader>
            <CardTitle>Players in-house</CardTitle>
            <CardDescription>Active sessions with auto duration</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {activePlayers.map((player) => (
              <div
                key={player.id}
                className="flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="break-words font-medium">{player.name}</p>
                  <p className="text-sm text-muted-foreground">
                    {player.tableId} seat {player.seat} |{" "}
                    {durationLabel(minutesBetween(player.sessionStart))}
                  </p>
                </div>
              <div className="text-left sm:text-right">
                  <p className="break-words text-sm font-medium">
                    {money(player.buyIn)}
                  </p>
                  <p className="text-xs text-muted-foreground">{player.type}</p>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
        <Card className="rounded-lg">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Bell className="size-4" /> Notifications
            </CardTitle>
            <CardDescription>
              Buy-in, cash-out, approval, and 30 minute summaries
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {notifications.length === 0 && (
              <div className="rounded-lg border p-3 text-sm text-muted-foreground">
                No urgent notifications.
              </div>
            )}
            {notifications.map((alert) => (
              <div key={alert.id} className="rounded-lg border p-3">
                <p className="font-medium">{alert.title}</p>
                <p className="text-sm text-muted-foreground">{alert.body}</p>
                {alert.action && (
                  <p className="text-xs font-medium text-amber-700">
                    {alert.action}
                  </p>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
      <Card className="rounded-lg">
        <CardHeader>
          <CardTitle>Today timeline</CardTitle>
          <CardDescription>
            Check-ins, approvals, movements, and cashier activity
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
          {timeline.map((item) => (
            <div key={item.id} className="rounded-lg border p-3 text-sm">
              <p className="text-xs text-muted-foreground">{item.time}</p>
              <p className="font-medium">{item.title}</p>
              <p className="text-muted-foreground">{item.body}</p>
            </div>
          ))}
        </CardContent>
      </Card>
      <div className="grid gap-4 md:grid-cols-3">
        {tables.map((table) => (
          <Card key={table.id} className="rounded-lg">
            <CardHeader>
              <CardTitle>{table.name}</CardTitle>
              <CardDescription>
                {table.status} |{" "}
                {
                  players.filter(
                    (player) =>
                      player.tableId === table.id && player.status === "ACTIVE",
                  ).length
                }
                /9 seated
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex justify-between gap-3">
                <span>Rake</span>
                <span className="break-words text-right">{money(table.rake)}</span>
              </div>
              <div className="flex justify-between gap-3">
                <span>Insurance</span>
                <span className="break-words text-right">
                  {money(table.insurance)}
                </span>
              </div>
              <div className="flex justify-between gap-3">
                <span>JP</span>
                <span className="break-words text-right">{money(table.jackpot)}</span>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </>
  );
}
