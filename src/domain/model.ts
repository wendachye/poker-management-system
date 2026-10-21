export type Role = "DEALER" | "CASHIER" | "MANAGER" | "ADMIN";
export type Staff = {
  id: string;
  username: string;
  role: Role;
  branchId: string;
};
export type Branch = { id: string; name: string; timezone: string; role: Role };
export type VenueSettings = {
  setupCompleted: boolean;
  venueName: string;
  timezone: string;
  gameType: "TEXAS_HOLDEM" | "POT_LIMIT_OMAHA" | "OTHER";
  gameName: string;
  smallBlind: number;
  bigBlind: number;
  minBuyIn: number;
  maxBuyIn: number;
  /** Zero permits any integer-sen amount. */
  buyInStep: number;
  tipsEnabled: boolean;
  rakeEnabled: boolean;
  insuranceEnabled: boolean;
  jackpotEnabled: boolean;
  creditEnabled: boolean;
  /** Manual collection guidance; ledger amounts remain explicitly entered. */
  rakePercent: number;
  rakeCap: number;
  tipsPolicy: string;
  houseRules: string;
};
export type PlayerType = "CASH" | "CREDIT";
export type PlayerTag = "VIP" | "Risk" | "Banned";
export type ApprovalLevel = "MANAGER" | "ADMIN" | "DUAL";
export type EntryType =
  | "Buy-in"
  | "Cash-out"
  | "Rake"
  | "Tips"
  | "Insurance Premium"
  | "Insurance Payout"
  | "Jackpot Contribution"
  | "Jackpot Payout"
  | "Cash Received"
  | "Cash Payout"
  | "Credit Repayment";
export type TxType = EntryType | "Reversal";
export type Profile = {
  id: string;
  name: string;
  phone: string;
  type: PlayerType;
  creditLimit: number;
  tags: PlayerTag[];
};
export type Session = {
  id: string;
  playerId: string;
  dayId: string;
  status: "ACTIVE" | "OUT";
  tableId: string;
  seat: number;
  sessionStart: string;
  sessionEnd?: string;
};
export type Player = Profile & {
  creditUsed: number;
  status: "ACTIVE" | "OUT";
  tableId?: string;
  seat?: number;
  sessionId?: string;
  sessionStart?: string;
  sessionEnd?: string;
  buyIn: number;
  cashOut: number;
};
export type TableRecord = {
  id: string;
  name: string;
  status: "OPEN" | "CLOSED";
  dealer: string;
  /** Omitted values inherit venue rules. Blinds are overridden together. */
  smallBlind?: number;
  bigBlind?: number;
  minBuyIn?: number;
  maxBuyIn?: number;
  buyInStep?: number;
};
export type PokerTable = TableRecord & {
  rake: number;
  insurance: number;
  jackpot: number;
};
export type Transaction = {
  id: string;
  dayId: string;
  type: TxType;
  playerId?: string;
  sessionId?: string;
  tableId?: string;
  amount: number;
  staff: string;
  staffId: string;
  cashReceived: number;
  cashPayout: number;
  creditDelta: number;
  time: string;
  note: string;
  reversesId?: string;
  approvalId: string;
};
export type ApprovalRequest = {
  id: string;
  dayId: string;
  type: TxType;
  amount: number;
  playerId?: string;
  sessionId?: string;
  tableId?: string;
  staff: string;
  note: string;
  status: "PENDING" | "APPROVED" | "REJECTED";
  approvalLevel: ApprovalLevel;
  riskReason: string;
  requestedBy: string;
  requestedById: string;
  createdAt: string;
  decidedBy?: string;
  decidedAt?: string;
  rejectionReason?: string;
  reversesId?: string;
  votes: { staffId: string; username: string; role: Role; time: string }[];
};
export type AuditLog = {
  id: string;
  time: string;
  actor: string;
  actorId: string;
  action: string;
  entity: string;
  reason: string;
  before?: string;
  after?: string;
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
  openingCash: number;
  expectedCash: number;
  countedCash: number | null;
  variance: number | null;
};
export type Day = {
  id: string;
  date: string;
  openedAt: string;
  openingCash: number;
  status: "OPEN" | "CLOSED";
  closes: {
    time: string;
    actor: string;
    countedCash: number;
    expectedCash: number;
    variance: number;
    reason: string;
  }[];
};
export type Store = {
  schemaVersion: 1;
  settings?: VenueSettings;
  profiles: Profile[];
  sessions: Session[];
  tables: TableRecord[];
  transactions: Transaction[];
  approvals: ApprovalRequest[];
  auditLogs: AuditLog[];
  days: Day[];
  currentDayId: string | null;
};
export type Snapshot = {
  revision: number;
  branch: Branch;
  user: Staff;
  store: Store;
};
export type NotificationItem = {
  id: string;
  title: string;
  body: string;
  tone: "info" | "warning" | "success" | "destructive";
  action?: string;
};
