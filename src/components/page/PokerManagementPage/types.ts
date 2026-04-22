import type React from "react";

export type ModuleKey =
  | "dashboard"
  | "players"
  | "tables"
  | "transactions"
  | "reports"
  | "admin";

export type PlayerType = "CASH" | "CREDIT";
export type PlayerTag = "VIP" | "Risk" | "Banned";
export type ApprovalLevel = "MANAGER" | "ADMIN" | "DUAL";

export type TxType =
  | "Buy-in"
  | "Cash-out"
  | "Rake"
  | "Tips"
  | "Insurance Premium"
  | "Insurance Payout"
  | "Jackpot"
  | "Cash Received"
  | "Cash Payout";

export type Player = {
  id: string;
  name: string;
  phone: string;
  type: PlayerType;
  creditLimit: number;
  creditUsed: number;
  tags: PlayerTag[];
  status: "ACTIVE" | "OUT";
  tableId?: string;
  seat?: number;
  sessionStart?: string;
  sessionEnd?: string;
  buyIn: number;
  cashOut: number;
};

export type PokerTable = {
  id: string;
  name: string;
  status: "OPEN" | "CLOSED";
  dealer: string;
  rake: number;
  insurance: number;
  jackpot: number;
};

export type Transaction = {
  id: string;
  type: TxType;
  playerId?: string;
  tableId?: string;
  amount: number;
  staff: string;
  cashReceived: number;
  cashPayout: number;
  time: string;
  note: string;
};

export type ApprovalRequest = Omit<Transaction, "id" | "time"> & {
  id: string;
  status: "PENDING" | "APPROVED" | "REJECTED";
  approvalLevel: ApprovalLevel;
  riskReason: string;
  requestedBy: string;
  createdAt: string;
  decidedBy?: string;
};

export type AuditLog = {
  id: string;
  time: string;
  actor: string;
  action: string;
  entity: string;
  reason: string;
  before?: string;
  after?: string;
};

export type NotificationItem = {
  id: string;
  title: string;
  body: string;
  tone: "info" | "warning" | "success" | "destructive";
  action?: string;
};

export type Totals = {
  buyInTotal: number;
  cashOutTotal: number;
  rake: number;
  insurance: number;
  jackpot: number;
  tips: number;
  cashReceived: number;
  cashPayout: number;
  variance: number;
};

export type CheckInForm = {
  name: string;
  phone: string;
  type: PlayerType;
  creditLimit: string;
  tableId: string;
  seat: string;
  tag: PlayerTag;
};

export type BuyInForm = {
  playerId: string;
  amount: string;
};

export type CashOutForm = {
  playerId: string;
  amount: string;
};

export type ManualTxForm = {
  type: TxType;
  tableId: string;
  playerId: string;
  amount: string;
  staff: string;
  note: string;
};

export type SetState<T> = React.Dispatch<React.SetStateAction<T>>;

export type PokerManagementStore = {
  players: Player[];
  tables: PokerTable[];
  transactions: Transaction[];
  approvals: ApprovalRequest[];
  auditLogs: AuditLog[];
  locked: boolean;
};
