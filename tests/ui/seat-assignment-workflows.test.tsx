import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
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

Object.defineProperty(globalThis, "CSS", {
  configurable: true,
  value: {
    escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "\\$&"),
  },
});
afterEach(cleanup);

const now = "2026-11-04T03:00:00Z";

function fixture() {
  const admin: Staff = {
    id: "seat-admin",
    username: "Seat admin",
    role: "ADMIN",
    branchId: "seat-venue",
  };
  let store = configuredStore();
  const run = (command: Command, actor = admin) => {
    store = applyCommand(store, command, actor, now);
  };
  run({ kind: "OPEN_DAY", date: "2026-11-04", openingCash: 100000 });
  for (const name of [
    "Sample · Main floor",
    "Sample · Lounge",
    "Sample · Reserve",
  ])
    run({ kind: "TABLE", name, dealer: "", status: "OPEN" });
  run({ kind: "TABLE", name: "Closed room", dealer: "", status: "CLOSED" });
  const [main, lounge, reserve, closed] = store.tables;
  for (const [name, phone, tableId, seat] of [
    ["Sample · Occupant One", "+12025550101", main.id, 1],
    ["Sample · Occupant Two", "+12025550102", main.id, 2],
    ["Sample · Lounge Guest", "+12025550103", lounge.id, 3],
  ] as const)
    run({
      kind: "CHECK_IN",
      name,
      phone,
      tableId,
      seat,
      type: "CASH",
      creditLimit: 0,
      tags: [],
    });
  store.profiles.push({
    id: "returning-guest",
    name: "Sample · Returning Guest",
    phone: "+12025550220",
    type: "CASH",
    creditLimit: 0,
    tags: [],
  });
  const firstId = store.profiles.find(
    (entry) => entry.phone === "+12025550101",
  )!.id;
  const secondId = store.profiles.find(
    (entry) => entry.phone === "+12025550102",
  )!.id;
  const submissions: Command[] = [];
  const continuations: unknown[] = [];
  const data = {
    get store() {
      return store;
    },
    run,
    admin,
    main,
    lounge,
    reserve,
    closed,
    firstId,
    secondId,
    submissions,
    continuations,
    submit(command: Command) {
      submissions.push(command);
      run(command);
      return true;
    },
  };
  return data;
}

function Harness({
  data,
  operation,
  role = "ADMIN",
  busy = false,
  retryRequired = false,
}: {
  data: ReturnType<typeof fixture>;
  operation: Operation;
  role?: Staff["role"];
  busy?: boolean;
  retryRequired?: boolean;
}) {
  const user = { ...data.admin, role };
  const store = data.store;
  const players = playersForDay(store);
  const snapshot: Snapshot = {
    revision: 1,
    branch: {
      id: user.branchId,
      name: "Seat sample venue",
      timezone: "Asia/Kuala_Lumpur",
      role,
    },
    user,
    store,
  };
  const state = {
    operation,
    snapshot,
    store,
    user,
    day: store.days[0],
    players,
    tables: tablesForDay(store),
    activePlayers: players.filter((player) => player.status === "ACTIVE"),
    pendingApprovals: store.approvals.filter(
      (request) => request.status === "PENDING",
    ),
    locked: false,
    busy,
    retryRequired,
    error: "",
    setError() {},
    closeOperation() {},
    focusRead: async () => {},
    registerRead: () => () => {},
    readGeneration: 0,
    read: async () => ({
      items: players,
      total: players.length,
      page: 0,
      pageSize: 20,
      context: snapshot,
    }),
    submit: async (command: Command) => data.submit(command),
    finishCheckIn: (...args: unknown[]) => data.continuations.push(args),
    withReviewedRevision: async (_revision: unknown, save: () => unknown) =>
      save(),
  } as unknown as PokerManagementState;
  return (
    <NextIntlClientProvider
      locale="en"
      timeZone="Asia/Kuala_Lumpur"
      messages={{}}
    >
      <PokerManagementContext.Provider value={state}>
        <OperationDialogs />
      </PokerManagementContext.Provider>
    </NextIntlClientProvider>
  );
}

function setup(operation: (data: ReturnType<typeof fixture>) => Operation) {
  const data = fixture();
  const initial = operation(data);
  const view = render(<Harness data={data} operation={initial} />);
  return { data, initial, view };
}
function seat(number: number) {
  return within(screen.getByRole("radiogroup", { name: "Seat" })).getByRole(
    "radio",
    { name: new RegExp(`Seat ${number}(?: | ·|$)`) },
  );
}
function checkInFooter() {
  return screen
    .getByRole("dialog", { name: "Check in player" })
    .querySelector<HTMLElement>('[data-slot="dialog-footer"]')!;
}

