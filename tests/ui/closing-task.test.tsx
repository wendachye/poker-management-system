import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { Command } from "../../src/domain/commands";
import type { Snapshot, Staff } from "../../src/domain/model";
import type { ReadPage, ReadQuery } from "../../src/domain/read-model";
import { applyCommand } from "../../src/domain/operations";
import {
  playersForDay,
  tablesForDay,
  totalsForDay,
} from "../../src/domain/selectors";
import {
  closingTaskScope,
  matchesClosingTaskScope,
} from "../../src/lib/closing-task";
import { readPageReceipt } from "../../src/lib/read-page";
import { PokerManagementContext } from "../../src/components/page/PokerManagementPage/PokerManagementProvider";
import type { PokerManagementState } from "../../src/components/page/PokerManagementPage/usePokerManagementState";
import {
  ClosingTaskProvider,
  useClosingTask,
} from "../../src/components/page/PokerManagementPage/components/closing-task";
import { FinishClosingShortcut } from "../../src/components/page/PokerManagementPage/components/finish-closing-shortcut";
import { ReportsView } from "../../src/components/page/PokerManagementPage/views/reports-view";
import { useListDrafts } from "../../src/components/page/PokerManagementPage/components/use-list-drafts";
import { configuredStore } from "../helpers/store";

beforeEach(() => {
  Object.defineProperty(globalThis, "self", {
    configurable: true,
    value: window,
  });
  window.history.replaceState(null, "", "/en/reports");
  window.sessionStorage.clear();
});
afterEach(cleanup);
const noop = () => {};
const registerRead = () => noop;
type RehearsalControls = {
  setSnapshot: (snapshot: Snapshot) => void;
  navigate: (route: string) => void;
  route: () => string;
  drafts: () => Record<string, string>;
};

function fixture() {
  const admin: Staff = {
    id: "closing-admin",
    username: "Closing admin",
    role: "ADMIN",
    branchId: "closing-venue",
  };
  const cashier: Staff = {
    ...admin,
    id: "closing-cashier",
    username: "Closing cashier",
    role: "CASHIER",
  };
  let store = configuredStore();
  const run = (command: Command, actor = admin) => {
    store = applyCommand(store, command, actor, "2026-11-04T02:00:00Z");
  };
  run({ kind: "OPEN_DAY", date: "2026-11-04", openingCash: 100000 });
  run({
    kind: "TABLE",
    name: "Closing practice table",
    dealer: "",
    status: "OPEN",
  });
  run({
    kind: "CHECK_IN",
    name: "Closing practice player",
    phone: "+12025550101",
    type: "CASH",
    creditLimit: 0,
    tags: [],
    tableId: store.tables[0].id,
    seat: 1,
  });
  run(
    {
      kind: "REQUEST",
      type: "Buy-in",
      amount: 50000,
      playerId: store.profiles[0].id,
      tableId: store.tables[0].id,
      note: "Fictional closing task fixture",
    },
    cashier,
  );
  const snapshot: Snapshot = {
    revision: 1,
    user: admin,
    branch: {
      id: admin.branchId,
      name: "Closing sample venue",
      role: admin.role,
      timezone: "Asia/Kuala_Lumpur",
    },
    store,
  };
  const submissions: Command[] = [];
  const reads: { query: ReadQuery; signal?: AbortSignal }[] = [];
  let controls: RehearsalControls | null = null;
  const data = {
    snapshot,
    submissions,
    reads,
    gate: null as null | Promise<Snapshot>,
    get controls() {
      return controls;
    },
    registerControls(value: RehearsalControls) {
      controls = value;
    },
  };
  return data;
}
type Fixture = ReturnType<typeof fixture>;

