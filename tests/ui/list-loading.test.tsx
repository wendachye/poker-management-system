import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type { ReactNode } from "react";
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
import type { PokerManagementState } from "../../src/components/page/PokerManagementPage/usePokerManagementState";
import { useListDrafts } from "../../src/components/page/PokerManagementPage/components/use-list-drafts";
import { ReportsView } from "../../src/components/page/PokerManagementPage/views/reports-view";
import { RangeReport } from "../../src/components/page/PokerManagementPage/components/range-report";
import { PlayerDetails } from "../../src/components/page/PokerManagementPage/components/player-details";
import { StaffManagement } from "../../src/components/page/PokerManagementPage/components/staff-management";
import { PlayersView } from "../../src/components/page/PokerManagementPage/views/players-view";
import { TransactionsView } from "../../src/components/page/PokerManagementPage/views/transactions-view";
import { AdminView } from "../../src/components/page/PokerManagementPage/views/admin-view";
import { applyCommand } from "../../src/domain/operations";
import type { Command } from "../../src/domain/commands";
import type { Snapshot, Staff } from "../../src/domain/model";
import type {
  ReadItems,
  ReadPage,
  ReadQuery,
} from "../../src/domain/read-model";
import {
  playersForDay,
  tablesForDay,
  totalsForDay,
} from "../../src/domain/selectors";
import { compareReports } from "../../src/domain/reporting";
import { readPageReceipt } from "../../src/lib/read-page";
import { configuredStore } from "../helpers/store";

const noop = () => {};
const registerRead = () => noop;
const now = new Date("2026-11-03T05:00:00Z");

function fixture(options: { holdSort?: boolean } = {}) {
  const admin: Staff = {
    id: "ui-admin",
    username: "UI admin",
    role: "ADMIN",
    branchId: "ui-venue",
  };
  const cashier: Staff = {
    ...admin,
    id: "ui-cashier",
    username: "UI cashier",
    role: "CASHIER",
  };
  let store = configuredStore();
  const run = (command: Command, actor = admin) => {
    store = applyCommand(store, command, actor, now.toISOString());
  };
  run({ kind: "OPEN_DAY", date: "2026-11-03", openingCash: 123450 });
  run({ kind: "TABLE", name: "Focus test table", dealer: "", status: "OPEN" });
  run({
    kind: "CHECK_IN",
    name: "Focus test player",
    phone: "+12025550101",
    type: "CASH",
    creditLimit: 0,
    tags: [],
    tableId: store.tables[0].id,
    seat: 1,
  });
  const playerId = store.profiles[0].id;
  run(
    {
      kind: "REQUEST",
      type: "Buy-in",
      amount: 50000,
      playerId,
      tableId: store.tables[0].id,
      note: "Fictional UI fixture",
    },
    cashier,
  );
  run({
    kind: "DECIDE",
    approvalId: store.approvals[0].id,
    decision: "APPROVED",
  });
  run(
    {
      kind: "REQUEST",
      type: "Rake",
      amount: 2500,
      tableId: store.tables[0].id,
      note: "Fictional pending UI request",
    },
    cashier,
  );
  const snapshot: Snapshot = {
    revision: 7,
    branch: {
      id: admin.branchId,
      name: "Fictional UI venue",
      timezone: "Asia/Kuala_Lumpur",
      role: admin.role,
    },
    user: admin,
    store,
  };
  function page(query: ReadQuery, empty = false): ReadPage<ReadItems> {
    const day = store.days[0];
    const report =
      query.resource === "range"
        ? compareReports(store, query.from!, query.to!)
        : undefined;
    const rows: ReadItems[] =
      query.resource === "sessions"
        ? store.sessions
        : query.resource === "range"
          ? report!.current.days
          : query.resource === "transactions"
            ? store.transactions
            : query.resource === "requests"
              ? store.approvals.filter(
                  (request) => request.status === query.status,
                )
              : query.resource === "audit"
                ? store.auditLogs
                : playersForDay(store, day.id);
    return readPageReceipt({
      branchId: admin.branchId,
      revision: snapshot.revision,
      context: snapshot,
      items: empty ? [] : rows,
      total: empty ? 0 : rows.length,
      page: 0,
      pageSize: query.pageSize ?? 20,
      counts: empty
        ? {
            ALL: 0,
            ACTIVE: 0,
            OUT: 0,
            PENDING: 0,
            APPROVED: 0,
            REJECTED: 0,
            MINE: 0,
          }
        : {
            ALL: rows.length,
            ACTIVE: playersForDay(store, day.id).filter(
              (player) => player.status === "ACTIVE",
            ).length,
            OUT: 0,
            PENDING: store.approvals.filter(
              (request) => request.status === "PENDING",
            ).length,
            APPROVED: store.transactions.length,
            REJECTED: 0,
            MINE: 0,
          },
      ...(query.resource === "audit"
        ? {
            options: {
              staff: [admin.username, cashier.username],
              actions: [
                ...new Set(store.auditLogs.map((entry) => entry.action)),
              ],
            },
          }
        : {}),
      ...(query.resource === "report"
        ? { day, totals: totalsForDay(store, day.id) }
        : {}),
      ...(report ? { report } : {}),
    });
  }
  let pending: { empty: () => void; fail: () => void } | undefined;
  let lastRead: ReadQuery | undefined;
  const read: PokerManagementState["read"] = async <T,>(
    query: ReadQuery,
    signal?: AbortSignal,
  ): Promise<ReadPage<T>> => {
    lastRead = { ...query };
    if (!query.query && !(options.holdSort && query.sort))
      return page(query) as ReadPage<T>;
    return new Promise((resolve, reject) => {
      const request = {
        empty: () => resolve(page(query, true) as ReadPage<T>),
        fail: () => reject(new Error("Fixture read unavailable.")),
      };
      pending = request;
      signal?.addEventListener(
        "abort",
        () => {
          if (pending === request) pending = undefined;
          reject(new DOMException("Aborted", "AbortError"));
        },
        { once: true },
      );
    });
  };
  return {
    snapshot,
    playerId,
    read,
    get lastRead() {
      return lastRead;
    },
    async respondEmpty() {
      await waitFor(() =>
        assert.ok(pending, "The read adapter received the new criteria"),
      );
      await act(async () => {
        pending!.empty();
        pending = undefined;
      });
    },
    async failRead() {
      await waitFor(() =>
        assert.ok(pending, "The read adapter received the new criteria"),
      );
      await act(async () => {
        pending!.fail();
        pending = undefined;
      });
    },
  };
}

