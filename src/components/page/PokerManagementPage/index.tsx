"use client";

import { Bell } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ApprovalQueue } from "./components/approval-queue";
import { Badge } from "./components/shared";
import { usePokerManagementContext } from "./PokerManagementProvider";
import type { ModuleKey } from "./types";
import { AdminView } from "./views/admin-view";
import { DashboardView } from "./views/dashboard-view";
import { PlayersView } from "./views/players-view";
import { ReportsView } from "./views/reports-view";
import { TablesView } from "./views/tables-view";
import { TransactionsView } from "./views/transactions-view";

export function PokerManagementPage({ module }: { module: ModuleKey }) {
  const state = usePokerManagementContext();

  return (
    <div className="space-y-4 sm:space-y-6">
      <section className="flex flex-col gap-4 rounded-md border bg-card p-4 shadow-sm sm:p-5 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <p className="text-sm text-muted-foreground">Poker operations</p>
          <h1 className="break-words text-xl font-semibold tracking-tight sm:text-2xl md:text-3xl">
            {module === "admin"
              ? "Admin"
              : module[0].toUpperCase() + module.slice(1)}
          </h1>
        </div>
        <div className="flex min-w-0 flex-wrap gap-2">
          <Badge tone={state.locked ? "red" : "green"}>
            {state.locked ? "Day locked" : "Day open"}
          </Badge>
          <Badge tone="blue">{state.activePlayers.length} players in-house</Badge>
          <Badge tone={state.pendingApprovals.length ? "amber" : "neutral"}>
            {state.pendingApprovals.length} pending approvals
          </Badge>
        </div>
      </section>

      <Alert variant="info">
        <Bell className="size-4" />
        <AlertTitle>System message</AlertTitle>
        <AlertDescription>{state.notice}</AlertDescription>
      </Alert>

      {(module === "dashboard" ||
        module === "transactions" ||
        module === "admin") && (
        <ApprovalQueue
          approvals={state.approvals}
          players={state.players}
          canDecide={module === "admin"}
          decideApproval={state.decideApproval}
        />
      )}

      {module === "dashboard" && (
        <DashboardView
          totals={state.totals}
          activePlayers={state.activePlayers}
          tables={state.tables}
          transactions={state.transactions}
          players={state.players}
          auditLogs={state.auditLogs}
          notifications={state.notifications}
        />
      )}

      {module === "players" && (
        <PlayersView
          players={state.filteredPlayers}
          playerSearch={state.playerSearch}
          setPlayerSearch={state.setPlayerSearch}
          checkIn={state.checkIn}
          setCheckIn={state.setCheckIn}
          tables={state.tables}
          handleCheckIn={state.handleCheckIn}
          refreshCredit={state.refreshCredit}
          transactions={state.transactions}
          auditLogs={state.auditLogs}
          pendingApprovals={state.pendingApprovals}
        />
      )}

      {module === "tables" && (
        <TablesView
          tables={state.tables}
          players={state.players}
          pendingApprovals={state.pendingApprovals}
          movePlayer={state.movePlayer}
        />
      )}

      {module === "transactions" && (
        <TransactionsView
          activePlayers={state.activePlayers}
          tables={state.tables}
          buyIn={state.buyIn}
          setBuyIn={state.setBuyIn}
          cashOut={state.cashOut}
          setCashOut={state.setCashOut}
          manualTx={state.manualTx}
          setManualTx={state.setManualTx}
          handleBuyIn={state.handleBuyIn}
          handleCashOut={state.handleCashOut}
          handleManualTransaction={state.handleManualTransaction}
          requestCorrection={state.requestCorrection}
          transactions={state.transactions}
          players={state.players}
        />
      )}

      {module === "reports" && (
        <ReportsView
          players={state.players}
          tables={state.tables}
          totals={state.totals}
          locked={state.locked}
          setLocked={state.setLocked}
          downloadReport={state.downloadReport}
        />
      )}

      {module === "admin" && (
        <AdminView
          locked={state.locked}
          setLocked={state.setLocked}
          auditLogs={state.auditLogs}
        />
      )}
    </div>
  );
}

export default PokerManagementPage;