function page(snapshot: Snapshot, query: ReadQuery): ReadPage<unknown> {
  const day = snapshot.store.days.find(
    (entry) => entry.id === (query.dayId || snapshot.store.currentDayId),
  );
  const items = playersForDay(snapshot.store, day?.id);
  return readPageReceipt({
    branchId: snapshot.branch.id,
    revision: snapshot.revision,
    context: snapshot,
    items,
    total: items.length,
    page: 0,
    pageSize: 20,
    counts: { ALL: items.length },
    day,
    totals: totalsForDay(snapshot.store, day?.id),
  });
}
function Context({ children }: { children: ReactNode }) {
  return (
    <NextIntlClientProvider
      locale="en"
      timeZone="Asia/Kuala_Lumpur"
      messages={{}}
    >
      {children}
    </NextIntlClientProvider>
  );
}
function taskState(snapshot: Snapshot) {
  return {
    snapshot,
    store: snapshot.store,
    user: snapshot.user,
    day: snapshot.store.days.find(
      (day) => day.id === snapshot.store.currentDayId,
    ),
    activePlayers: playersForDay(snapshot.store).filter(
      (player) => player.status === "ACTIVE",
    ),
    pendingApprovals: snapshot.store.approvals.filter(
      (entry) => entry.status === "PENDING",
    ),
    busy: false,
    retryRequired: false,
  } as unknown as PokerManagementState;
}
function TaskProbe() {
  const task = useClosingTask();
  return (
    <>
      <button onClick={task.begin}>Begin practice closing</button>
      <output aria-label="Return requested">
        {task.requested ? "yes" : "no"}
      </output>
      <input aria-label="Retained field" />
    </>
  );
}
function ScopeExample({
  snapshot,
  authenticated = snapshot.user,
}: {
  snapshot: Snapshot;
  authenticated?: Staff | null;
}) {
  return (
    <Context>
      <PokerManagementContext.Provider value={taskState(snapshot)}>
        <ClosingTaskProvider scope={closingTaskScope(snapshot, authenticated)}>
          <div
            onClick={(event) => {
              if ((event.target as Element).closest("a"))
                event.preventDefault();
            }}
          >
            <TaskProbe />
            <FinishClosingShortcut />
          </div>
        </ClosingTaskProvider>
      </PokerManagementContext.Provider>
    </Context>
  );
}

function Rehearsal({ data }: { data: Fixture }) {
  const [snapshot, setSnapshot] = useState(data.snapshot);
  const [route, setRoute] = useState("/reports");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const read = useCallback(
    async <T,>(query: ReadQuery, signal?: AbortSignal) => {
      data.reads.push({ query: { ...query }, signal });
      const next = data.gate ? await data.gate : data.snapshot;
      if (!signal?.aborted) setSnapshot(next);
      return page(next, query) as ReadPage<T>;
    },
    [data],
  );
  useEffect(() => {
    data.registerControls({
      setSnapshot,
      navigate: setRoute,
      route: () => route,
      drafts: () => drafts,
    });
  }, [data, route, drafts]);
  const state = {
    ...taskState(snapshot),
    locked:
      snapshot.store.days.find((day) => day.id === snapshot.store.currentDayId)
        ?.status !== "OPEN",
    players: playersForDay(snapshot.store),
    tables: tablesForDay(snapshot.store),
    totals: totalsForDay(snapshot.store),
    error,
    refreshError: "",
    setError,
    read,
    readGeneration: 0,
    registerRead,
    draft: (key: string, fallback = "") => drafts[key] ?? fallback,
    draftValue: (key: string) => drafts[key],
    setDraft: (key: string, value: string) =>
      setDrafts((previous) => ({ ...previous, [key]: value })),
    clearDraft: (key: string) =>
      setDrafts((previous) => {
        const next = { ...previous };
        delete next[key];
        return next;
      }),
    submit: async (command: Command) => {
      data.submissions.push(command);
      return true;
    },
    withReviewedRevision: async (
      _revision: number | undefined,
      save: () => unknown,
    ) => save(),
  } as unknown as PokerManagementState;
  return (
    <Context>
      <PokerManagementContext.Provider value={state}>
        <ClosingTaskProvider scope={closingTaskScope(snapshot, snapshot.user)}>
          <div
            onClick={(event) => {
              const anchor = (event.target as Element).closest("a");
              if (!anchor) return;
              event.preventDefault();
              const target = new URL(anchor.href).pathname.replace(/^\/en/, "");
              window.history.replaceState(null, "", "/en" + target);
              setRoute(target);
            }}
          >
            {error && <p role="alert">{error}</p>}
            {route === "/reports" ? <ReportsView /> : <FinishClosingShortcut />}
          </div>
        </ClosingTaskProvider>
      </PokerManagementContext.Provider>
    </Context>
  );
}