function Boundary({
  data,
  route,
  children,
}: {
  data: ReturnType<typeof fixture>;
  route: string;
  children: ReactNode;
}) {
  const drafts = useListDrafts(data.snapshot.user, route);
  if (!drafts.ready) return null;
  const store = data.snapshot.store;
  const players = playersForDay(store);
  const state = {
    ...drafts,
    snapshot: data.snapshot,
    store,
    user: data.snapshot.user,
    day: store.days[0],
    players,
    tables: tablesForDay(store),
    totals: totalsForDay(store),
    activePlayers: players,
    pendingApprovals: store.approvals.filter(
      (request) => request.status === "PENDING",
    ),
    locked: false,
    busy: false,
    error: "",
    retryRequired: false,
    read: data.read,
    readGeneration: 0,
    registerRead,
    now,
    setError: noop,
    closeOperation: noop,
    clearReadFocus: noop,
  } as unknown as PokerManagementState;
  return (
    <NextIntlClientProvider
      locale="en"
      timeZone="Asia/Kuala_Lumpur"
      messages={{}}
    >
      <PokerManagementContext.Provider value={state}>
        {children}
      </PokerManagementContext.Provider>
    </NextIntlClientProvider>
  );
}

beforeEach(() => {
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/en/reports");
});
afterEach(cleanup);