test("check-in confirmation appears only on the seat step and follows player and destination changes", async () => {
  const user = userEvent.setup();
  const { data } = setup(() => ({ kind: "check-in" }));
  assert.equal(checkInFooter().querySelector("[aria-live]"), null);
  await user.click(screen.getByRole("tab", { name: "New player" }));
  await user.type(
    screen.getByRole("textbox", { name: /Player name/ }),
    "Sample · Draft Guest",
  );
  await user.type(
    screen.getByRole("textbox", { name: /Phone/ }),
    "+12025550700",
  );
  await waitFor(() =>
    assert.equal(
      (screen.getByRole("button", { name: "Choose seat" }) as HTMLButtonElement)
        .disabled,
      false,
    ),
  );
  await user.click(screen.getByRole("button", { name: "Choose seat" }));
  assert.ok(within(checkInFooter()).getByText("Draft Guest"));
  assert.ok(within(checkInFooter()).getByText("Select table"));
  assert.doesNotMatch(checkInFooter().textContent!, /Sample ·/);
  await user.click(screen.getByRole("combobox", { name: "Table" }));
  await user.click(screen.getByRole("option", { name: /^Main floor/ }));
  assert.ok(within(checkInFooter()).getByText("Main floor · Select seat"));
  await user.click(seat(4));
  assert.ok(within(checkInFooter()).getByText("Main floor · Seat 4"));
  await user.click(screen.getByRole("combobox", { name: "Table" }));
  await user.click(screen.getByRole("option", { name: /^Lounge/ }));
  assert.ok(within(checkInFooter()).getByText("Lounge · Select seat"));
  assert.equal(within(checkInFooter()).queryByText(/Seat 4/), null);
  await user.click(seat(5));
  assert.ok(within(checkInFooter()).getByText("Lounge · Seat 5"));
  await user.click(screen.getByRole("button", { name: "Change player" }));
  assert.equal(checkInFooter().querySelector("[aria-live]"), null);
  await user.clear(screen.getByRole("textbox", { name: /Player name/ }));
  await user.type(
    screen.getByRole("textbox", { name: /Player name/ }),
    "Sample · Updated Guest",
  );
  await user.click(screen.getByRole("button", { name: "Choose seat" }));
  assert.ok(within(checkInFooter()).getByText("Updated Guest"));
  assert.equal(within(checkInFooter()).queryByText("Draft Guest"), null);
  assert.ok(within(checkInFooter()).getByText("Lounge · Seat 5"));
  assert.equal(
    data.submissions.length,
    0,
    "The summary and draft changes do not post a check-in",
  );
});

test("returning-player confirmation exposes an occupied selection after another staff member takes the seat", async () => {
  const user = userEvent.setup();
  const { data, initial, view } = setup((data) => ({
    kind: "check-in",
    playerId: "returning-guest",
    tableId: data.main.id,
  }));
  assert.ok(within(checkInFooter()).getByText("Returning Guest"));
  assert.ok(within(checkInFooter()).getByText("Main floor · Select seat"));
  await user.click(seat(4));
  data.run({
    kind: "CHECK_IN",
    name: "Other staff guest",
    phone: "+12025550900",
    type: "CASH",
    creditLimit: 0,
    tags: [],
    tableId: data.main.id,
    seat: 4,
  });
  await act(async () => {
    view.rerender(<Harness data={data} operation={initial} />);
  });
  assert.ok(within(checkInFooter()).getByText("Main floor · Seat 4"));
  assert.ok(within(checkInFooter()).getByText("That seat is occupied."));
  assert.equal(
    (
      within(checkInFooter()).getByRole("button", {
        name: "Check in & buy-in",
      }) as HTMLButtonElement
    ).disabled,
    true,
  );
  assert.equal(data.submissions.length, 0);
});

test("visual check-in disables occupied seats and posts the chosen seat and table identity", async () => {
  const user = userEvent.setup();
  const { data } = setup((data) => ({
    kind: "check-in",
    playerId: "returning-guest",
    tableId: data.main.id,
  }));
  assert.equal((seat(1) as HTMLButtonElement).disabled, true);
  assert.match(seat(1).getAttribute("aria-label")!, /Occupant One/);
  await user.click(seat(4));
  assert.equal(seat(4).getAttribute("aria-checked"), "true");
  assert.equal(
    data.submissions.length,
    0,
    "Seat selection only changes the draft",
  );
  await user.click(screen.getByRole("button", { name: "Check in & buy-in" }));
  await waitFor(() => assert.equal(data.submissions.length, 1));
  assert.equal(data.submissions[0].kind, "CHECK_IN");
  assert.equal(
    (data.submissions[0] as Extract<Command, { kind: "CHECK_IN" }>).tableId,
    data.main.id,
  );
  assert.equal(
    (data.submissions[0] as Extract<Command, { kind: "CHECK_IN" }>).seat,
    4,
  );
  assert.ok(
    data.store.sessions.some(
      (session) =>
        session.playerId === "returning-guest" &&
        session.tableId === data.main.id &&
        session.seat === 4,
    ),
  );
  assert.equal(data.continuations.length, 1);
});

