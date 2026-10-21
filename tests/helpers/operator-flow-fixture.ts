import type { Command } from "../../src/domain/commands";
import type { EntryType, Staff, Store } from "../../src/domain/model";
import { applyCommand } from "../../src/domain/operations";

/** A small, disposable shift built through the same rules used by operators. */
export function operatorFlowFixture(configured: Store): Store {
  const actors = {
    cashier: {
      id: "qa.cashier",
      username: "qa.cashier",
      role: "CASHIER",
      branchId: "qa",
    },
    manager: {
      id: "qa.manager",
      username: "qa.manager",
      role: "MANAGER",
      branchId: "qa",
    },
    admin: {
      id: "qa.admin",
      username: "qa.admin",
      role: "ADMIN",
      branchId: "qa",
    },
  } satisfies Record<string, Staff>;
  let store = structuredClone(configured);
  let cursor = Date.parse("2026-10-21T01:00:00.000Z");
  const run = (command: Command, actor: Staff = actors.cashier) => {
    cursor += 30_000;
    store = applyCommand(store, command, actor, new Date(cursor).toISOString());
  };
  const main = store.tables.find((table) => table.name === "Main floor")!;
  const reserve = store.tables.find((table) => table.name === "Reserve")!;
  if (!main || !reserve)
    throw new Error(
      "The operator fixture requires its configured test tables.",
    );

  run(
    { kind: "OPEN_DAY", date: "2026-10-21", openingCash: 1_000_000 },
    actors.manager,
  );

  function checkIn(
    name: string,
    phone: string,
    type: "CASH" | "CREDIT",
    tableId: string,
    seat: number,
  ) {
    run(
      {
        kind: "CHECK_IN",
        name,
        phone,
        type,
        creditLimit: type === "CREDIT" ? 500_000 : 0,
        tags: [],
        tableId,
        seat,
      },
      type === "CREDIT" ? actors.manager : actors.cashier,
    );
    return store.profiles.find((player) => player.phone === phone)!.id;
  }
  function request(type: EntryType, amount: number, playerId: string) {
    run({
      kind: "REQUEST",
      type,
      amount,
      playerId,
      note: "Disposable operator workflow example",
    });
    return store.approvals[0].id;
  }
  function post(type: EntryType, amount: number, playerId: string) {
    run(
      {
        kind: "DECIDE",
        approvalId: request(type, amount, playerId),
        decision: "APPROVED",
      },
      actors.admin,
    );
  }

  const returningCash = checkIn("Alex Tan", "+12025550901", "CASH", main.id, 1);
  post("Buy-in", 50_000, returningCash);
  post("Cash-out", 50_000, returningCash);

  const returningCredit = checkIn(
    "Mei Lim",
    "+12025550902",
    "CREDIT",
    main.id,
    1,
  );
  post("Buy-in", 50_000, returningCredit);
  post("Cash-out", 0, returningCredit);

  const activeCash = checkIn("Arjun Rao", "+12025550903", "CASH", main.id, 1);
  post("Buy-in", 50_000, activeCash);

  const activeCredit = checkIn(
    "Sara Lee",
    "+12025550904",
    "CREDIT",
    reserve.id,
    1,
  );
  post("Buy-in", 50_000, activeCredit);
  request("Buy-in", 50_000, activeCash);
  return store;
}