test("a closing task stays scoped to the signed-in supervisor and current open day", () => {
  const { snapshot } = fixture();
  const scope = closingTaskScope(snapshot, snapshot.user)!;
  assert.equal(scope.dayId, snapshot.store.currentDayId);
  assert.equal(matchesClosingTaskScope(scope, snapshot), true);
  assert.equal(closingTaskScope(null, snapshot.user), null);
  assert.equal(closingTaskScope(snapshot, null), null);
  assert.equal(
    closingTaskScope(snapshot, { ...snapshot.user, id: "another-staff" }),
    null,
  );
  assert.equal(
    closingTaskScope(snapshot, { ...snapshot.user, branchId: "another-venue" }),
    null,
  );
  assert.equal(
    closingTaskScope(snapshot, { ...snapshot.user, role: "CASHIER" }),
    null,
  );
  const closed = structuredClone(snapshot);
  closed.store.days[0].status = "CLOSED";
  assert.equal(closingTaskScope(closed, closed.user), null);
  assert.equal(matchesClosingTaskScope(scope, closed), false);
});

test("Finish closing preserves a task until explicitly stopped and never submits a command", async () => {
  const data = fixture();
  const user = userEvent.setup();
  render(<ScopeExample snapshot={data.snapshot} />);
  assert.equal(screen.queryByRole("link", { name: "Finish closing" }), null);
  await user.click(
    screen.getByRole("button", { name: "Begin practice closing" }),
  );
  assert.ok(screen.getByRole("region", { name: "Closing in progress" }));
  assert.match(
    within(
      screen.getByRole("region", { name: "Closing in progress" }),
    ).getByRole("status").textContent!,
    /1 pending approvals · 1 active players/,
  );
  const finish = screen.getByRole("link", { name: "Finish closing" });
  assert.equal(finish.getAttribute("href"), "/en/reports");
  await user.click(finish);
  assert.equal(screen.getByLabelText("Return requested").textContent, "yes");
  await user.click(screen.getByRole("button", { name: "Stop closing" }));
  assert.equal(
    screen.queryByRole("region", { name: "Closing in progress" }),
    null,
  );
  assert.equal(screen.getByLabelText("Return requested").textContent, "no");
  assert.deepEqual(data.submissions, []);
});

test("access, venue, actor and day changes clear the task without remounting the surrounding UI", async () => {
  const { snapshot } = fixture();
  const user = userEvent.setup();
  const alternatives: { snapshot: Snapshot; authenticated?: Staff | null }[] =
    [];
  for (const field of ["id", "branchId", "role"] as const) {
    const next = structuredClone(snapshot);
    if (field === "role") {
      next.user.role = "MANAGER";
      next.branch.role = "MANAGER";
    } else if (field === "id") next.user.id = "other-admin";
    else {
      next.user.branchId = "other-venue";
      next.branch.id = "other-venue";
    }
    alternatives.push({ snapshot: next });
  }
  const otherDay = structuredClone(snapshot);
  otherDay.store.days[0].id = "another-day";
  otherDay.store.currentDayId = "another-day";
  alternatives.push({ snapshot: otherDay });
  const closed = structuredClone(snapshot);
  closed.store.days[0].status = "CLOSED";
  alternatives.push({ snapshot: closed }, { snapshot, authenticated: null });
  for (const change of alternatives) {
    const view = render(<ScopeExample snapshot={snapshot} />);
    const retained = screen.getByRole("textbox", { name: "Retained field" });
    await user.type(retained, "keep this field");
    await user.click(
      screen.getByRole("button", { name: "Begin practice closing" }),
    );
    view.rerender(<ScopeExample {...change} />);
    assert.equal(screen.queryByRole("link", { name: "Finish closing" }), null);
    assert.equal(
      screen.getByRole("textbox", { name: "Retained field" }),
      retained,
    );
    assert.equal((retained as HTMLInputElement).value, "keep this field");
    view.rerender(<ScopeExample snapshot={snapshot} />);
    assert.equal(
      screen.queryByRole("link", { name: "Finish closing" }),
      null,
      "Switching back cannot resurrect the prior task",
    );
    view.unmount();
  }
});

