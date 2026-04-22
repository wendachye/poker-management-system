import {
  initialApprovals,
  initialAuditLogs,
  initialPlayers,
  initialTables,
  initialTransactions,
} from "./data";
import type { PokerManagementStore } from "./types";

export const pokerStoreStorageKey = "poker-management-store-v1";

export const initialPokerStore: PokerManagementStore = {
  players: initialPlayers,
  tables: initialTables,
  transactions: initialTransactions,
  approvals: initialApprovals,
  auditLogs: initialAuditLogs,
  locked: false,
};

function cloneStore(store: PokerManagementStore): PokerManagementStore {
  return JSON.parse(JSON.stringify(store)) as PokerManagementStore;
}

export function createInitialPokerStore() {
  return cloneStore(initialPokerStore);
}

function isStore(value: unknown): value is PokerManagementStore {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PokerManagementStore>;

  return (
    Array.isArray(candidate.players) &&
    Array.isArray(candidate.tables) &&
    Array.isArray(candidate.transactions) &&
    Array.isArray(candidate.approvals) &&
    typeof candidate.locked === "boolean"
  );
}

function normalizeStore(store: PokerManagementStore): PokerManagementStore {
  return {
    ...store,
    approvals: store.approvals.map((approval) => ({
      ...approval,
      approvalLevel: approval.approvalLevel ?? "MANAGER",
      riskReason: approval.riskReason ?? "Manager approval required",
    })),
    auditLogs: Array.isArray(store.auditLogs) ? store.auditLogs : initialAuditLogs,
  };
}

export function loadPokerStore() {
  if (typeof window === "undefined") return createInitialPokerStore();

  const stored = window.localStorage.getItem(pokerStoreStorageKey);
  if (!stored) return createInitialPokerStore();

  try {
    const parsed = JSON.parse(stored);
    return isStore(parsed) ? normalizeStore(parsed) : createInitialPokerStore();
  } catch {
    return createInitialPokerStore();
  }
}

export function savePokerStore(store: PokerManagementStore) {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(pokerStoreStorageKey, JSON.stringify(store));
  } catch {
    // Local storage can be unavailable or full; API persistence will replace this.
  }
}