for (const scenario of [
  {
    name: "daily report",
    search: "Search player results",
    component: () => <ReportsView />,
    stale: /1,734\.50/,
    empty: "No matching player results",
  },
  {
    name: "date-range report",
    search: "Search daily breakdown",
    component: () => <RangeReport today="2026-11-03" />,
    stale: /1,734\.50/,
    empty: "No matching business days",
  },
]) {
  test(`${scenario.name} keeps the focused search mounted while fresh rows load`, async () => {
    const data = fixture();
    const user = userEvent.setup();
    render(
      <Boundary data={data} route="/reports">
        {scenario.component()}
      </Boundary>,
    );
    const input = await screen.findByRole("searchbox", {
      name: scenario.search,
    });
    await waitFor(() =>
      assert.ok(screen.queryAllByText(scenario.stale).length),
    );
    await user.type(input, "z");
    assert.ok(
      screen.getByRole("searchbox", { name: scenario.search }) === input,
      "The original search element remains mounted",
    );
    assert.ok(document.activeElement === input, "The search retains focus");
    assert.equal(
      screen.queryAllByText(scenario.stale).length,
      0,
      "Previous financial amounts are hidden until the new response arrives",
    );
    await user.type(input, "z");
    assert.equal((input as HTMLInputElement).value, "zz");
    await data.respondEmpty();
    assert.ok(screen.getByText(scenario.empty));
    assert.ok(
      screen.getByRole("searchbox", { name: scenario.search }) === input,
      "Empty results retain the original search element",
    );
    assert.ok(
      document.activeElement === input,
      "Empty results retain search focus",
    );
    assert.ok(
      screen.getAllByRole("combobox", { name: /Rows per page/ }).length,
    );
  });
}

test("audit staff and action criteria remain readable while their replacement page loads or fails", async () => {
  const data = fixture();
  const actor = "UI cashier";
  const action = data.snapshot.store.auditLogs.find(
    (entry) => entry.actor === actor,
  )!.action;
  const params = new URLSearchParams({
    listVenue: data.snapshot.branch.id,
    "audit.staff": actor,
    "audit.action": action,
  });
  window.history.replaceState(null, "", "/en/admin/audit?" + params);
  const user = userEvent.setup();
  render(
    <Boundary data={data} route="/admin/audit">
      <AdminView />
    </Boundary>,
  );
  await waitFor(() =>
    assert.ok(
      screen.queryAllByRole("button", { name: /^View details ·/ }).length,
    ),
  );
  await user.type(
    screen.getByRole("searchbox", { name: "Search audit history" }),
    "missing",
  );
  await user.click(
    screen.getByRole("button", { name: "Filters · Search audit history" }),
  );
  assert.ok(
    screen
      .getByRole("combobox", { name: "Staff" })
      .textContent?.includes(actor),
    "The selected staff label stays readable while loading",
  );
  assert.ok(
    screen
      .getByRole("combobox", { name: "Action" })
      .textContent?.includes(action),
    "The selected action label stays readable while loading",
  );
  await data.failRead();
  assert.ok(
    screen
      .getByRole("combobox", { name: "Staff" })
      .textContent?.includes(actor),
    "A failed list read does not blank the selected staff filter",
  );
  assert.ok(
    screen
      .getByRole("combobox", { name: "Action" })
      .textContent?.includes(action),
    "A failed list read does not blank the selected action filter",
  );
  assert.ok(
    screen.getByRole("button", { name: "Done" }),
    "The filter popup remains closable when the count is unavailable",
  );
});

test("an audit date change remains in the input and URL after its new read fails", async () => {
  window.history.replaceState(null, "", "/en/admin/audit");
  const data = fixture();
  const user = userEvent.setup();
  render(
    <Boundary data={data} route="/admin/audit">
      <AdminView />
    </Boundary>,
  );
  await waitFor(() =>
    assert.ok(
      screen.queryAllByRole("button", { name: /^View details ·/ }).length,
    ),
  );
  await user.type(
    screen.getByRole("searchbox", { name: "Search audit history" }),
    "missing",
  );
  await user.click(
    screen.getByRole("button", { name: "Filters · Search audit history" }),
  );
  const from = screen.getByLabelText("From date") as HTMLInputElement;
  fireEvent.change(from, { target: { value: "2026-11-02" } });
  assert.equal(from.value, "2026-11-02");
  await data.failRead();
  assert.equal(from.value, "2026-11-02");
  assert.equal(
    new URLSearchParams(window.location.search).get("audit.from"),
    "2026-11-02",
  );
  assert.ok(
    screen.getByLabelText("From date") === from,
    "A failed page keeps the selected date input mounted",
  );
});

