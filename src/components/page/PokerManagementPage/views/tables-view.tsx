import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { ApprovalRequest, Player, PokerTable } from "../types";
import { money } from "../utils";
import { Badge } from "../components/shared";

type TablesViewProps = {
  tables: PokerTable[];
  players: Player[];
  pendingApprovals: ApprovalRequest[];
  movePlayer: (playerId: string, tableId: string, seat: number) => void;
};

export function TablesView({
  tables,
  players,
  pendingApprovals,
  movePlayer,
}: TablesViewProps) {
  const openTables = tables.filter((table) => table.status === "OPEN").length;
  const seatedPlayers = players.filter((player) => player.status === "ACTIVE");
  const openSeats =
    tables.filter((table) => table.status === "OPEN").length * 9 -
    seatedPlayers.length;

  return (
    <div className="space-y-4">
      <Card className="rounded-lg">
        <CardHeader>
          <CardTitle>Live floor control</CardTitle>
          <CardDescription>
            Room map for seating, movement, table pressure, and floor alerts
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-lg border p-3">
            <p className="text-sm text-muted-foreground">Open tables</p>
            <p className="text-2xl font-semibold">{openTables}</p>
          </div>
          <div className="rounded-lg border p-3">
            <p className="text-sm text-muted-foreground">Open seats</p>
            <p className="text-2xl font-semibold">{openSeats}</p>
          </div>
          <div className="rounded-lg border p-3">
            <p className="text-sm text-muted-foreground">Pending table actions</p>
            <p className="text-2xl font-semibold">{pendingApprovals.length}</p>
          </div>
        </CardContent>
      </Card>
      <div className="grid gap-4 xl:grid-cols-3">
      {tables.map((table) => {
        const seated = players.filter(
          (player) => player.status === "ACTIVE" && player.tableId === table.id,
        );
        const tableApprovals = pendingApprovals.filter(
          (approval) => approval.tableId === table.id,
        );
        const openSeats = Array.from({ length: 9 }, (_, index) => index + 1).filter(
          (seat) => !seated.some((player) => player.seat === seat),
        );
        const movablePlayers =
          table.status === "OPEN"
            ? players
                .filter(
                  (player) =>
                    player.status === "ACTIVE" && player.tableId !== table.id,
                )
                .slice(0, openSeats.length)
            : [];

        return (
          <Card key={table.id} className="rounded-lg">
            <CardHeader>
              <CardTitle className="flex items-center justify-between">
                <span>{table.name}</span>
                <div className="flex flex-wrap justify-end gap-2">
                  <Badge tone={table.status === "OPEN" ? "green" : "neutral"}>
                    {table.status}
                  </Badge>
                  {tableApprovals.length > 0 && (
                    <Badge tone="amber">{tableApprovals.length} approvals</Badge>
                  )}
                </div>
              </CardTitle>
              <CardDescription>
                {table.dealer} | {seated.length}/9 players
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {Array.from({ length: 9 }, (_, index) => {
                  const seat = index + 1;
                  const player = seated.find((item) => item.seat === seat);

                  return (
                    <div
                      key={seat}
                      className="min-h-20 rounded-lg border p-2 text-sm"
                    >
                      <p className="text-xs text-muted-foreground">Seat {seat}</p>
                      <p className="break-words font-medium">
                        {player?.name || "Open"}
                      </p>
                      {player && (
                        <p className="text-xs text-muted-foreground">{player.type}</p>
                      )}
                    </div>
                  );
                })}
              </div>
              <div className="space-y-2 text-sm">
                <p className="font-medium">Player movement</p>
                <div className="grid gap-2 sm:flex sm:flex-wrap">
                  {movablePlayers.slice(0, 3).map((player, index) => (
                    <Button
                      className="w-full sm:w-auto"
                      key={player.id}
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        movePlayer(player.id, table.id, openSeats[index])
                      }
                    >
                      {player.name} to seat {openSeats[index]}
                    </Button>
                  ))}
                  {!movablePlayers.length && (
                    <p className="text-sm text-muted-foreground">
                      No available player movement.
                    </p>
                  )}
                </div>
              </div>
              <div className="grid gap-2 text-sm sm:grid-cols-3">
                <span>Rake {money(table.rake)}</span>
                <span>Ins {money(table.insurance)}</span>
                <span>JP {money(table.jackpot)}</span>
              </div>
            </CardContent>
          </Card>
        );
      })}
      </div>
    </div>
  );
}
