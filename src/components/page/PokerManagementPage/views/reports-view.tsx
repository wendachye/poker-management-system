import { Download, Lock } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { Player, PokerTable, Totals } from "../types";
import { durationLabel, minutesBetween, money } from "../utils";
import { StatCard } from "../components/shared";

type ReportsViewProps = {
  players: Player[];
  tables: PokerTable[];
  totals: Totals;
  locked: boolean;
  setLocked: (value: boolean) => void;
  downloadReport: () => void;
};

export function ReportsView({
  players,
  tables,
  totals,
  locked,
  setLocked,
  downloadReport,
}: ReportsViewProps) {
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Cash received"
          value={money(totals.cashReceived)}
          hint="From players and entries"
          tone="text-emerald-700"
        />
        <StatCard
          label="Cash payout"
          value={money(totals.cashPayout)}
          hint="To players and insurance"
          tone="text-rose-700"
        />
        <StatCard
          label="Variance check"
          value={money(totals.variance)}
          hint="Sample reconciliation"
          tone={totals.variance >= 0 ? "text-sky-700" : "text-rose-700"}
        />
        <StatCard
          label="Player duration"
          value={durationLabel(
            players.reduce(
              (sum, player) =>
                sum + minutesBetween(player.sessionStart, player.sessionEnd),
              0,
            ),
          )}
          hint="All sessions today"
          tone="text-amber-700"
        />
      </div>
      <Card className="rounded-lg">
        <CardHeader>
          <CardTitle>Daily close</CardTitle>
          <CardDescription>
            Reconciliation, variance check, Excel export, then lock day
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 md:grid-cols-3">
            {tables.map((table) => (
              <div key={table.id} className="rounded-lg border p-3 text-sm">
                <p className="font-medium">{table.name}</p>
                <p>Rake {money(table.rake)}</p>
                <p>Insurance {money(table.insurance)}</p>
                <p>JP {money(table.jackpot)}</p>
              </div>
            ))}
          </div>
          <div className="grid gap-2 sm:flex sm:flex-wrap">
            <Button className="w-full sm:w-auto" onClick={downloadReport}>
              <Download /> Export Excel sample
            </Button>
            <Button
              className="w-full sm:w-auto"
              variant={locked ? "secondary" : "destructive"}
              onClick={() => {
                if (
                  window.confirm(
                    locked
                      ? "Unlock this sample day?"
                      : "Lock the day and block further edits?",
                  )
                ) {
                  setLocked(!locked);
                }
              }}
            >
              <Lock /> {locked ? "Unlock sample day" : "Lock day"}
            </Button>
          </div>
        </CardContent>
      </Card>
      <Card className="rounded-lg">
        <CardHeader>
          <CardTitle>Player report</CardTitle>
          <CardDescription>Buy-in, cash-out, P/L, and duration</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 md:hidden">
            {players.map((player) => (
              <div key={player.id} className="rounded-lg border p-3 text-sm">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="break-words font-medium">{player.name}</p>
                    <p className="text-xs text-muted-foreground">{player.status}</p>
                  </div>
                  <p className="shrink-0 font-medium">
                    {money(player.cashOut - player.buyIn)}
                  </p>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-muted-foreground">
                  <span>Buy-in {money(player.buyIn)}</span>
                  <span>Cash-out {money(player.cashOut)}</span>
                  <span>
                    Duration{" "}
                    {durationLabel(
                      minutesBetween(player.sessionStart, player.sessionEnd),
                    )}
                  </span>
                </div>
              </div>
            ))}
          </div>
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="border-b text-muted-foreground">
              <tr>
                <th className="py-2">Player</th>
                <th>Buy-in</th>
                <th>Cash-out</th>
                <th>P/L</th>
                <th>Duration</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {players.map((player) => (
                <tr key={player.id} className="border-b">
                  <td className="py-2">{player.name}</td>
                  <td>{money(player.buyIn)}</td>
                  <td>{money(player.cashOut)}</td>
                  <td>{money(player.cashOut - player.buyIn)}</td>
                  <td>
                    {durationLabel(
                      minutesBetween(player.sessionStart, player.sessionEnd),
                    )}
                  </td>
                  <td>{player.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
