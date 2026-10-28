import type { Player, PokerTable, Store, Totals, Transaction } from "./model";

export function emptyStore(): Store {
  return {
    schemaVersion: 1,
    profiles: [],
    sessions: [],
    tables: [],
    transactions: [],
    approvals: [],
    auditLogs: [],
    days: [],
    currentDayId: null,
  };
}
export function currentDay(store: Store) {
  return store.days.find((day) => day.id === store.currentDayId);
}
export function entryType(store: Store, tx: Transaction) {
  return tx.reversesId
    ? store.transactions.find((original) => original.id === tx.reversesId)?.type
    : tx.type;
}
export function debt(store: Store, playerId: string) {
  if (store.readModel) {
    const value = store.readModel.balances[playerId];
    if (value === undefined)
      throw new Error(
        "Player balance is not loaded. Refresh records before continuing.",
      );
    return value;
  }
  return store.transactions
    .filter((tx) => tx.playerId === playerId)
    .reduce((sum, tx) => sum + tx.creditDelta, 0);
}
export function playersForDay(
  store: Store,
  dayId = store.currentDayId,
): Player[] {
  return store.profiles.map((profile) => {
    const sessions = store.sessions.filter(
      (session) => session.playerId === profile.id && session.dayId === dayId,
    );
    const latest = sessions.at(-1);
    const transactions = store.transactions.filter(
      (tx) => tx.playerId === profile.id && tx.dayId === dayId,
    );
    return {
      ...profile,
      creditUsed: debt(store, profile.id),
      status: latest?.status ?? "OUT",
      sessionId: latest?.id,
      tableId: latest?.status === "ACTIVE" ? latest.tableId : undefined,
      seat: latest?.status === "ACTIVE" ? latest.seat : undefined,
      sessionStart: latest?.sessionStart,
      sessionEnd: latest?.sessionEnd,
      buyIn: store.readModel
        ? (store.readModel.playerDay[`${dayId}:${profile.id}`]?.buyIn ?? 0)
        : transactions
            .filter((tx) => entryType(store, tx) === "Buy-in")
            .reduce((sum, tx) => sum + tx.amount, 0),
      cashOut: store.readModel
        ? (store.readModel.playerDay[`${dayId}:${profile.id}`]?.cashOut ?? 0)
        : transactions
            .filter((tx) => entryType(store, tx) === "Cash-out")
            .reduce((sum, tx) => sum + tx.amount, 0),
    };
  });
}
export function totalsForDay(store: Store, dayId = store.currentDayId): Totals {
  if (store.readModel && dayId) {
    const totals = store.readModel.totals[dayId];
    if (!totals)
      throw new Error(
        "Business day totals are not loaded. Refresh records before continuing.",
      );
    return totals;
  }
  const day = store.days.find((value) => value.id === dayId);
  const transactions = store.transactions.filter((tx) => tx.dayId === dayId);
  const sum = (...types: string[]) =>
    transactions
      .filter((tx) => types.includes(entryType(store, tx) ?? ""))
      .reduce((total, tx) => total + tx.amount, 0);
  const cashReceived = transactions.reduce(
    (total, tx) => total + tx.cashReceived,
    0,
  );
  const cashPayout = transactions.reduce(
    (total, tx) => total + tx.cashPayout,
    0,
  );
  const expectedCash = (day?.openingCash ?? 0) + cashReceived - cashPayout;
  const countedCash =
    day?.status === "CLOSED" ? (day.closes.at(-1)?.countedCash ?? null) : null;
  return {
    buyInTotal: sum("Buy-in"),
    cashOutTotal: sum("Cash-out"),
    rake: sum("Rake"),
    tips: sum("Tips"),
    insurance: sum("Insurance Premium") - sum("Insurance Payout"),
    jackpot: sum("Jackpot Contribution") - sum("Jackpot Payout"),
    cashReceived,
    cashPayout,
    openingCash: day?.openingCash ?? 0,
    expectedCash,
    countedCash,
    variance: countedCash === null ? null : countedCash - expectedCash,
  };
}
export function tablesForDay(
  store: Store,
  dayId = store.currentDayId,
): PokerTable[] {
  return store.tables.map((table) => {
    const saved = store.readModel?.tableTotals[table.id];
    if (saved && dayId === store.currentDayId) return { ...table, ...saved };
    const local = {
      ...store,
      transactions: store.transactions.filter((tx) => tx.tableId === table.id),
    };
    const totals = totalsForDay(local, dayId);
    return {
      ...table,
      rake: totals.rake,
      insurance: totals.insurance,
      jackpot: totals.jackpot,
    };
  });
}
