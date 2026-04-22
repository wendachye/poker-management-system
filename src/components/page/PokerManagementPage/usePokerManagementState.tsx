"use client";

import { useEffect, useMemo, useState } from "react";

import {
  initialBuyIn,
  initialCashOut,
  initialCheckIn,
  initialManualTx,
} from "./data";
import {
  createInitialPokerStore,
  loadPokerStore,
  savePokerStore,
} from "./storage";
import type {
  ApprovalLevel,
  ApprovalRequest,
  AuditLog,
  NotificationItem,
  Transaction,
  Totals,
} from "./types";
import {
  createId,
  currentIso,
  currentTimeLabel,
  durationLabel,
  minutesBetween,
  money,
  parsePositiveAmount,
  parseRequiredText,
  parseSeat,
  toCsv,
} from "./utils";

export function usePokerManagementState() {
  const [store, setStore] = useState(loadPokerStore);
  const [playerSearch, setPlayerSearch] = useState("");
  const [notice, setNotice] = useState(
    "Ready for check-in, cashier, and close day samples.",
  );
  const [checkIn, setCheckIn] = useState(initialCheckIn);
  const [buyIn, setBuyIn] = useState(initialBuyIn);
  const [cashOut, setCashOut] = useState(initialCashOut);
  const [manualTx, setManualTx] = useState(initialManualTx);

  const { players, tables, transactions, approvals, auditLogs, locked } = store;
  const activePlayers = players.filter((player) => player.status === "ACTIVE");
  const pendingApprovals = approvals.filter(
    (approval) => approval.status === "PENDING",
  );
  const filteredPlayers = players.filter((player) => {
    const query = playerSearch.toLowerCase();
    return [player.name, player.phone, player.id].some((value) =>
      value.toLowerCase().includes(query),
    );
  });

  const totals = useMemo<Totals>(() => {
    const buyInTotal = players.reduce((sum, player) => sum + player.buyIn, 0);
    const cashOutTotal = players.reduce((sum, player) => sum + player.cashOut, 0);
    const rake = tables.reduce((sum, table) => sum + table.rake, 0);
    const insurance = tables.reduce((sum, table) => sum + table.insurance, 0);
    const jackpot = tables.reduce((sum, table) => sum + table.jackpot, 0);
    const tips = transactions
      .filter((tx) => tx.type === "Tips")
      .reduce((sum, tx) => sum + tx.amount, 0);
    const cashReceived = transactions.reduce(
      (sum, tx) => sum + tx.cashReceived,
      0,
    );
    const cashPayout = transactions.reduce((sum, tx) => sum + tx.cashPayout, 0);

    return {
      buyInTotal,
      cashOutTotal,
      rake,
      insurance,
      jackpot,
      tips,
      cashReceived,
      cashPayout,
      variance:
        cashReceived - cashPayout + rake + tips + insurance + jackpot - cashOutTotal,
    };
  }, [players, tables, transactions]);

  const notifications = useMemo<NotificationItem[]>(() => {
    const creditAlerts = activePlayers
      .filter(
        (player) =>
          player.type === "CREDIT" &&
          player.creditLimit > 0 &&
          player.creditUsed / player.creditLimit >= 0.75,
      )
      .map((player) => ({
        id: `credit-${player.id}`,
        title: "Credit exposure",
        body: `${player.name} has used ${money(player.creditUsed)} of ${money(
          player.creditLimit,
        )}.`,
        tone: "warning" as const,
        action: "Review credit before next buy-in",
      }));

    const approvalAlerts = pendingApprovals.slice(0, 3).map((approval) => ({
      id: `approval-${approval.id}`,
      title: `${approval.approvalLevel} approval waiting`,
      body: `${approval.type} ${money(approval.amount)} for ${
        players.find((player) => player.id === approval.playerId)?.name ||
        approval.tableId ||
        "house"
      }.`,
      tone: approval.approvalLevel === "DUAL" ? "destructive" as const : "info" as const,
      action: approval.riskReason,
    }));

    const floorAlerts = tables
      .filter(
        (table) =>
          table.status === "OPEN" &&
          activePlayers.filter((player) => player.tableId === table.id).length >= 8,
      )
      .map((table) => ({
        id: `floor-${table.id}`,
        title: "Table nearly full",
        body: `${table.name} has ${
          activePlayers.filter((player) => player.tableId === table.id).length
        }/9 seats filled.`,
        tone: "warning" as const,
        action: "Open another table or prepare movement",
      }));

    const riskAlerts = activePlayers
      .filter((player) => player.tags.includes("Risk"))
      .map((player) => ({
        id: `risk-${player.id}`,
        title: "Risk player active",
        body: `${player.name} is currently seated at ${player.tableId}, seat ${player.seat}.`,
        tone: "warning" as const,
        action: "Manager review recommended",
      }));

    return [...approvalAlerts, ...creditAlerts, ...floorAlerts, ...riskAlerts].slice(0, 8);
  }, [activePlayers, pendingApprovals, players, tables]);

  useEffect(() => {
    savePokerStore(store);
  }, [store]);

  function updateStore(updater: (current: typeof store) => typeof store) {
    setStore(updater);
  }

  function createAuditLog({
    actor,
    action,
    entity,
    reason,
    before,
    after,
  }: Omit<AuditLog, "id" | "time">): AuditLog {
    return {
      id: createId("LOG"),
      time: currentTimeLabel(),
      actor,
      action,
      entity,
      reason,
      before,
      after,
    };
  }

  function setLocked(value: boolean) {
    updateStore((current) => ({
      ...current,
      locked: value,
      auditLogs: [
        createAuditLog({
          actor: "Manager/Admin",
          action: value ? "Locked day" : "Unlocked day",
          entity: "Daily close",
          reason: value ? "End-of-day lock" : "Sample unlock",
          before: current.locked ? "LOCKED" : "OPEN",
          after: value ? "LOCKED" : "OPEN",
        }),
        ...current.auditLogs,
      ],
    }));
  }

  function approvalPolicy(tx: Omit<Transaction, "id" | "time">): {
    approvalLevel: ApprovalLevel;
    riskReason: string;
  } {
    if (tx.amount >= 25000) {
      return {
        approvalLevel: "DUAL",
        riskReason: "High-value transaction requires dual approval",
      };
    }

    if (
      tx.type === "Cash-out" ||
      tx.type === "Insurance Payout" ||
      tx.type === "Jackpot" ||
      tx.amount >= 10000
    ) {
      return {
        approvalLevel: "ADMIN",
        riskReason: "Admin approval required by threshold or payout type",
      };
    }

    return {
      approvalLevel: "MANAGER",
      riskReason: "Manager approval required",
    };
  }

  function pendingBuyInForPlayer(playerId: string, approvalList = approvals) {
    return approvalList
      .filter(
        (approval) =>
          approval.status === "PENDING" &&
          approval.type === "Buy-in" &&
          approval.playerId === playerId,
      )
      .reduce((sum, approval) => sum + approval.amount, 0);
  }

  function findOpenTable(tableId: string) {
    const table = tables.find((item) => item.id === tableId);

    return table?.status === "OPEN" ? table : undefined;
  }

  function requestApproval(tx: Omit<Transaction, "id" | "time">, requestedBy: string) {
    const policy = approvalPolicy(tx);
    const next: ApprovalRequest = {
      ...tx,
      ...policy,
      id: createId("APR"),
      status: "PENDING",
      requestedBy,
      createdAt: currentTimeLabel(),
    };
    updateStore((current) => ({
      ...current,
      approvals: [next, ...current.approvals],
      auditLogs: [
        createAuditLog({
          actor: requestedBy,
          action: "Requested approval",
          entity: next.id,
          reason: policy.riskReason,
          after: `${tx.type} ${money(tx.amount)} ${next.approvalLevel}`,
        }),
        ...current.auditLogs,
      ],
    }));
    setNotice(
      `${tx.type} approval requested: ${money(tx.amount)}. ${policy.approvalLevel} review required.`,
    );
  }

  function validateApprovalRequest(request: ApprovalRequest) {
    const player = request.playerId
      ? players.find((item) => item.id === request.playerId)
      : undefined;
    const table = request.tableId
      ? tables.find((item) => item.id === request.tableId)
      : undefined;

    if ((request.type === "Buy-in" || request.type === "Cash-out") && !player) {
      return "Player is no longer available.";
    }

    if (request.type === "Buy-in") {
      if (!player || player.status !== "ACTIVE") return "Player must be ACTIVE.";
      if (
        player.type === "CREDIT" &&
        player.creditUsed + request.amount > player.creditLimit
      ) {
        return "Approval blocked: credit limit would be exceeded.";
      }
    }

    if (request.type === "Cash-out" && (!player || player.status !== "ACTIVE")) {
      return "Approval blocked: player is already OUT.";
    }

    if (request.tableId && !table) {
      return "Table is no longer available.";
    }
    if (table && table.status !== "OPEN") {
      return "Approval blocked: table is closed.";
    }

    return null;
  }

  function applyApprovedRequest(request: ApprovalRequest) {
    const validationError = validateApprovalRequest(request);
    if (validationError) {
      setNotice(validationError);
      return false;
    }

    let nextPlayers = players;
    let nextTables = tables;

    if (request.type === "Buy-in" && request.playerId) {
      nextPlayers = nextPlayers.map((item) =>
          item.id === request.playerId
            ? {
                ...item,
                buyIn: item.buyIn + request.amount,
                creditUsed:
                  item.type === "CREDIT"
                    ? item.creditUsed + request.amount
                    : item.creditUsed,
              }
            : item,
      );
    }

    if (request.type === "Cash-out" && request.playerId) {
      nextPlayers = nextPlayers.map((item) =>
          item.id === request.playerId
            ? {
                ...item,
                status: "OUT",
                cashOut: item.cashOut + request.amount,
                sessionEnd: currentIso(),
                tableId: undefined,
                seat: undefined,
              }
            : item,
      );
    }

    nextTables = nextTables.map((table) =>
        table.id === request.tableId
          ? {
              ...table,
              rake: request.type === "Rake" ? table.rake + request.amount : table.rake,
              jackpot:
                request.type === "Jackpot"
                  ? table.jackpot + request.amount
                  : table.jackpot,
              insurance:
                request.type === "Insurance Premium"
                  ? table.insurance + request.amount
                  : request.type === "Insurance Payout"
                    ? table.insurance - request.amount
                    : table.insurance,
            }
          : table,
    );

    const nextTransaction: Transaction = {
      ...request,
      id: createId("TX"),
      time: currentTimeLabel(),
    };

    updateStore((current) => ({
      ...current,
      players: nextPlayers,
      tables: nextTables,
      transactions: [nextTransaction, ...current.transactions],
      auditLogs: [
        createAuditLog({
          actor: "Manager/Admin",
          action: "Posted approved transaction",
          entity: nextTransaction.id,
          reason: request.riskReason,
          after: `${request.type} ${money(request.amount)}`,
        }),
        ...current.auditLogs,
      ],
    }));
    return true;
  }

  function decideApproval(id: string, decision: "APPROVED" | "REJECTED") {
    if (locked) return setNotice("Day is locked. No edits allowed.");
    const request = approvals.find((approval) => approval.id === id);
    if (!request || request.status !== "PENDING") return;

    if (decision === "APPROVED" && !applyApprovedRequest(request)) return;
    updateStore((current) => ({
      ...current,
      approvals: current.approvals.map((approval) =>
        approval.id === id
          ? { ...approval, status: decision, decidedBy: "Manager/Admin" }
          : approval,
      ),
      auditLogs: [
        createAuditLog({
          actor: "Manager/Admin",
          action: `${decision === "APPROVED" ? "Approved" : "Rejected"} request`,
          entity: id,
          reason: request.riskReason,
          before: "PENDING",
          after: decision,
        }),
        ...current.auditLogs,
      ],
    }));
    setNotice(`${request.type} ${decision.toLowerCase()} by Manager/Admin.`);
  }

  function handleCheckIn() {
    if (locked) return setNotice("Day is locked. No edits allowed.");
    const parsedName = parseRequiredText(checkIn.name, "Player name");
    if (!parsedName.ok) return setNotice(parsedName.error);
    const parsedPhone = parseRequiredText(checkIn.phone, "Phone");
    if (!parsedPhone.ok) return setNotice(parsedPhone.error);
    const parsedSeat = parseSeat(checkIn.seat);
    if (!parsedSeat.ok) return setNotice(parsedSeat.error);
    const seat = parsedSeat.value;
    let creditLimit = 0;

    if (checkIn.type === "CREDIT") {
      const parsedCreditLimit = parsePositiveAmount(
        checkIn.creditLimit,
        "Credit limit",
      );
      if (!parsedCreditLimit.ok) return setNotice(parsedCreditLimit.error);
      creditLimit = parsedCreditLimit.value;
    }
    const tablePlayers = players.filter(
      (player) => player.status === "ACTIVE" && player.tableId === checkIn.tableId,
    );

    if (checkIn.tag === "Banned") return setNotice("Banned players cannot be checked in.");
    if (!findOpenTable(checkIn.tableId)) {
      return setNotice("Select an OPEN table before check-in.");
    }
    if (
      players.some(
        (player) =>
          player.status === "ACTIVE" &&
          player.phone.trim().toLowerCase() === parsedPhone.value.toLowerCase(),
      )
    ) {
      return setNotice("Player is already ACTIVE. Cash out before check-in.");
    }
    if (tablePlayers.length >= 9) return setNotice("Table is full. Max 9 players per table.");
    if (tablePlayers.some((player) => player.seat === seat)) {
      return setNotice("Seat is occupied. Choose another seat.");
    }

    const newPlayer = {
      id: createId("P"),
      name: parsedName.value,
      phone: parsedPhone.value,
      type: checkIn.type,
      creditLimit,
      creditUsed: 0,
      tags: [checkIn.tag],
      status: "ACTIVE" as const,
      tableId: checkIn.tableId,
      seat,
      sessionStart: currentIso(),
      buyIn: 0,
      cashOut: 0,
    };

    updateStore((current) => ({
      ...current,
      players: [newPlayer, ...current.players],
      auditLogs: [
        createAuditLog({
          actor: "Floor Manager",
          action: "Checked in player",
          entity: newPlayer.id,
          reason: `${newPlayer.type} player assigned to ${newPlayer.tableId}`,
          after: `ACTIVE seat ${seat}`,
        }),
        ...current.auditLogs,
      ],
    }));
    setNotice(`${newPlayer.name} checked in at ${checkIn.tableId}, seat ${seat}.`);
  }

  function handleBuyIn() {
    if (locked) return setNotice("Day is locked. No edits allowed.");
    const parsedAmount = parsePositiveAmount(buyIn.amount);
    if (!parsedAmount.ok) return setNotice(parsedAmount.error);
    const amount = parsedAmount.value;
    const player = players.find((item) => item.id === buyIn.playerId);

    if (!player || player.status !== "ACTIVE") return setNotice("Select an ACTIVE player.");
    if (
      player.type === "CREDIT" &&
      player.creditUsed + pendingBuyInForPlayer(player.id) + amount >
        player.creditLimit
    ) {
      return setNotice("Credit limit exceeded. Approval required before buy-in.");
    }

    requestApproval(
      {
        type: "Buy-in",
        playerId: player.id,
        tableId: player.tableId,
        amount,
        staff: "Cashier Mei",
        cashReceived: player.type === "CASH" ? amount : 0,
        cashPayout: 0,
        note: "Signature optional",
      },
      "Cashier Mei",
    );
  }

  function handleCashOut() {
    if (locked) return setNotice("Day is locked. No edits allowed.");
    const parsedAmount = parsePositiveAmount(cashOut.amount);
    if (!parsedAmount.ok) return setNotice(parsedAmount.error);
    const amount = parsedAmount.value;
    const player = players.find((item) => item.id === cashOut.playerId);

    if (!player || player.status !== "ACTIVE") {
      return setNotice("Select an ACTIVE table player.");
    }
    const hasPendingCashOut = approvals.some(
      (approval) =>
        approval.status === "PENDING" &&
        approval.type === "Cash-out" &&
        approval.playerId === player.id,
    );
    if (hasPendingCashOut) {
      return setNotice("This player already has a pending cash-out approval.");
    }

    requestApproval(
      {
        type: "Cash-out",
        playerId: player.id,
        tableId: player.tableId,
        amount,
        staff: "Cashier Mei",
        cashReceived: 0,
        cashPayout: amount,
        note: `P/L ${money(amount - player.buyIn)}`,
      },
      "Cashier Mei",
    );
  }

  function handleManualTransaction() {
    if (locked) return setNotice("Day is locked. No edits allowed.");
    const parsedStaff = parseRequiredText(manualTx.staff, "Staff");
    if (!parsedStaff.ok) return setNotice(parsedStaff.error);
    const parsedAmount = parsePositiveAmount(manualTx.amount);
    if (!parsedAmount.ok) return setNotice(parsedAmount.error);
    const amount = parsedAmount.value;
    if (!findOpenTable(manualTx.tableId)) {
      return setNotice("Select an OPEN table for manual entries.");
    }
    const isPayout =
      manualTx.type === "Insurance Payout" || manualTx.type === "Cash Payout";

    requestApproval(
      {
        type: manualTx.type,
        playerId: manualTx.playerId,
        tableId: manualTx.tableId,
        amount,
        staff: parsedStaff.value,
        cashReceived: isPayout ? 0 : amount,
        cashPayout: isPayout ? amount : 0,
        note: manualTx.note,
      },
      parsedStaff.value,
    );
  }

  function movePlayer(playerId: string, tableId: string, seat: number) {
    if (locked) return setNotice("Day is locked. No edits allowed.");
    const parsedSeat = parseSeat(String(seat));
    if (!parsedSeat.ok) return setNotice(parsedSeat.error);
    if (!findOpenTable(tableId)) {
      return setNotice("Players can only move to an OPEN table.");
    }
    const movingPlayer = players.find(
      (player) => player.id === playerId && player.status === "ACTIVE",
    );
    if (!movingPlayer) return setNotice("Select an ACTIVE player to move.");
    const occupied = players.some(
      (player) =>
        player.status === "ACTIVE" &&
        player.tableId === tableId &&
        player.seat === parsedSeat.value,
    );
    const tablePlayers = players.filter(
      (player) => player.status === "ACTIVE" && player.tableId === tableId,
    );

    if (occupied) return setNotice("Target seat is occupied.");
    if (tablePlayers.length >= 9) {
      return setNotice("Target table is full. Max 9 players per table.");
    }
    updateStore((current) => ({
      ...current,
      players: current.players.map((player) =>
        player.id === playerId
          ? { ...player, tableId, seat: parsedSeat.value }
          : player,
      ),
      auditLogs: [
        createAuditLog({
          actor: "Floor Manager",
          action: "Moved player",
          entity: playerId,
          reason: "Seat/table transfer",
          before: `${movingPlayer.tableId} seat ${movingPlayer.seat}`,
          after: `${tableId} seat ${parsedSeat.value}`,
        }),
        ...current.auditLogs,
      ],
    }));
    setNotice(`Player moved to ${tableId}, seat ${parsedSeat.value}.`);
  }

  function refreshCredit() {
    if (locked) return setNotice("Day is locked. No edits allowed.");
    updateStore((current) => ({
      ...current,
      players: current.players.map((player) =>
        player.type === "CREDIT" ? { ...player, creditUsed: 0 } : player,
      ),
      auditLogs: [
        createAuditLog({
          actor: "Manager/Admin",
          action: "Refreshed credit",
          entity: "CREDIT players",
          reason: "Next-day refresh sample",
          after: "creditUsed reset to 0",
        }),
        ...current.auditLogs,
      ],
    }));
    setNotice("Credit refreshed for CREDIT players only.");
  }

  function requestCorrection(transactionId: string) {
    const transaction = transactions.find((tx) => tx.id === transactionId);
    if (!transaction) return setNotice("Transaction not found.");

    updateStore((current) => ({
      ...current,
      auditLogs: [
        createAuditLog({
          actor: "Cashier Mei",
          action: "Requested correction",
          entity: transaction.id,
          reason: "Post-approval correction requires manager review",
          before: `${transaction.type} ${money(transaction.amount)}`,
          after: "Correction pending review",
        }),
        ...current.auditLogs,
      ],
    }));
    setNotice(`Correction requested for ${transaction.id}.`);
  }

  function downloadReport() {
    const rows = [
      ["Metric", "Amount"],
      ["Buy-in", totals.buyInTotal],
      ["Cash-out", totals.cashOutTotal],
      ["Rake", totals.rake],
      ["Tips", totals.tips],
      ["Insurance", totals.insurance],
      ["Jackpot", totals.jackpot],
      ["Cash received", totals.cashReceived],
      ["Cash payout", totals.cashPayout],
      ["Variance", totals.variance],
      [],
      ["Player", "Buy-in", "Cash-out", "P/L", "Duration"],
      ...players.map((player) => [
        player.name,
        player.buyIn,
        player.cashOut,
        player.cashOut - player.buyIn,
        durationLabel(minutesBetween(player.sessionStart, player.sessionEnd)),
      ]),
    ];
    const url = URL.createObjectURL(
      new Blob([toCsv(rows)], {
        type: "text/csv",
      }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "daily-close-sample.csv";
    anchor.click();
    URL.revokeObjectURL(url);
    setNotice("Daily close sample exported.");
  }

  function resetApprovals() {
    updateStore(() => createInitialPokerStore());
  }

  return {
    players,
    tables,
    transactions,
    approvals,
    auditLogs,
    notifications,
    activePlayers,
    pendingApprovals,
    filteredPlayers,
    totals,
    playerSearch,
    setPlayerSearch,
    notice,
    locked,
    setLocked,
    checkIn,
    setCheckIn,
    buyIn,
    setBuyIn,
    cashOut,
    setCashOut,
    manualTx,
    setManualTx,
    decideApproval,
    handleCheckIn,
    handleBuyIn,
    handleCashOut,
    handleManualTransaction,
    movePlayer,
    refreshCredit,
    requestCorrection,
    downloadReport,
    resetApprovals,
  };
}

export type PokerManagementState = ReturnType<typeof usePokerManagementState>;
