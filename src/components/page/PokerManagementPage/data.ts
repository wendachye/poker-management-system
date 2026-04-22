import type {
  ApprovalRequest,
  AuditLog,
  BuyInForm,
  CashOutForm,
  CheckInForm,
  ManualTxForm,
  Player,
  PokerTable,
  Transaction,
  TxType,
} from "./types";

export const txTypes: TxType[] = [
  "Rake",
  "Tips",
  "Insurance Premium",
  "Insurance Payout",
  "Jackpot",
  "Cash Received",
  "Cash Payout",
];

export const initialPlayers: Player[] = [
  {
    id: "P-1001",
    name: "Ethan Lim",
    phone: "012-778 4100",
    type: "CREDIT",
    creditLimit: 50000,
    creditUsed: 12000,
    tags: ["VIP"],
    status: "ACTIVE",
    tableId: "T1",
    seat: 3,
    sessionStart: "2026-04-15T00:45:00+08:00",
    buyIn: 12000,
    cashOut: 0,
  },
  {
    id: "P-1002",
    name: "Maya Tan",
    phone: "011-295 8801",
    type: "CASH",
    creditLimit: 0,
    creditUsed: 0,
    tags: ["Risk"],
    status: "ACTIVE",
    tableId: "T1",
    seat: 7,
    sessionStart: "2026-04-15T01:15:00+08:00",
    buyIn: 8000,
    cashOut: 0,
  },
  {
    id: "P-1003",
    name: "Jason Wong",
    phone: "016-201 8122",
    type: "CREDIT",
    creditLimit: 20000,
    creditUsed: 0,
    tags: [],
    status: "OUT",
    sessionStart: "2026-04-14T22:20:00+08:00",
    sessionEnd: "2026-04-15T02:10:00+08:00",
    buyIn: 15000,
    cashOut: 18400,
  },
  {
    id: "P-1004",
    name: "Noah Chew",
    phone: "010-668 3355",
    type: "CASH",
    creditLimit: 0,
    creditUsed: 0,
    tags: ["Banned"],
    status: "OUT",
    buyIn: 0,
    cashOut: 0,
  },
];

export const initialTables: PokerTable[] = [
  {
    id: "T1",
    name: "Table 1",
    status: "OPEN",
    dealer: "Dealer A",
    rake: 2360,
    insurance: 420,
    jackpot: 150,
  },
  {
    id: "T2",
    name: "Table 2",
    status: "OPEN",
    dealer: "Dealer B",
    rake: 1810,
    insurance: -300,
    jackpot: 100,
  },
  {
    id: "T3",
    name: "Table 3",
    status: "CLOSED",
    dealer: "Dealer C",
    rake: 0,
    insurance: 0,
    jackpot: 0,
  },
];

export const initialTransactions: Transaction[] = [
  {
    id: "TX-9001",
    type: "Buy-in",
    playerId: "P-1001",
    tableId: "T1",
    amount: 12000,
    staff: "Cashier Mei",
    cashReceived: 0,
    cashPayout: 0,
    time: "03:02",
    note: "Credit buy-in approved",
  },
  {
    id: "TX-9002",
    type: "Buy-in",
    playerId: "P-1002",
    tableId: "T1",
    amount: 8000,
    staff: "Cashier Mei",
    cashReceived: 8000,
    cashPayout: 0,
    time: "03:10",
    note: "Cash received",
  },
  {
    id: "TX-9003",
    type: "Rake",
    tableId: "T2",
    amount: 360,
    staff: "Dealer B",
    cashReceived: 360,
    cashPayout: 0,
    time: "03:25",
    note: "Hourly rake",
  },
];

export const initialApprovals: ApprovalRequest[] = [
  {
    id: "APR-7001",
    type: "Buy-in",
    playerId: "P-1001",
    tableId: "T1",
    amount: 5000,
    staff: "Cashier Mei",
    cashReceived: 0,
    cashPayout: 0,
    note: "Pending manager approval",
    status: "PENDING",
    approvalLevel: "MANAGER",
    riskReason: "Credit buy-in requires manager approval",
    requestedBy: "Cashier Mei",
    createdAt: "03:28",
  },
];

export const initialAuditLogs: AuditLog[] = [
  {
    id: "LOG-8001",
    time: "03:30",
    actor: "Cashier Mei",
    action: "Requested approval",
    entity: "APR-7001",
    reason: "Credit buy-in",
    after: "PENDING RM 5,000 for Ethan Lim",
  },
  {
    id: "LOG-8002",
    time: "03:25",
    actor: "Dealer B",
    action: "Requested manual entry",
    entity: "TX-9003",
    reason: "Hourly rake",
    after: "Rake RM 360 at T2",
  },
  {
    id: "LOG-8003",
    time: "02:10",
    actor: "Manager/Admin",
    action: "Closed player session",
    entity: "P-1003",
    reason: "Cash-out approved",
    before: "ACTIVE",
    after: "OUT",
  },
];

export const initialCheckIn: CheckInForm = {
  name: "Alicia Ng",
  phone: "017-889 0021",
  type: "CASH",
  creditLimit: "10000",
  tableId: "T2",
  seat: "2",
  tag: "VIP",
};

export const initialBuyIn: BuyInForm = {
  playerId: "P-1001",
  amount: "3000",
};

export const initialCashOut: CashOutForm = {
  playerId: "P-1002",
  amount: "9500",
};

export const initialManualTx: ManualTxForm = {
  type: "Rake",
  tableId: "T1",
  playerId: "P-1001",
  amount: "500",
  staff: "Dealer A",
  note: "Manual entry",
};