test("staff search distinguishes held and failed HTTP reads from confirmed zero matching accounts", async () => {
  window.history.replaceState(null, "", "/en/settings/staff");
  const data = fixture();
  const user = userEvent.setup();
  const originalFetch = globalThis.fetch;
  let pending: { empty: () => void; fail: () => void } | undefined;
  function page(empty: boolean) {
    return Response.json({
      branchId: data.snapshot.branch.id,
      accounts: empty
        ? []
        : [
            {
              id: "ui-cashier",
              username: "UI cashier",
              role: "CASHIER",
              active: true,
              sharedAccount: false,
            },
          ],
      total: empty ? 0 : 1,
      page: 0,
      pageSize: 20,
      counts: { ALL: empty ? 0 : 1, ACTIVE: empty ? 0 : 1, DISABLED: 0 },
    });
  }
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), window.location.href);
    assert.equal(url.pathname, "/api/staff");
    assert.equal(
      url.searchParams.has("role"),
      false,
      "The default role filter is omitted from server requests",
    );
    if (!url.searchParams.get("query")) return page(false);
    return new Promise<Response>((resolve, reject) => {
      const request = {
        empty: () => resolve(page(true)),
        fail: () =>
          resolve(
            Response.json(
              { error: "Staff fixture unavailable." },
              { status: 503 },
            ),
          ),
      };
      pending = request;
      init?.signal?.addEventListener(
        "abort",
        () => {
          if (pending === request) pending = undefined;
          reject(new DOMException("Aborted", "AbortError"));
        },
        { once: true },
      );
    });
  };
  try {
    render(
      <Boundary data={data} route="/settings/staff">
        <StaffManagement />
      </Boundary>,
    );
    await waitFor(() =>
      assert.ok(
        screen.queryAllByRole("button", {
          name: "Staff actions · UI cashier",
        }).length,
      ),
    );
    const input = screen.getByRole("searchbox", {
      name: "Search staff accounts",
    });
    await user.type(input, "missing");
    assert.ok(
      document.activeElement === input,
      "The staff search retains focus during the new request",
    );
    assert.ok(screen.getByText("Updating results…"));
    assert.ok(
      !screen.queryByText("0 results"),
      "A pending staff count is unknown rather than zero",
    );
    assert.ok(
      !screen.queryByText("No matching staff accounts"),
      "Pending staff reads do not imply no matches",
    );
    assert.equal(
      screen.queryAllByRole("button", { name: "Staff actions · UI cashier" })
        .length,
      0,
    );
    assert.ok(screen.getByRole("combobox", { name: /Rows per page/ }));
    await waitFor(() => assert.ok(pending));
    await act(async () => {
      pending!.fail();
      pending = undefined;
    });
    await screen.findByText("Staff fixture unavailable.");
    assert.ok(screen.getByText("Results unavailable"));
    assert.ok(
      !screen.queryByText("0 results"),
      "Failed staff counts are unavailable rather than zero",
    );
    assert.ok(
      !screen.queryByText("No matching staff accounts"),
      "Failed staff reads remain separate from confirmed empty results",
    );
    assert.equal(
      screen.queryAllByRole("button", { name: "Staff actions · UI cashier" })
        .length,
      0,
    );
    assert.ok(screen.getByRole("combobox", { name: /Rows per page/ }));
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => assert.ok(pending));
    await act(async () => {
      pending!.empty();
      pending = undefined;
    });
    await screen.findByText("No matching staff accounts");
    assert.ok(screen.getByText("0 results"));
    assert.ok(screen.getAllByRole("button", { name: "Clear all" }).length);
    assert.ok(
      screen.getByRole("searchbox", { name: "Search staff accounts" }) ===
        input,
      "The original staff search stays mounted after retry",
    );
  } finally {
    cleanup();
    globalThis.fetch = originalFetch;
  }
});

