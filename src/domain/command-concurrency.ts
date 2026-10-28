import type { Command } from "./commands";
import type { Store } from "./model";

/** Keys describe the records reviewed, rather than every venue update. */
export function commandDependencies(store: Store, command: Command): string[] {
  const keys = new Set<string>(["venue:day"]);
  const addPlayer = (id?: string) => {
    if (id) keys.add(`player:${id}`);
  };
  const addTable = (id?: string) => {
    if (id) keys.add(`table:${id}`);
  };
  const addSeat = (tableId: string, seat: number) =>
    keys.add(`seat:${tableId}:${seat}`);
  const addTransaction = (id?: string) => {
    if (!id) return;
    keys.add(`transaction:${id}`);
    keys.add(`reversal:${id}`);
    const tx = store.transactions.find((value) => value.id === id);
    addPlayer(tx?.playerId);
    addTable(tx?.tableId);
    if (tx?.sessionId) {
      const visit = store.sessions.find((value) => value.id === tx.sessionId);
      if (visit) addSeat(visit.tableId, visit.seat);
    }
  };
  switch (command.kind) {
    case "UPDATE_SETTINGS":
      keys.add("venue:settings");
      break;
    case "COMPLETE_SETUP":
      keys.add("venue:all");
      break;
    case "OPEN_DAY":
      keys.add("venue:settings");
      break;
    case "TABLE":
      keys.add("venue:settings");
      addTable(command.tableId);
      break;
    case "UPDATE_PROFILE":
      addPlayer(command.playerId);
      break;
    case "CHECK_IN":
      keys.add("venue:settings");
      keys.add(`phone:${command.phone.replace(/[\s()-]/g, "")}`);
      addPlayer(command.playerId);
      addTable(command.tableId);
      addSeat(command.tableId, command.seat);
      break;
    case "MOVE":
      addPlayer(command.playerId);
      addTable(command.tableId);
      addSeat(command.tableId, command.seat);
      break;
    case "SWAP_SEATS":
      for (const participant of [command.first, command.second]) {
        addPlayer(participant.playerId);
        addTable(participant.tableId);
        addSeat(participant.tableId, participant.seat);
      }
      break;
    case "REQUEST": {
      keys.add("venue:settings");
      addPlayer(command.playerId);
      addTable(command.tableId);
      const visit = store.sessions.find(
        (value) =>
          value.playerId === command.playerId && value.status === "ACTIVE",
      );
      if (command.type === "Buy-in" || command.type === "Cash-out")
        addTable(visit?.tableId);
      break;
    }
    case "CORRECT":
      addTransaction(command.transactionId);
      break;
    case "DECIDE": {
      keys.add("venue:settings");
      keys.add(`approval:${command.approvalId}`);
      const request = store.approvals.find(
        (value) => value.id === command.approvalId,
      );
      addPlayer(request?.playerId);
      addTable(request?.tableId);
      addTransaction(request?.reversesId);
      break;
    }
    case "CLOSE_DAY":
      keys.add("venue:activity");
      break;
    case "REOPEN_DAY":
      break;
  }
  return [...keys].sort();
}

/** Only actual record changes advance dependencies; audit appends do not conflict. */
export function changedDependencyKeys(before: Store, after: Store): string[] {
  const keys = new Set<string>(["venue:all"]);
  function changed<T extends { id: string }>(
    first: T[],
    second: T[],
    mark: (value: T) => void,
  ) {
    const old = new Map(first.map((value) => [value.id, value]));
    for (const value of second)
      if (JSON.stringify(old.get(value.id)) !== JSON.stringify(value)) {
        mark(value);
        const previous = old.get(value.id);
        if (previous) mark(previous);
      }
  }
  if (JSON.stringify(before.settings) !== JSON.stringify(after.settings))
    keys.add("venue:settings");
  if (before.currentDayId !== after.currentDayId) keys.add("venue:day");
  changed(before.days, after.days, () => keys.add("venue:day"));
  changed(before.tables, after.tables, (value) =>
    keys.add(`table:${value.id}`),
  );
  changed(before.profiles, after.profiles, (value) => {
    keys.add(`player:${value.id}`);
    keys.add(`phone:${value.phone}`);
  });
  changed(before.sessions, after.sessions, (value) => {
    keys.add(`player:${value.playerId}`);
    keys.add(`seat:${value.tableId}:${value.seat}`);
    keys.add("venue:activity");
  });
  changed(before.approvals, after.approvals, (value) => {
    keys.add(`approval:${value.id}`);
    if (value.playerId) keys.add(`player:${value.playerId}`);
    if (value.reversesId) keys.add(`reversal:${value.reversesId}`);
    keys.add("venue:activity");
  });
  changed(before.transactions, after.transactions, (value) => {
    keys.add(`transaction:${value.id}`);
    if (value.playerId) keys.add(`player:${value.playerId}`);
    if (value.reversesId) keys.add(`reversal:${value.reversesId}`);
    keys.add("venue:activity");
  });
  return [...keys].sort();
}
