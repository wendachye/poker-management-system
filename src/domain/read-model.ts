import type {
  AuditLog,
  ApprovalRequest,
  Day,
  Player,
  Session,
  Snapshot,
  Totals,
  Transaction,
} from "./model";

export type ReadResource =
  | "players"
  | "requests"
  | "transactions"
  | "audit"
  | "sessions"
  | "player"
  | "receipt"
  | "report"
  | "range";
export type ReadQuery = {
  resource: ReadResource;
  page?: number;
  pageSize?: number;
  query?: string;
  dayId?: string;
  date?: string;
  type?: string;
  status?: string;
  tag?: string;
  staff?: string;
  action?: string;
  from?: string;
  to?: string;
  playerId?: string;
  id?: string;
};
export type ReadItems =
  | Player
  | ApprovalRequest
  | Transaction
  | AuditLog
  | Session
  | (Day & { totals: Totals });
export type ReadPage<T = ReadItems> = {
  branchId: string;
  revision: number;
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  counts: Record<string, number>;
  /** Fresh compact operational state plus only this page's related records. */
  context: Snapshot;
  options?: { staff?: string[]; actions?: string[] };
  day?: Day;
  totals?: Totals;
  report?: import("./reporting").ReportComparison;
};