test("player session history retains its focused controls during loading and after no matches", async () => {
  window.history.replaceState(null, "", "/en/players");
  const data = fixture();
  const user = userEvent.setup();
  render(
    <Boundary data={data} route="/players">
      <PlayerDetails playerId={data.playerId} />
    </Boundary>,
  );
  await user.click(screen.getByRole("tab", { name: "Sessions" }));
  const section = await screen.findByRole("region", {
    name: "Session history",
  });
  const input = await within(section).findByRole("searchbox", {
    name: "Search session history",
  });
  await waitFor(() =>
    assert.ok(within(section).queryAllByText(/Focus test table/).length),
  );
  await user.type(input, "z");
  assert.ok(
    within(section).getByRole("searchbox", {
      name: "Search session history",
    }) === input,
    "The history search remains mounted",
  );
  assert.ok(
    document.activeElement === input,
    "The history search retains focus",
  );
  assert.equal(within(section).queryAllByText(/Focus test table/).length, 0);
  assert.ok(
    !within(section).queryByText("No matching sessions"),
    "Loading history does not imply no matches",
  );
  await data.respondEmpty();
  assert.ok(within(section).getByText("No matching sessions"));
  assert.ok(
    within(section).getByRole("searchbox", {
      name: "Search session history",
    }) === input,
    "Empty history retains the original search",
  );
  assert.ok(
    document.activeElement === input,
    "Empty history retains search focus",
  );
  assert.ok(within(section).getByRole("combobox", { name: /Rows per page/ }));
});

test("an empty filtered staff page offers clearing filters instead of implying no accounts exist", async () => {
  window.history.replaceState(null, "", "/en/settings/staff");
  const data = fixture();
  const user = userEvent.setup();
  const fetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), window.location.href);
    assert.equal(url.pathname, "/api/staff");
    assert.equal(
      url.searchParams.has("role"),
      false,
      "All roles omits the role filter from the server query",
    );
    const filtered = !!url.searchParams.get("query");
    return Response.json({
      branchId: data.snapshot.branch.id,
      accounts: filtered
        ? []
        : [
            {
              id: "ui-cashier",
              username: "UI cashier",
              role: "CASHIER",
              active: true,
              sharedAccount: false,
            },
          ],
      total: filtered ? 0 : 1,
      page: 0,
      pageSize: 20,
      counts: { ALL: 1, ACTIVE: 1, DISABLED: 0 },
    });
  };
  try {
    render(
      <Boundary data={data} route="/settings/staff">
        <StaffManagement />
      </Boundary>,
    );
    await waitFor(() => assert.ok(screen.queryAllByText("UI cashier").length));
    const input = screen.getByRole("searchbox", {
      name: "Search staff accounts",
    });
    await user.type(input, "missing");
    await screen.findByText("No matching staff accounts");
    assert.ok(
      !screen.queryByText("No staff accounts yet"),
      "A filtered staff page is not an empty venue",
    );
    assert.ok(
      document.activeElement === input,
      "The staff search retains focus",
    );
    assert.ok(
      screen.getByRole("searchbox", { name: "Search staff accounts" }) ===
        input,
      "The staff search remains mounted",
    );
    assert.ok(screen.getByRole("combobox", { name: /Rows per page/ }));
    await user.click(screen.getAllByRole("button", { name: "Clear all" })[0]);
    await waitFor(() => assert.ok(screen.queryAllByText("UI cashier").length));
    assert.equal((input as HTMLInputElement).value, "");
    assert.ok(
      !screen.queryByText("No matching staff accounts"),
      "Clearing criteria restores staff records",
    );
  } finally {
    cleanup();
    globalThis.fetch = fetch;
  }
});

