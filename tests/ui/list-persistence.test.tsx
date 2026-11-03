import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { useState } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useListDrafts } from "../../src/components/page/PokerManagementPage/components/use-list-drafts";
import {
  ListOrderControls,
  ListPager,
} from "../../src/components/page/PokerManagementPage/components/list-order-controls";
import type { Staff } from "../../src/domain/model";
import { listSortOptions } from "../../src/domain/list-sort";

const cashier = {
  id: "ui-staff-a",
  branchId: "venue-a",
  role: "CASHIER" as const,
};
type Access = Pick<Staff, "id" | "branchId" | "role">;

function Example({ access = cashier }: { access?: Access | null }) {
  const state = useListDrafts(access, "/players");
  if (!state.ready) return <p role="status">Restoring list</p>;
  return (
    <>
      <label>
        Search players
        <input
          type="search"
          value={state.draft("player.search")}
          onChange={(event) =>
            state.patchDrafts({
              "player.search": event.target.value,
              "player.page": "0",
            })
          }
        />
      </label>
      <label>
        Player status
        <select
          value={state.draft("player.status")}
          onChange={(event) =>
            state.patchDrafts({
              "player.status": event.target.value,
              "player.page": "0",
            })
          }
        >
          <option value="">All players</option>
          <option value="ACTIVE">In-house</option>
          <option value="OUT">Checked out</option>
        </select>
      </label>
      <ListOrderControls
        options={[
          { value: "", label: "Default order" },
          { value: "name", label: "Player name" },
        ]}
        value={state.draft("player.sort")}
        direction={state.draft("player.direction", "asc") as "asc" | "desc"}
        onChange={(sort, direction) =>
          state.patchDrafts({
            "player.sort": sort,
            "player.direction": direction,
            "player.page": "0",
          })
        }
      />
      <ListPager
        page={Number(state.draft("player.page", "0"))}
        total={101}
        setPage={(page) => state.setDraft("player.page", String(page))}
        pageSize={Number(state.draft("player.pageSize", "20"))}
        onPageSizeChange={(size) =>
          state.setDraft("player.pageSize", String(size))
        }
        label="Player pages"
      />
      <button
        type="button"
        onClick={() => {
          state.setDraft("player.search", "Alex");
          state.setDraft("player.status", "ACTIVE");
          state.setDraft("player.page", "2");
        }}
      >
        Restore saved view
      </button>
    </>
  );
}

beforeEach(() => {
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/en/players");
});
afterEach(cleanup);

test("search, filters and selected page size survive a list remount", async () => {
  const user = userEvent.setup();
  const view = render(<Example />);
  await user.type(
    screen.getByRole("searchbox", { name: "Search players" }),
    "Alex",
  );
  await user.selectOptions(
    screen.getByRole("combobox", { name: "Player status" }),
    "ACTIVE",
  );
  await user.click(screen.getByRole("combobox", { name: /Rows per page/ }));
  await user.keyboard("{End}{Enter}");
  await user.click(screen.getByRole("button", { name: "Next page" }));
  await waitFor(() =>
    assert.equal(
      new URLSearchParams(window.location.search).get("player.page"),
      "2",
    ),
  );
  view.unmount();
  render(<Example />);
  assert.equal(
    (
      screen.getByRole("searchbox", {
        name: "Search players",
      }) as HTMLInputElement
    ).value,
    "Alex",
  );
  assert.equal(
    (
      screen.getByRole("combobox", {
        name: "Player status",
      }) as HTMLSelectElement
    ).value,
    "ACTIVE",
  );
  assert.equal(
    screen.getByRole("combobox", { name: /Rows per page/ }).textContent,
    "50",
  );
  assert.ok(screen.getByText("Showing 51–100 of 101"));
});

test("browser back restores the earlier page and filter controls", async () => {
  const user = userEvent.setup();
  render(<Example />);
  await user.selectOptions(
    screen.getByRole("combobox", { name: "Player status" }),
    "ACTIVE",
  );
  await user.click(screen.getByRole("button", { name: "Next page" }));
  assert.ok(screen.getByText("Showing 21–40 of 101"));
  await act(async () => {
    window.history.back();
  });
  await waitFor(() => assert.ok(screen.getByText("Showing 1–20 of 101")));
  assert.equal(
    (
      screen.getByRole("combobox", {
        name: "Player status",
      }) as HTMLSelectElement
    ).value,
    "ACTIVE",
  );
});

for (const [scope, access] of [
  ["staff member", { ...cashier, id: "ui-staff-b" }],
  ["venue", { ...cashier, branchId: "venue-b" }],
  ["role", { ...cashier, role: "MANAGER" as const }],
] as const) {
  test(`switching ${scope} keeps list preferences separate`, async () => {
    const user = userEvent.setup();
    const view = render(<Example />);
    await user.type(
      screen.getByRole("searchbox", { name: "Search players" }),
      "Alex",
    );
    view.rerender(<Example access={access} />);
    assert.equal(
      (
        screen.getByRole("searchbox", {
          name: "Search players",
        }) as HTMLInputElement
      ).value,
      "",
    );
    assert.equal(
      new URLSearchParams(window.location.search).get("listVenue"),
      access.branchId,
    );
    view.rerender(<Example />);
    assert.equal(
      (
        screen.getByRole("searchbox", {
          name: "Search players",
        }) as HTMLInputElement
      ).value,
      "Alex",
    );
  });
}

