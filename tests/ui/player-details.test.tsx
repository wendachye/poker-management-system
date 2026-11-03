import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { useState } from "react";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { PlayerDetails } from "../../src/components/page/PokerManagementPage/components/player-details";
import { PokerManagementContext } from "../../src/components/page/PokerManagementPage/PokerManagementProvider";
import type { PokerManagementState } from "../../src/components/page/PokerManagementPage/usePokerManagementState";
import { useListDrafts } from "../../src/components/page/PokerManagementPage/components/use-list-drafts";
import { applyCommand } from "../../src/domain/operations";
import type { Command } from "../../src/domain/commands";
import type { Snapshot, Staff } from "../../src/domain/model";
import type { ReadQuery } from "../../src/domain/read-model";
import { playersForDay, tablesForDay } from "../../src/domain/selectors";
import { readPageReceipt } from "../../src/lib/read-page";
import { configuredStore } from "../helpers/store";

beforeEach(() => {
  Object.defineProperty(globalThis, "self", {
    configurable: true,
    writable: true,
    value: window,
  });
  window.history.replaceState(null, "", "/en/players");
  window.sessionStorage.clear();
});
afterEach(cleanup);

function fixture() {
  const admin: Staff = {
    id: "details-admin",
    username: "Details admin",
    role: "ADMIN",
    branchId: "details-venue",
  };
  const cashier: Staff = {
    ...admin,
    id: "details-cashier",
    username: "Details cashier",
    role: "CASHIER",
  };
  let store = configuredStore();
  const run = (command: Command, actor = admin) => {
    store = applyCommand(store, command, actor, "2026-11-04T02:00:00Z");
  };
  run({ kind: "OPEN_DAY", date: "2026-11-04", openingCash: 100000 });
  run({ kind: "TABLE", name: "Details table", dealer: "", status: "OPEN" });
  run({
    kind: "CHECK_IN",
    name: "Credit sample",
    phone: "+12025550101",
    type: "CREDIT",
    creditLimit: 100000,
    tags: [],
    tableId: store.tables[0].id,
    seat: 1,
  });
  const creditId = store.profiles[0].id;
  const request = (
    type: "Buy-in" | "Cash-out",
    playerId: string,
    amount: number,
    approve = true,
  ) => {
    run(
      {
        kind: "REQUEST",
        type,
        playerId,
        tableId: store.tables[0].id,
        amount,
        note: "Fictional details fixture",
      },
      cashier,
    );
    if (approve)
      run({
        kind: "DECIDE",
        approvalId: store.approvals.find(
          (entry) =>
            entry.playerId === playerId &&
            entry.type === type &&
            entry.status === "PENDING",
        )!.id,
        decision: "APPROVED",
      });
  };
  request("Buy-in", creditId, 30000);
  request("Buy-in", creditId, 20000, false);
  run({
    kind: "CHECK_IN",
    name: "Cash sample",
    phone: "+12025550102",
    type: "CASH",
    creditLimit: 0,
    tags: [],
    tableId: store.tables[0].id,
    seat: 2,
  });
  const cashId = store.profiles[1].id;
  request("Buy-in", cashId, 50000);
  request("Cash-out", cashId, 70000);
  const snapshot: Snapshot = {
    revision: 1,
    branch: {
      id: admin.branchId,
      name: "Details sample venue",
      timezone: "Asia/Kuala_Lumpur",
      role: admin.role,
    },
    user: admin,
    store,
  };
  const calls: ReadQuery[] = [];
  const operations: unknown[] = [];
  const read = async (query: ReadQuery) => {
    calls.push({ ...query });
    const rows = store.sessions.filter(
      (session) =>
        session.playerId === query.playerId &&
        (!query.status || query.status === session.status) &&
        (!query.query || query.query === "2026-11-04"),
    );
    return readPageReceipt({
      branchId: admin.branchId,
      revision: snapshot.revision,
      context: snapshot,
      items: rows,
      total: rows.length,
      page: 0,
      pageSize: query.pageSize ?? 20,
    });
  };
  return { snapshot, creditId, cashId, calls, operations, read };
}

function Harness({
  data,
  playerId,
  role = "ADMIN",
}: {
  data: ReturnType<typeof fixture>;
  playerId: string;
  role?: Staff["role"];
}) {
  const [open, setOpen] = useState(true);
  const user = { ...data.snapshot.user, role };
  const drafts = useListDrafts(user, "/players");
  if (!drafts.ready) return null;
  const store = data.snapshot.store;
  const players = playersForDay(store);
  const state = {
    ...drafts,
    snapshot: data.snapshot,
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
    busy: false,
    retryRequired: false,
    error: "",
    setError() {},
    closeOperation: () => setOpen(false),
    startOperation: (operation: unknown) => data.operations.push(operation),
    clearReadFocus() {},
    read: data.read,
    registerRead: () => () => {},
    readGeneration: 0,
  } as unknown as PokerManagementState;
  return (
    <NextIntlClientProvider
      locale="en"
      timeZone="Asia/Kuala_Lumpur"
      messages={{}}
    >
      <PokerManagementContext.Provider value={state}>
        {open && <PlayerDetails playerId={playerId} />}
      </PokerManagementContext.Provider>
    </NextIntlClientProvider>
  );
}