test("posted transactions do not announce an empty list while a changed search is still loading", async () => {
  window.history.replaceState(
    null,
    "",
    "/en/transactions?listVenue=ui-venue&tx.status=APPROVED",
  );
  const data = fixture();
  const user = userEvent.setup();
  render(
    <Boundary data={data} route="/transactions">
      <TransactionsView />
    </Boundary>,
  );
  await waitFor(() =>
    assert.ok(
      screen.queryAllByRole("button", { name: /^Receipt · Buy-in ·/ }).length,
    ),
  );
  const input = screen.getByRole("searchbox", { name: "Search transactions" });
  await user.type(input, "missing");
  assert.ok(
    document.activeElement === input,
    "Transaction search retains focus",
  );
  assert.ok(
    !screen.queryByText("No transactions match these filters."),
    "A pending read must not display an empty transaction list",
  );
  assert.ok(
    !screen.queryByText("No approved transactions yet"),
    "A pending read must not imply no approved entries exist",
  );
  assert.ok(
    !screen.queryByText("0 results"),
    "A pending result count is unknown, not zero",
  );
  assert.ok(
    !screen.queryByText(/^Showing 0/),
    "A pending page must not announce zero rows",
  );
  assert.equal(
    screen.queryAllByRole("button", { name: /^Receipt · Buy-in ·/ }).length,
    0,
  );
  assert.ok(screen.getByRole("combobox", { name: /Rows per page/ }));
  await data.failRead();
  await screen.findByText("Fixture read unavailable.");
  assert.ok(screen.getByText("Results unavailable"));
  assert.ok(
    !screen.queryByText("0 results"),
    "An unavailable result count is not zero",
  );
  assert.ok(
    !screen.queryByText("No transactions match these filters."),
    "Read failures must not masquerade as empty lists",
  );
  assert.equal(
    screen.queryAllByRole("button", { name: /^Receipt · Buy-in ·/ }).length,
    0,
  );
  await user.click(screen.getByRole("button", { name: "Retry" }));
  await data.respondEmpty();
  await screen.findByText("No transactions match these filters.");
  assert.ok(screen.getByText("0 results"));
  assert.ok(screen.getAllByRole("button", { name: "Clear all" }).length);
});

for (const scenario of [
  {
    name: "player directory",
    route: "/players",
    component: () => <PlayersView />,
    search: "Search players",
    action: /^View player · Focus test player$/,
    empty: "No matching players.",
    falseEmpty: "No players yet",
  },
  {
    name: "pending approval queue",
    route: "/transactions",
    component: () => <TransactionsView />,
    search: "Search transactions",
    action: /^Review request ·/,
    empty: "No requests match these filters.",
    falseEmpty: "No pending approvals.",
  },
  {
    name: "audit history",
    route: "/admin/audit",
    component: () => <AdminView />,
    search: "Search audit history",
    action: /^View details ·/,
    empty: "No matching activity",
    falseEmpty: "No activity yet",
  },
]) {
  test(`${scenario.name} distinguishes a pending or failed read from a successful empty page`, async () => {
    window.history.replaceState(null, "", "/en" + scenario.route);
    const data = fixture();
    const user = userEvent.setup();
    render(
      <Boundary data={data} route={scenario.route}>
        {scenario.component()}
      </Boundary>,
    );
    await waitFor(() =>
      assert.ok(
        screen.queryAllByRole("button", { name: scenario.action }).length,
      ),
    );
    const input = screen.getByRole("searchbox", { name: scenario.search });
    await user.type(input, "missing");
    assert.ok(
      document.activeElement === input,
      "The search input retains keyboard focus",
    );
    assert.ok(screen.getByText("Updating results…"));
    assert.ok(
      !screen.queryByText("0 results"),
      "A pending count is unknown rather than zero",
    );
    assert.ok(
      !screen.queryByText(/^Showing 0/),
      "The pending pager must not announce an empty page",
    );
    assert.ok(
      !screen.queryByText(scenario.empty),
      "Pending criteria do not imply zero matches",
    );
    assert.ok(
      !screen.queryByText(scenario.falseEmpty),
      "Pending reads do not imply an empty venue",
    );
    assert.equal(
      screen.queryAllByRole("button", { name: scenario.action }).length,
      0,
    );
    assert.ok(screen.getByRole("combobox", { name: /Rows per page/ }));
    await data.failRead();
    await screen.findByText("Fixture read unavailable.");
    assert.ok(screen.getByText("Results unavailable"));
    assert.ok(!screen.queryByText("0 results"), "A failed count is not zero");
    assert.ok(
      !screen.queryByText(scenario.empty),
      "Read errors are presented separately from empty results",
    );
    assert.equal(
      screen.queryAllByRole("button", { name: scenario.action }).length,
      0,
    );
    assert.ok(screen.getByRole("combobox", { name: /Rows per page/ }));
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await data.respondEmpty();
    await screen.findByText(scenario.empty);
    assert.ok(screen.getByText("0 results"));
    assert.ok(screen.getAllByRole("button", { name: "Clear all" }).length);
    assert.ok(
      screen.getByRole("searchbox", { name: scenario.search }) === input,
      "Settled empty results keep the original search element",
    );
  });
}

