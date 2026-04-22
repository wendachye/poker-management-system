import { ShieldCheck } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import type { ApprovalRequest, Player } from "../types";
import { money } from "../utils";
import { Badge } from "./shared";

type ApprovalQueueProps = {
  approvals: ApprovalRequest[];
  players: Player[];
  canDecide: boolean;
  decideApproval: (id: string, decision: "APPROVED" | "REJECTED") => void;
};

export function ApprovalQueue({
  approvals,
  players,
  canDecide,
  decideApproval,
}: ApprovalQueueProps) {
  const pending = approvals.filter((approval) => approval.status === "PENDING");
  const recent = approvals
    .filter((approval) => approval.status !== "PENDING")
    .slice(0, 3);

  return (
    <Card className="rounded-lg">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="size-4" /> Manager/Admin approvals
        </CardTitle>
        <CardDescription>
          Every buy-in, cash-out, rake, tips, insurance, jackpot, cash received,
          and cash payout entry waits here before posting.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {pending.length === 0 && (
          <div className="rounded-lg border p-3 text-sm text-muted-foreground">
            No pending approvals.
          </div>
        )}
        {pending.map((approval) => {
          const player = players.find((item) => item.id === approval.playerId);

          return (
            <div
              key={approval.id}
              className="grid gap-3 rounded-lg border p-3 lg:grid-cols-[1fr_auto]"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-medium">
                    {approval.type} | {money(approval.amount)}
                  </p>
                  <Badge tone="amber">Pending</Badge>
                  <Badge
                    tone={
                      approval.approvalLevel === "DUAL"
                        ? "red"
                        : approval.approvalLevel === "ADMIN"
                          ? "blue"
                          : "neutral"
                    }
                  >
                    {approval.approvalLevel}
                  </Badge>
                </div>
                <p className="text-sm text-muted-foreground">
                  {player?.name || approval.tableId || "House"} | Requested by{" "}
                  {approval.requestedBy} at {approval.createdAt}
                </p>
                <p className="text-xs text-muted-foreground">
                  Cash received {money(approval.cashReceived)} | Cash payout{" "}
                  {money(approval.cashPayout)} | {approval.note}
                </p>
                <p className="text-xs font-medium text-amber-700">
                  {approval.riskReason}
                </p>
              </div>
              {canDecide ? (
                <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center">
                  <Button
                    className="w-full sm:w-auto"
                    size="sm"
                    onClick={() => {
                      if (
                        window.confirm(
                          `Approve ${approval.type} ${money(approval.amount)}?`,
                        )
                      ) {
                        decideApproval(approval.id, "APPROVED");
                      }
                    }}
                  >
                    Approve
                  </Button>
                  <Button
                    className="w-full sm:w-auto"
                    size="sm"
                    variant="destructive"
                    onClick={() => {
                      if (
                        window.confirm(
                          `Reject ${approval.type} ${money(approval.amount)}?`,
                        )
                      ) {
                        decideApproval(approval.id, "REJECTED");
                      }
                    }}
                  >
                    Reject
                  </Button>
                </div>
              ) : (
                <Badge tone="blue">Admin or Manager only</Badge>
              )}
            </div>
          );
        })}
        {recent.length > 0 && (
          <div className="grid gap-2 pt-2">
            <p className="text-sm font-medium">Recent decisions</p>
            {recent.map((approval) => (
              <div
                key={approval.id}
                className="flex flex-col gap-2 rounded-lg border p-3 text-sm sm:flex-row sm:items-center sm:justify-between"
              >
                <span className="min-w-0 break-words">
                  {approval.type} | {money(approval.amount)} |{" "}
                  {approval.decidedBy}
                </span>
                <Badge tone={approval.status === "APPROVED" ? "green" : "red"}>
                  {approval.status}
                </Badge>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