function amount(label: string) {
  return screen
    .getByText(label, { exact: true })
    .closest("div")
    ?.querySelector("dd")
    ?.textContent?.replace(/\s/g, " ");
}

test("credit overview keeps balances, pending reservation and actions clear without fetching sessions", async () => {
  const data = fixture();
  render(<Harness data={data} playerId={data.creditId} />);
  const heading = await screen.findByRole("heading", {
    name: "Player details",
  });
  await waitFor(() => assert.equal(document.activeElement, heading));
  assert.equal(
    screen.getByRole("tab", { name: "Overview" }).getAttribute("aria-selected"),
    "true",
  );
  assert.equal(screen.queryByRole("region", { name: "Session history" }), null);
  assert.equal(data.calls.length, 0);
  assert.equal(amount("Outstanding credit"), "RM 300.00");
  assert.equal(amount("Available credit"), "RM 500.00");
  assert.equal(amount("Credit limit"), "RM 1,000.00");
  assert.match(
    screen.getByText(/Reserved for pending buy-ins/).textContent!,
    /200\.00/,
  );
  assert.ok(screen.getByRole("link", { name: "View request · Credit sample" }));
  assert.equal(
    (
      screen.getByRole("button", {
        name: "Cash-out · Credit sample",
      }) as HTMLButtonElement
    ).disabled,
    true,
  );
  assert.equal(
    screen.queryByRole("button", { name: "Buy-in · Credit sample" }),
    null,
  );
  assert.ok(screen.getByText("Details table · Seat 1"));
  assert.ok(screen.getByText("Unsettled"));
});

test("cash overview retains session buy-in, cash-out and settled P/L without credit labels", async () => {
  const data = fixture();
  render(<Harness data={data} playerId={data.cashId} />);
  await screen.findByRole("tab", { name: "Overview" });
  assert.equal(screen.queryByText("Outstanding credit", { exact: true }), null);
  assert.equal(amount("Buy-in"), "RM 500.00");
  assert.equal(amount("Cash-out"), "RM 700.00");
  assert.equal(amount("P/L"), "RM 200.00");
  assert.ok(screen.getByRole("button", { name: "Check in · Cash sample" }));
  assert.equal(data.calls.length, 0);
});

test("keyboard tab selection loads sessions on demand and preserves search when returning", async () => {
  const data = fixture();
  const user = userEvent.setup();
  const view = render(<Harness data={data} playerId={data.creditId} />);
  const heading = await screen.findByRole("heading", {
    name: "Player details",
  });
  await waitFor(() => assert.equal(document.activeElement, heading));
  await user.tab();
  assert.equal(
    document.activeElement,
    screen.getByRole("tab", { name: "Overview" }),
  );
  await user.keyboard("{ArrowRight}");
  const history = await screen.findByRole("region", {
    name: "Session history",
  });
  assert.equal(
    screen.queryByRole("heading", { name: "Session history" }),
    null,
  );
  await waitFor(() => assert.equal(data.calls.length, 1));
  const search = within(history).getByRole("searchbox", {
    name: "Search session history",
  });
  await user.type(search, "2026-11-04");
  await waitFor(() =>
    assert.ok(data.calls.some((query) => query.query === "2026-11-04")),
  );
  await user.click(screen.getByRole("tab", { name: "Overview" }));
  assert.equal(screen.queryByRole("region", { name: "Session history" }), null);
  await user.click(screen.getByRole("tab", { name: "Sessions" }));
  assert.equal(
    (
      screen.getByRole("searchbox", {
        name: "Search session history",
      }) as HTMLInputElement
    ).value,
    "2026-11-04",
  );
  view.rerender(<Harness data={data} playerId={data.cashId} />);
  assert.equal(
    screen.getByRole("tab", { name: "Overview" }).getAttribute("aria-selected"),
    "true",
  );
  assert.equal(screen.queryByRole("region", { name: "Session history" }), null);
  assert.equal(amount("P/L"), "RM 200.00");
});

test("view-only dealer overview does not expose cashier or profile-edit actions", async () => {
  const data = fixture();
  render(<Harness data={data} playerId={data.cashId} role="DEALER" />);
  await screen.findByRole("tab", { name: "Overview" });
  assert.ok(screen.getByText("View only"));
  assert.equal(
    screen.queryByRole("button", {
      name: /^Check in|^Buy-in|^Cash-out|^Credit Repayment|^Player actions/,
    }),
    null,
  );
  assert.equal(data.operations.length, 0);
});