test("check-in requires a seat and explicit table changes clear the previous choice", async () => {
  const user = userEvent.setup();
  const { data } = setup((data) => ({
    kind: "check-in",
    playerId: "returning-guest",
    tableId: data.main.id,
  }));
  await user.click(screen.getByRole("button", { name: "Check in & buy-in" }));
  assert.equal(data.submissions.length, 0);
  assert.equal(
    screen
      .getByRole("radiogroup", { name: "Seat" })
      .getAttribute("aria-invalid"),
    "true",
  );
  await waitFor(() =>
    assert.ok(
      screen
        .getByRole("radiogroup", { name: "Seat" })
        .contains(document.activeElement),
    ),
  );
  await user.click(seat(4));
  await user.click(screen.getByRole("combobox", { name: "Table" }));
  await user.click(screen.getByRole("option", { name: /^Lounge/ }));
  assert.equal(
    screen.getByRole("radiogroup", { name: "Seat" }).getAttribute("data-value"),
    "",
  );
  assert.equal((seat(3) as HTMLButtonElement).disabled, true);
  await user.click(screen.getByRole("button", { name: "Check in & buy-in" }));
  assert.equal(data.submissions.length, 0);
});

test("an occupied seat arriving during check-in loses control validity and blocks saving", async () => {
  const user = userEvent.setup();
  const { data, initial, view } = setup((data) => ({
    kind: "check-in",
    playerId: "returning-guest",
    tableId: data.main.id,
  }));
  await user.click(seat(4));
  data.run({
    kind: "CHECK_IN",
    name: "Other staff guest",
    phone: "+12025550900",
    type: "CASH",
    creditLimit: 0,
    tags: [],
    tableId: data.main.id,
    seat: 4,
  });
  await act(async () => {
    view.rerender(<Harness data={data} operation={initial} />);
  });
  assert.equal(
    screen.getByRole("radiogroup", { name: "Seat" }).getAttribute("data-value"),
    "",
  );
  assert.equal((seat(4) as HTMLButtonElement).disabled, true);
  assert.ok(
    within(screen.getByRole("alert")).getByText("That seat is occupied."),
  );
  assert.equal(
    (
      screen.getByRole("button", {
        name: "Check in & buy-in",
      }) as HTMLButtonElement
    ).disabled,
    true,
  );
  fireEvent.submit(
    screen.getByRole("radiogroup", { name: "Seat" }).closest("form")!,
  );
  await waitFor(() => assert.equal(data.submissions.length, 0));
});

test("visual move marks the current seat, disables occupants and posts the selected destination", async () => {
  const user = userEvent.setup();
  const { data } = setup((data) => ({ kind: "move", playerId: data.firstId }));
  assert.ok(
    screen.getByRole("dialog", {
      name: "Move player",
      description: /Occupant One · Current seat: Main floor · Seat 1/,
    }),
  );
  assert.equal((seat(1) as HTMLButtonElement).disabled, true);
  assert.match(seat(1).getAttribute("aria-label")!, /Current seat/);
  assert.equal((seat(2) as HTMLButtonElement).disabled, true);
  await user.click(seat(5));
  assert.equal(
    data.submissions.length,
    0,
    "Choosing a destination does not submit a move",
  );
  await user.click(screen.getByRole("button", { name: "Move player" }));
  await waitFor(() => assert.equal(data.submissions.length, 1));
  assert.deepEqual(data.submissions[0], {
    kind: "MOVE",
    playerId: data.firstId,
    tableId: data.main.id,
    seat: 5,
  });
  assert.equal(
    data.store.sessions.find((session) => session.playerId === data.firstId)!
      .seat,
    5,
  );
});

test("changing the moving player or destination requires a fresh visual seat choice", async () => {
  const user = userEvent.setup();
  const { data } = setup((data) => ({ kind: "move", playerId: data.firstId }));
  await user.click(seat(4));
  await user.click(screen.getByRole("combobox", { name: "Player" }));
  await user.click(screen.getByRole("option", { name: /Occupant Two/ }));
  assert.equal(
    screen.getByRole("radiogroup", { name: "Seat" }).getAttribute("data-value"),
    "",
  );
  await user.click(seat(4));
  await user.click(screen.getByRole("combobox", { name: "Destination table" }));
  await user.click(screen.getByRole("option", { name: /^Lounge/ }));
  assert.equal(
    screen.getByRole("radiogroup", { name: "Seat" }).getAttribute("data-value"),
    "",
  );
  assert.equal((seat(3) as HTMLButtonElement).disabled, true);
  assert.equal(data.submissions.length, 0);
});

