import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { PokerManagementContext } from "../../src/components/page/PokerManagementPage/PokerManagementProvider";
import { OperationDialogs } from "../../src/components/page/PokerManagementPage/components/operation-dialogs";
import type {
  Operation,
  PokerManagementState,
} from "../../src/components/page/PokerManagementPage/usePokerManagementState";
import { applyCommand } from "../../src/domain/operations";
import type { Command } from "../../src/domain/commands";
import type { Snapshot, Staff } from "../../src/domain/model";
import { playersForDay, tablesForDay } from "../../src/domain/selectors";
import { configuredStore } from "../helpers/store";

// JSDOM omits CSS.escape; fixture IDs only need identifier punctuation escaped.
Object.defineProperty(globalThis, "CSS", {
  configurable: true,
  value: {
    escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "\\$&"),
  },
});

afterEach(cleanup);

function fixture(operation: Operation) {
  const admin: Staff = {
    id: "lookup-admin",
    username: "Lookup admin",
    role: "ADMIN",
    branchId: "lookup-venue",
  };
  let store = configuredStore();
  const run = (command: Command) => {
    store = applyCommand(store, command, admin, "2026-11-04T03:00:00Z");
  };
  run({ kind: "OPEN_DAY", date: "2026-11-04", openingCash: 100000 });
  run({
    kind: "TABLE",
    name: "Sample · Main floor",
    dealer: "Taylor",
    status: "OPEN",
  });
  run({
    kind: "TABLE",
    name: "Sample · Reserve",
    dealer: "Morgan",
    status: "OPEN",
    smallBlind: 1000,
    bigBlind: 2500,
  });
  run({ kind: "TABLE", name: "Closed room", dealer: "", status: "CLOSED" });
  const full = store.tables.find(
    (table) => table.name === "Sample · Main floor",
  )!;
  const reserve = store.tables.find(
    (table) => table.name === "Sample · Reserve",
  )!;
  for (let seat = 1; seat <= 9; seat++) {
    run({
      kind: "CHECK_IN",
      name: seat <= 2 ? "Sample · Alex Tan" : `Player ${seat}`,
      phone: `+1202555010${seat}`,
      type: seat === 1 ? "CREDIT" : "CASH",
      creditLimit: seat === 1 ? 1000000 : 0,
      tags: [],
      tableId: full.id,
      seat,
    });
  }
  store.profiles.push({
    id: "returning-player",
    name: "Sample · Returning Guest",
    phone: "+12025550220",
    type: "CASH",
    creditLimit: 0,
    tags: [],
  });
  const players = playersForDay(store);
  const snapshot: Snapshot = {
    revision: 1,
    branch: {
      id: admin.branchId,
      name: "Lookup sample venue",
      timezone: "Asia/Kuala_Lumpur",
      role: admin.role,
    },
    user: admin,
    store,
  };
  const submissions: Command[] = [];
  const state = {
    operation,
    snapshot,
    store,
    user: admin,
    day: store.days[0],
    players,
    tables: tablesForDay(store),
    activePlayers: players.filter((player) => player.status === "ACTIVE"),
    pendingApprovals: [],
    locked: false,
    busy: false,
    error: "",
    retryRequired: false,
    setError() {},
    closeOperation() {},
    focusRead: async () => {},
    registerRead: () => () => {},
    read: async (query: { status?: string }) => {
      const items =
        query.status === "OUT"
          ? players.filter((player) => player.status === "OUT")
          : players;
      return {
        items,
        total: items.length,
        page: 0,
        pageSize: 20,
        context: snapshot,
      };
    },
    submit: async (command: Command) => {
      submissions.push(command);
      return true;
    },
    withReviewedRevision: async (_revision: unknown, save: () => unknown) =>
      save(),
  } as unknown as PokerManagementState;
  return { state, full, reserve, players, submissions };
}

function setup(operation: Operation) {
  const data = fixture(operation);
  render(
    <NextIntlClientProvider
      locale="en"
      timeZone="Asia/Kuala_Lumpur"
      messages={{}}
    >
      <PokerManagementContext.Provider value={data.state}>
        <OperationDialogs />
      </PokerManagementContext.Provider>
    </NextIntlClientProvider>,
  );
  return data;
}

test("check-in table lookup keeps full tables disabled and uses the selected table ID", async () => {
  const user = userEvent.setup();
  const data = setup({ kind: "check-in", playerId: "returning-player" });
  await user.click(screen.getByRole("combobox", { name: "Table" }));
  const full = await screen.findByRole("option", { name: /Main floor/ });
  assert.equal(full.getAttribute("aria-disabled"), "true");
  assert.match(full.textContent!, /0 seats available/);
  assert.equal(screen.queryByRole("option", { name: /Closed room/ }), null);
  await user.type(
    screen.getByRole("combobox", { name: "Search tables" }),
    "Morgan",
  );
  assert.equal(screen.queryByRole("option", { name: /Main floor/ }), null);
  const reserve = screen.getByRole("option", { name: /Reserve/ });
  assert.match(reserve.textContent!, /9 seats available/);
  assert.match(reserve.textContent!, /25\.00/);
  await user.click(reserve);
  const table = screen.getByRole("combobox", { name: "Table" });
  assert.equal(table.getAttribute("data-value"), data.reserve.id);
  assert.equal(table.textContent?.trim(), "Reserve");
  assert.equal(table.getAttribute("aria-required"), "true");
  assert.equal(data.submissions.length, 0);
});

test("move player lookup disambiguates duplicate names and retains phone search and player ID", async () => {
  const user = userEvent.setup();
  const data = setup({ kind: "move" });
  await user.click(screen.getByRole("combobox", { name: "Player" }));
  const options = screen.getAllByRole("option", { name: /Alex Tan/ });
  assert.equal(options.length, 2);
  assert.match(options[0].textContent!, /Main floor.*Seat 1/);
  assert.match(options[1].textContent!, /Main floor.*Seat 2/);
  await user.type(
    screen.getByRole("combobox", { name: "Search by name or phone" }),
    "202-555-0102",
  );
  const selected = screen.getByRole("option", { name: /Alex Tan/ });
  assert.match(selected.textContent!, /\+12025550102/);
  await user.click(selected);
  const player = screen.getByRole("combobox", { name: "Player" });
  assert.equal(player.textContent?.trim(), "Alex Tan");
  assert.equal(
    player.getAttribute("data-value"),
    data.players.find((entry) => entry.phone === "+12025550102")!.id,
  );
  await user.click(screen.getByRole("combobox", { name: "Destination table" }));
  assert.equal(screen.queryByRole("option", { name: /Closed room/ }), null);
  await user.click(screen.getByRole("option", { name: /Reserve/ }));
  assert.equal(
    screen
      .getByRole("combobox", { name: "Destination table" })
      .getAttribute("data-value"),
    data.reserve.id,
  );
  assert.equal(data.submissions.length, 0);
});

test("house cash entry keeps no-table selection optional while offering contextual tables", async () => {
  const user = userEvent.setup();
  const data = setup({ kind: "transaction", type: "Cash Received" });
  const table = screen.getByRole("combobox", { name: /Table/ });
  assert.equal(table.getAttribute("aria-required"), "false");
  assert.equal(table.textContent?.trim(), "House / no table");
  await user.click(table);
  await user.click(screen.getByRole("option", { name: /Reserve/ }));
  assert.equal(table.getAttribute("data-value"), data.reserve.id);
  await user.click(table);
  await user.click(screen.getByRole("option", { name: "House / no table" }));
  assert.equal(table.getAttribute("data-value"), "");
  assert.equal(data.submissions.length, 0);
});