for (const scenario of [
  {
    name: "player directory",
    route: "/players",
    query: "player.page=3",
    component: () => <PlayersView />,
    table: "Players",
    header: "Player",
    sort: "name",
    action: /^View player · Focus test player$/,
    empty: "No players yet",
  },
  {
    name: "approved transactions",
    route: "/transactions",
    query: "tx.status=APPROVED&tx.page=3",
    component: () => <TransactionsView />,
    table: "Transactions",
    header: "Transaction",
    sort: "type",
    action: /^Receipt · Buy-in ·/,
    empty: "No transactions match these filters.",
  },
  {
    name: "pending approvals",
    route: "/transactions",
    query: "tx.status=PENDING&tx.page=3",
    component: () => <TransactionsView />,
    table: "Approval queue",
    header: "Request",
    sort: "type",
    action: /^Review request ·/,
    empty: "No requests match these filters.",
  },
  {
    name: "audit history",
    route: "/admin/audit",
    query: "audit.page=3",
    component: () => <AdminView />,
    table: "Audit history",
    header: "Date",
    sort: "time",
    action: /^View details ·/,
    empty: "No activity yet",
  },
]) {
  test(`${scenario.name} keeps the focused sort header during held, failed and empty reads`, async () => {
    window.history.replaceState(
      null,
      "",
      `/en${scenario.route}?listVenue=ui-venue&${scenario.query}`,
    );
    const data = fixture({ holdSort: true });
    const user = userEvent.setup();
    render(
      <Boundary data={data} route={scenario.route}>
        {scenario.component()}
      </Boundary>,
    );
    await waitFor(() =>
      assert.ok(
        screen.queryAllByRole("button", { name: scenario.action }).length,
      ),
    );
    assert.equal(
      data.lastRead?.page,
      2,
      "The saved page starts beyond page one",
    );
    const table = screen.getByRole("table", { name: scenario.table });
    const column = within(table).getByRole("columnheader", {
      name: scenario.header,
    });
    const button = within(column).getByRole("button");
    act(() => button.focus());
    await user.keyboard("{Enter}");
    await waitFor(() => {
      assert.equal(data.lastRead?.sort, scenario.sort);
      assert.equal(data.lastRead?.direction, "asc");
      assert.equal(
        data.lastRead?.page,
        0,
        "Sorting asks for the first server page",
      );
    });
    assert.equal(column.getAttribute("aria-sort"), "ascending");
    assert.ok(
      document.activeElement === button,
      "The held read retains header focus",
    );
    assert.equal(
      screen.queryAllByRole("button", { name: scenario.action }).length,
      0,
      "Previous row actions are hidden while the new sort is unresolved",
    );
    await data.failRead();
    await screen.findByText("Fixture read unavailable.");
    assert.ok(
      document.activeElement === button,
      "A failed read retains header focus",
    );
    assert.ok(
      within(table).getByRole("columnheader", {
        name: scenario.header,
      }) === column,
      "A failed read keeps the same column header mounted",
    );
    assert.equal(
      screen.queryAllByRole("button", { name: scenario.action }).length,
      0,
      "A failed read cannot expose previous row actions",
    );
    await user.keyboard(" ");
    await waitFor(() => {
      assert.equal(data.lastRead?.direction, "desc");
      assert.equal(data.lastRead?.sort, scenario.sort);
      assert.equal(data.lastRead?.page, 0);
    });
    assert.equal(column.getAttribute("aria-sort"), "descending");
    assert.ok(
      document.activeElement === button,
      "Space toggles the existing header button",
    );
    await data.respondEmpty();
    await screen.findByText(scenario.empty);
    assert.ok(
      document.activeElement === button,
      "Empty results retain header focus",
    );
    assert.ok(
      within(table).getByRole("columnheader", {
        name: scenario.header,
      }) === column,
      "Empty results keep the same column header mounted",
    );
    assert.equal(
      screen.queryAllByRole("button", { name: scenario.action }).length,
      0,
    );
    assert.equal(column.getAttribute("aria-sort"), "descending");
  });
}