test("a visual move to another table keeps balances and ledger entries unchanged", async () => {
  const user = userEvent.setup();
  const { data } = setup((data) => ({ kind: "move", playerId: data.firstId }));
  const before = playersForDay(data.store).find(
    (player) => player.id === data.firstId,
  )!;
  const previousBalances = [before.buyIn, before.cashOut, before.creditUsed];
  const ledgerCount = data.store.transactions.length;
  const requestCount = data.store.approvals.length;
  await user.click(screen.getByRole("combobox", { name: "Destination table" }));
  await user.click(screen.getByRole("option", { name: /^Lounge/ }));
  assert.equal((seat(3) as HTMLButtonElement).disabled, true);
  await user.click(seat(4));
  assert.equal(data.submissions.length, 0);
  await user.click(screen.getByRole("button", { name: "Move player" }));
  await waitFor(() => assert.equal(data.submissions.length, 1));
  assert.deepEqual(data.submissions[0], {
    kind: "MOVE",
    playerId: data.firstId,
    tableId: data.lounge.id,
    seat: 4,
  });
  const after = playersForDay(data.store).find(
    (player) => player.id === data.firstId,
  )!;
  assert.equal(after.tableId, data.lounge.id);
  assert.equal(after.seat, 4);
  assert.deepEqual(
    [after.buyIn, after.cashOut, after.creditUsed],
    previousBalances,
  );
  assert.equal(data.store.transactions.length, ledgerCount);
  assert.equal(data.store.approvals.length, requestCount);
});

test("pending requests and read-only roles block visual moves", async () => {
  const data = fixture();
  const cashier: Staff = { ...data.admin, id: "seat-cashier", role: "CASHIER" };
  data.run(
    {
      kind: "REQUEST",
      type: "Buy-in",
      amount: 50000,
      playerId: data.firstId,
      tableId: data.main.id,
      note: "Owned fixture",
    },
    cashier,
  );
  const view = render(
    <Harness
      data={data}
      operation={{ kind: "move", playerId: data.firstId }}
    />,
  );
  assert.ok(screen.getByText("Resolve pending request first"));
  assert.ok(
    screen
      .getAllByRole("radio")
      .every((radio) => (radio as HTMLButtonElement).disabled),
  );
  assert.equal(
    (screen.getByRole("button", { name: "Move player" }) as HTMLButtonElement)
      .disabled,
    true,
  );
  view.rerender(
    <Harness
      data={data}
      operation={{ kind: "move", playerId: data.firstId }}
      role="DEALER"
    />,
  );
  assert.ok(
    screen
      .getAllByRole("radio")
      .every((radio) => (radio as HTMLButtonElement).disabled),
  );
  assert.equal(data.submissions.length, 0);
});

test("closed destinations and uncertain writes have no enabled seat actions", () => {
  const data = fixture();
  const initial: Operation = {
    kind: "move",
    playerId: data.firstId,
    tableId: data.closed.id,
    seat: 4,
  };
  const view = render(<Harness data={data} operation={initial} />);
  assert.ok(screen.getByText("Select an open table."));
  assert.ok(
    screen
      .getAllByRole("radio")
      .every((radio) => (radio as HTMLButtonElement).disabled),
  );
  assert.equal(
    (screen.getByRole("button", { name: "Move player" }) as HTMLButtonElement)
      .disabled,
    true,
  );
  view.rerender(<Harness data={data} operation={initial} retryRequired />);
  assert.equal(
    screen.getByRole("radiogroup", { name: "Seat" }).getAttribute("data-value"),
    "",
  );
  assert.ok(
    screen
      .getAllByRole("radio")
      .every((radio) => (radio as HTMLButtonElement).disabled),
  );
  assert.equal(data.submissions.length, 0);
});

test("keyboard seat navigation skips occupants and never auto-submits check-in", async () => {
  const user = userEvent.setup();
  const { data } = setup((data) => ({
    kind: "check-in",
    playerId: "returning-guest",
    tableId: data.main.id,
  }));
  await user.click(seat(3));
  await user.keyboard("{ArrowRight>}");
  await waitFor(() =>
    assert.equal(seat(4).getAttribute("aria-checked"), "true"),
  );
  await user.keyboard("{/ArrowRight}");
  await user.keyboard(" ");
  assert.equal(data.submissions.length, 0);
  await user.keyboard("{Home}");
  await waitFor(() => assert.equal(document.activeElement, seat(3)));
  assert.equal(data.submissions.length, 0);
  assert.equal((seat(1) as HTMLButtonElement).disabled, true);
  assert.equal((seat(2) as HTMLButtonElement).disabled, true);
});