test("browser back after an account switch cannot restore the previous staff member's search", async () => {
  const user = userEvent.setup();
  const view = render(<Example />);
  await user.type(
    screen.getByRole("searchbox", { name: "Search players" }),
    "Alex",
  );
  await user.selectOptions(
    screen.getByRole("combobox", { name: "Player status" }),
    "ACTIVE",
  );
  view.rerender(<Example access={{ ...cashier, id: "ui-staff-b" }} />);
  await user.type(
    screen.getByRole("searchbox", { name: "Search players" }),
    "Ben",
  );
  await act(async () => {
    const navigation = new Promise<void>((resolve) =>
      window.addEventListener("popstate", () => resolve(), { once: true }),
    );
    window.history.back();
    await navigation;
  });
  await waitFor(() =>
    assert.equal(
      new URLSearchParams(window.location.search).get("player.search"),
      "Ben",
    ),
  );
  assert.equal(
    (
      screen.getByRole("searchbox", {
        name: "Search players",
      }) as HTMLInputElement
    ).value,
    "Ben",
  );
});

test("a bookmark restores valid criteria while invalid sorting and sizes show safe defaults", () => {
  window.history.replaceState(
    null,
    "",
    "/en/players?listVenue=venue-a&player.search=Alex&player.status=ACTIVE&player.sort=DROP%20TABLE&player.direction=sideways&player.pageSize=5000&player.page=invalid",
  );
  render(<Example />);
  assert.equal(
    (
      screen.getByRole("searchbox", {
        name: "Search players",
      }) as HTMLInputElement
    ).value,
    "Alex",
  );
  assert.equal(
    (
      screen.getByRole("combobox", {
        name: "Player status",
      }) as HTMLSelectElement
    ).value,
    "ACTIVE",
  );
  assert.equal(
    screen.getByRole("combobox", { name: "Sort by" }).textContent,
    "Default order",
  );
  assert.equal(
    screen.getByRole("combobox", { name: /Rows per page/ }).textContent,
    "20",
  );
  assert.ok(screen.getByText("Showing 1–20 of 101"));
});

test("changing search, a filter or sorting returns staff to the first page", async () => {
  const user = userEvent.setup();
  render(<Example />);
  await user.click(screen.getByRole("button", { name: "Next page" }));
  await user.type(
    screen.getByRole("searchbox", { name: "Search players" }),
    "Alex",
  );
  assert.ok(screen.getByText("Showing 1–20 of 101"));
  await user.click(screen.getByRole("button", { name: "Next page" }));
  await user.selectOptions(
    screen.getByRole("combobox", { name: "Player status" }),
    "ACTIVE",
  );
  assert.ok(screen.getByText("Showing 1–20 of 101"));
  await user.click(screen.getByRole("button", { name: "Next page" }));
  await user.click(screen.getByRole("combobox", { name: "Sort by" }));
  await user.keyboard("{End}{Enter}");
  assert.ok(screen.getByText("Showing 1–20 of 101"));
  await waitFor(() => {
    const criteria = new URLSearchParams(window.location.search);
    assert.equal(criteria.get("player.search"), "Alex");
    assert.equal(criteria.get("player.status"), "ACTIVE");
    assert.equal(criteria.get("player.sort"), "name");
    assert.equal(criteria.get("player.page"), "1");
  });
});

test("returning without a query restores staff preferences from session storage", async () => {
  const user = userEvent.setup();
  const view = render(<Example />);
  await user.type(
    screen.getByRole("searchbox", { name: "Search players" }),
    "Alex",
  );
  await user.click(screen.getByRole("button", { name: "Next page" }));
  view.unmount();
  window.history.replaceState(null, "", "/en/players");
  render(<Example />);
  assert.equal(
    (
      screen.getByRole("searchbox", {
        name: "Search players",
      }) as HTMLInputElement
    ).value,
    "Alex",
  );
  assert.ok(screen.getByText("Showing 21–40 of 101"));
});

test("a single action can update several criteria without losing the earlier changes", async () => {
  const user = userEvent.setup();
  render(<Example />);
  await user.click(screen.getByRole("button", { name: "Restore saved view" }));
  assert.equal(
    (
      screen.getByRole("searchbox", {
        name: "Search players",
      }) as HTMLInputElement
    ).value,
    "Alex",
  );
  assert.equal(
    (
      screen.getByRole("combobox", {
        name: "Player status",
      }) as HTMLSelectElement
    ).value,
    "ACTIVE",
  );
  assert.ok(screen.getByText("Showing 41–60 of 101"));
  await waitFor(() => {
    const criteria = new URLSearchParams(window.location.search);
    assert.equal(criteria.get("player.search"), "Alex");
    assert.equal(criteria.get("player.status"), "ACTIVE");
    assert.equal(criteria.get("player.page"), "3");
  });
});