test("restoring real list preferences across routes does not erase the active closing task", async () => {
  const data = fixture();
  const phases: {
    route: string;
    ready: boolean;
    hasTask: boolean;
    publicScopeMissing: boolean;
  }[] = [];
  const recordPhase = (phase: (typeof phases)[number]) => phases.push(phase);
  function Phase({
    route,
    ready,
    publicSnapshot,
  }: {
    route: string;
    ready: boolean;
    publicSnapshot: Snapshot | null;
  }) {
    const closing = useClosingTask();
    useLayoutEffect(() => {
      recordPhase({
        route,
        ready,
        hasTask: !!closing.task,
        publicScopeMissing:
          closingTaskScope(publicSnapshot, data.snapshot.user) === null,
      });
    }, [route, ready, publicSnapshot, closing.task]);
    return <FinishClosingShortcut />;
  }
  function Navigation() {
    const [route, setRoute] = useState("/reports");
    const lists = useListDrafts(data.snapshot.user, route);
    // The operational snapshot remains authoritative while the route's list
    // controls restore. Only list rendering uses the ready-masked snapshot.
    const publicSnapshot = lists.ready ? data.snapshot : null;
    return (
      <Context>
        <PokerManagementContext.Provider
          value={
            {
              ...taskState(data.snapshot),
              snapshot: publicSnapshot,
            } as PokerManagementState
          }
        >
          <ClosingTaskProvider
            scope={closingTaskScope(data.snapshot, data.snapshot.user)}
          >
            <TaskProbe />
            <button
              onClick={() => {
                window.history.replaceState(null, "", "/en/transactions");
                setRoute("/transactions");
              }}
            >
              Visit approvals
            </button>
            <button
              onClick={() => {
                window.history.replaceState(null, "", "/en/players");
                setRoute("/players");
              }}
            >
              Visit players
            </button>
            <Phase
              route={route}
              ready={lists.ready}
              publicSnapshot={publicSnapshot}
            />
          </ClosingTaskProvider>
        </PokerManagementContext.Provider>
      </Context>
    );
  }
  const user = userEvent.setup();
  render(<Navigation />);
  await user.click(
    screen.getByRole("button", { name: "Begin practice closing" }),
  );
  phases.length = 0;
  await user.click(screen.getByRole("button", { name: "Visit approvals" }));
  assert.ok(
    phases.some(
      (phase) =>
        phase.route === "/transactions" &&
        !phase.ready &&
        phase.hasTask &&
        phase.publicScopeMissing,
    ),
    "The real list hook briefly hides its public snapshot without losing the task",
  );
  assert.ok(screen.getByRole("link", { name: "Finish closing" }));
  await user.click(screen.getByRole("button", { name: "Visit players" }));
  assert.ok(
    phases.some(
      (phase) =>
        phase.route === "/players" &&
        !phase.ready &&
        phase.hasTask &&
        phase.publicScopeMissing,
    ),
  );
  assert.ok(screen.getByRole("link", { name: "Finish closing" }));
  assert.deepEqual(data.submissions, []);
});

test("closing checklist links retain the task and Finish closing waits for fresh records before reopening it", async () => {
  const data = fixture();
  const user = userEvent.setup();
  render(<Rehearsal data={data} />);
  await user.click(screen.getByRole("button", { name: /^Close current day/ }));
  const checklist = screen.getByRole("dialog", { name: "Close business day" });
  assert.ok(within(checklist).getByText("1 pending approvals"));
  await user.click(
    within(checklist).getByRole("link", { name: "Review requests" }),
  );
  assert.equal(data.controls?.route(), "/transactions");
  assert.equal(data.controls?.drafts()["tx.status"], "PENDING");
  assert.equal(
    data.controls?.drafts()["tx.day"],
    data.snapshot.store.currentDayId,
  );
  let release!: (snapshot: Snapshot) => void;
  data.gate = new Promise<Snapshot>((resolve) => {
    release = resolve;
  });
  await user.click(screen.getByRole("link", { name: "Finish closing" }));
  assert.equal(
    screen.queryByRole("dialog", { name: "Close business day" }),
    null,
  );
  assert.ok(screen.getByText("Preparing closing checklist…"));
  const fresh = structuredClone(data.snapshot);
  fresh.revision++;
  await act(async () => release(fresh));
  await waitFor(() =>
    assert.ok(screen.getByRole("dialog", { name: "Close business day" })),
  );
  assert.ok(
    data.reads.some(
      ({ query }) =>
        query.resource === "report" && query.dayId === fresh.store.currentDayId,
    ),
  );
  assert.equal(data.controls?.drafts()["report.day"], fresh.store.currentDayId);
  assert.equal(data.controls?.drafts()["report.count"], "");
  assert.deepEqual(data.submissions, []);
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => assert.equal(screen.queryByRole("dialog"), null));
  await user.click(screen.getByRole("button", { name: /^Close current day/ }));
  await user.click(screen.getByRole("link", { name: "Check out players" }));
  assert.equal(data.controls?.route(), "/players");
  assert.equal(data.controls?.drafts()["player.status"], "ACTIVE");
  assert.ok(screen.getByRole("link", { name: "Finish closing" }));
});

test("a late return read cannot reopen a closed or changed business day", async () => {
  const data = fixture();
  const user = userEvent.setup();
  render(<Rehearsal data={data} />);
  await user.click(screen.getByRole("button", { name: /^Close current day/ }));
  await user.click(screen.getByRole("link", { name: "Review requests" }));
  let release!: (snapshot: Snapshot) => void;
  data.gate = new Promise<Snapshot>((resolve) => {
    release = resolve;
  });
  await user.click(screen.getByRole("link", { name: "Finish closing" }));
  const closed = structuredClone(data.snapshot);
  closed.store.days[0].status = "CLOSED";
  closed.revision++;
  await act(async () => release(closed));
  await waitFor(() =>
    assert.equal(screen.queryByText("Preparing closing checklist…"), null),
  );
  assert.equal(
    screen.queryByRole("dialog", { name: "Close business day" }),
    null,
  );
  assert.deepEqual(data.submissions, []);
  await act(async () => data.controls!.setSnapshot(data.snapshot));
  assert.equal(
    screen.queryByRole("dialog", { name: "Close business day" }),
    null,
    "Reopening the old context does not restore the consumed intent",
  );
});

test("failed return reads retain the task for a deliberate retry without reopening or submitting the day", async () => {
  const data = fixture();
  const user = userEvent.setup();
  render(<Rehearsal data={data} />);
  await user.click(screen.getByRole("button", { name: /^Close current day/ }));
  await user.click(screen.getByRole("link", { name: "Review requests" }));
  let reject!: (reason: Error) => void;
  data.gate = new Promise<Snapshot>((_resolve, fail) => {
    reject = fail;
  });
  await user.click(screen.getByRole("link", { name: "Finish closing" }));
  await act(async () => reject(new Error("Fictional read unavailable")));
  await waitFor(() =>
    assert.ok(
      screen
        .getAllByRole("alert")
        .some((entry) =>
          /Fictional read unavailable/.test(entry.textContent ?? ""),
        ),
    ),
  );
  assert.equal(
    screen.queryByRole("dialog", { name: "Close business day" }),
    null,
  );
  assert.deepEqual(data.submissions, []);
  data.gate = null;
  await act(async () => data.controls!.navigate("/transactions"));
  assert.ok(screen.getByRole("link", { name: "Finish closing" }));
  await user.click(screen.getByRole("link", { name: "Finish closing" }));
  await waitFor(() =>
    assert.ok(screen.getByRole("dialog", { name: "Close business day" })),
  );
  assert.deepEqual(data.submissions, []);
});