test("search and URL restoration remain usable when browser storage is denied", async () => {
  const prototype = window.Storage.prototype;
  const get = Object.getOwnPropertyDescriptor(prototype, "getItem")!;
  const set = Object.getOwnPropertyDescriptor(prototype, "setItem")!;
  const denied = () => {
    throw new window.DOMException("Storage denied", "SecurityError");
  };
  Object.defineProperty(prototype, "getItem", { ...get, value: denied });
  Object.defineProperty(prototype, "setItem", { ...set, value: denied });
  try {
    const user = userEvent.setup();
    const view = render(<Example />);
    await user.type(
      screen.getByRole("searchbox", { name: "Search players" }),
      "Alex",
    );
    await waitFor(() =>
      assert.equal(
        new URLSearchParams(window.location.search).get("player.search"),
        "Alex",
      ),
    );
    view.unmount();
    render(<Example />);
    assert.equal(
      (
        screen.getByRole("searchbox", {
          name: "Search players",
        }) as HTMLInputElement
      ).value,
      "Alex",
    );
  } finally {
    Object.defineProperty(prototype, "getItem", get);
    Object.defineProperty(prototype, "setItem", set);
  }
});

test("a pending-request shortcut preserves an explicit all-days filter across routes", async () => {
  function ShortcutExample({ initialPath = "/players" }) {
    const [path, setPath] = useState(initialPath);
    const state = useListDrafts(cashier, path);
    if (!state.ready) return <p role="status">Restoring list</p>;
    return path === "/players" ? (
      <button
        type="button"
        onClick={() => {
          state.patchDrafts({ "tx.day": "", "tx.status": "MINE" });
          window.history.pushState(null, "", "/en/transactions");
          setPath("/transactions");
        }}
      >
        View my pending requests
      </button>
    ) : (
      <>
        <output aria-label="Request filter">{state.draft("tx.status")}</output>
        <output aria-label="Request day">
          {state.draft("tx.day", "current-day") || "All days"}
        </output>
      </>
    );
  }
  const user = userEvent.setup();
  const view = render(<ShortcutExample />);
  await user.click(
    screen.getByRole("button", { name: "View my pending requests" }),
  );
  assert.equal(screen.getByLabelText("Request filter").textContent, "MINE");
  assert.equal(screen.getByLabelText("Request day").textContent, "All days");
  view.unmount();
  render(<ShortcutExample initialPath="/transactions" />);
  assert.equal(screen.getByLabelText("Request filter").textContent, "MINE");
  assert.equal(screen.getByLabelText("Request day").textContent, "All days");
});

test("switching transaction queues removes unsupported sorting and retains shared fields", async () => {
  function TransactionExample() {
    const state = useListDrafts(cashier, "/transactions");
    const status = state.draft("tx.status", "PENDING");
    if (!state.ready) return <p role="status">Restoring list</p>;
    return (
      <>
        <label>
          Transaction queue
          <select
            value={status}
            onChange={(event) =>
              state.patchDrafts({
                "tx.status": event.target.value,
                "tx.page": "0",
              })
            }
          >
            <option value="APPROVED">Posted transactions</option>
            <option value="PENDING">Pending requests</option>
          </select>
        </label>
        <ListOrderControls
          options={listSortOptions(
            status === "APPROVED" ? "transactions" : "requests",
          )}
          value={state.draft("tx.sort")}
          direction={state.draft("tx.direction", "asc") as "asc" | "desc"}
          onChange={(sort, direction) =>
            state.patchDrafts({
              "tx.sort": sort,
              "tx.direction": direction,
              "tx.page": "0",
            })
          }
        />
      </>
    );
  }
  window.history.replaceState(
    null,
    "",
    "/en/transactions?listVenue=venue-a&tx.status=APPROVED&tx.sort=time",
  );
  const user = userEvent.setup();
  render(<TransactionExample />);
  assert.equal(
    screen.getByRole("combobox", { name: "Sort by" }).textContent,
    "Date",
  );
  const queue = screen.getByRole("combobox", { name: "Transaction queue" });
  await user.selectOptions(queue, "PENDING");
  assert.equal(
    screen.getByRole("combobox", { name: "Sort by" }).textContent,
    "Default order",
  );
  await user.click(screen.getByRole("combobox", { name: "Sort by" }));
  await user.click(screen.getByRole("option", { name: "Amount" }));
  await user.selectOptions(queue, "APPROVED");
  await user.selectOptions(queue, "PENDING");
  assert.equal(
    screen.getByRole("combobox", { name: "Sort by" }).textContent,
    "Amount",
  );
});