test("an in-flight return is cancelled across venue changes and cannot revive after switching back", async () => {
  const data = fixture();
  const user = userEvent.setup();
  render(<Rehearsal data={data} />);
  await user.click(screen.getByRole("button", { name: /^Close current day/ }));
  await user.click(screen.getByRole("link", { name: "Review requests" }));
  let release!: (snapshot: Snapshot) => void;
  data.gate = new Promise<Snapshot>((resolve) => {
    release = resolve;
  });
  const beforeReturn = data.reads.length;
  await user.click(screen.getByRole("link", { name: "Finish closing" }));
  const returning = data.reads[beforeReturn];
  assert.equal(returning.query.resource, "report");
  const other = structuredClone(data.snapshot);
  other.branch.id = "other-closing-venue";
  other.user.branchId = other.branch.id;
  await act(async () => data.controls!.setSnapshot(other));
  assert.equal(returning.signal?.aborted, true);
  await act(async () => data.controls!.setSnapshot(data.snapshot));
  await act(async () => release(data.snapshot));
  assert.equal(
    screen.queryByRole("dialog", { name: "Close business day" }),
    null,
  );
  await act(async () => data.controls!.navigate("/transactions"));
  assert.equal(screen.queryByRole("link", { name: "Finish closing" }), null);
  assert.deepEqual(data.submissions, []);
});

test("a confirmed same-day return uses resolved blockers but still requires a fresh cash count and explicit close", async () => {
  const data = fixture();
  const user = userEvent.setup();
  render(<Rehearsal data={data} />);
  await user.click(screen.getByRole("button", { name: /^Close current day/ }));
  await user.click(screen.getByRole("link", { name: "Review requests" }));
  const fresh = structuredClone(data.snapshot);
  const admin = fresh.user;
  const cashier: Staff = {
    ...admin,
    id: "closing-cashier",
    username: "Closing cashier",
    role: "CASHIER",
  };
  fresh.store = applyCommand(
    fresh.store,
    {
      kind: "DECIDE",
      approvalId: fresh.store.approvals[0].id,
      decision: "REJECTED",
      reason: "Fictional rejected buy-in",
    },
    admin,
    "2026-11-04T03:00:00Z",
  );
  fresh.store = applyCommand(
    fresh.store,
    {
      kind: "REQUEST",
      type: "Cash-out",
      amount: 0,
      playerId: fresh.store.profiles[0].id,
      tableId: fresh.store.tables[0].id,
      note: "Fictional zero-chip checkout",
    },
    cashier,
    "2026-11-04T03:00:00Z",
  );
  fresh.store = applyCommand(
    fresh.store,
    {
      kind: "DECIDE",
      approvalId: fresh.store.approvals.find(
        (request) => request.status === "PENDING",
      )!.id,
      decision: "APPROVED",
    },
    admin,
    "2026-11-04T03:00:00Z",
  );
  fresh.revision++;
  data.gate = Promise.resolve(fresh);
  await user.click(screen.getByRole("link", { name: "Finish closing" }));
  const dialog = await screen.findByRole("dialog", {
    name: "Close business day",
  });
  assert.ok(within(dialog).getByText("Ready to close"));
  assert.equal(
    (
      within(dialog).getByRole("textbox", {
        name: "Counted cash (RM)",
      }) as HTMLInputElement
    ).value,
    "",
  );
  assert.equal(
    (
      within(dialog).getByRole("button", {
        name: "Close business day",
      }) as HTMLButtonElement
    ).disabled,
    true,
  );
  assert.equal(fresh.store.days[0].status, "OPEN");
  assert.deepEqual(data.submissions, []);
});
