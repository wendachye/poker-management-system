import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { useState, type ReactNode } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import {
  SortableTableHead,
  type ListSorting,
} from "../../src/components/page/PokerManagementPage/components/sortable-table-head";
import {
  PokerManagementContext,
  type usePokerManagementContext,
} from "../../src/components/page/PokerManagementPage/PokerManagementProvider";
import { useListBrowsing } from "../../src/components/page/PokerManagementPage/components/use-list-browsing";

afterEach(cleanup);

const options = [
  { value: "", label: "Default order" },
  { value: "name", label: "Player name" },
  { value: "status", label: "Status" },
];
const rows = ["Zulu", "Alpha"];

function Locale({
  children,
  locale = "en",
  ui = {},
}: {
  children: ReactNode;
  locale?: string;
  ui?: Record<string, string>;
}) {
  return (
    <NextIntlClientProvider
      locale={locale}
      timeZone="Asia/Kuala_Lumpur"
      messages={{ ui }}
    >
      {children}
    </NextIntlClientProvider>
  );
}

function Table({
  sorting,
  records = rows,
}: {
  sorting: ListSorting;
  records?: string[];
}) {
  return (
    <table>
      <thead>
        <tr>
          <SortableTableHead label="Player" sortKey="name" sorting={sorting} />
          <SortableTableHead
            label="Status"
            sortKey="status"
            sorting={sorting}
          />
          <SortableTableHead
            label="Table / seat"
            sortKey="seat"
            sorting={sorting}
          />
          <SortableTableHead label="Actions" sorting={sorting} align="right" />
        </tr>
      </thead>
      <tbody>
        {records.map((name) => (
          <tr key={name}>
            <td>{name}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

test("native header buttons sort with Enter and Space and announce only the active column", async () => {
  function Example() {
    const [value, setValue] = useState("");
    const [direction, setDirection] = useState<"asc" | "desc">("asc");
    return (
      <Locale>
        <Table
          sorting={{
            value,
            direction,
            options,
            onChange: (key, order) => {
              setValue(key);
              setDirection(order);
            },
          }}
        />
      </Locale>
    );
  }
  const user = userEvent.setup();
  render(<Example />);
  await user.tab();
  const player = screen.getByRole("button", {
    name: "Sort by Player · Ascending",
  });
  assert.equal(document.activeElement, player);
  assert.equal(player.getAttribute("type"), "button");
  await user.keyboard("{Enter}");
  assert.equal(
    screen
      .getByRole("columnheader", { name: "Player" })
      .getAttribute("aria-sort"),
    "ascending",
  );
  assert.equal(document.querySelectorAll("th[aria-sort]").length, 1);
  await user.keyboard(" ");
  assert.equal(
    screen
      .getByRole("columnheader", { name: "Player" })
      .getAttribute("aria-sort"),
    "descending",
  );
  await user.keyboard("{Enter}");
  assert.equal(
    screen
      .getByRole("columnheader", { name: "Player" })
      .getAttribute("aria-sort"),
    "ascending",
  );
  await user.click(
    screen.getByRole("button", { name: "Sort by Status · Ascending" }),
  );
  assert.equal(
    screen
      .getByRole("columnheader", { name: "Status" })
      .getAttribute("aria-sort"),
    "ascending",
  );
  assert.equal(
    screen
      .getByRole("columnheader", { name: "Player" })
      .hasAttribute("aria-sort"),
    false,
  );
});

test("unsupported and action columns remain semantic headers without misleading sort controls", () => {
  render(
    <Locale>
      <Table
        sorting={{ value: "seat", direction: "asc", options, onChange() {} }}
      />
    </Locale>,
  );
  for (const label of ["Table / seat", "Actions"]) {
    const header = screen.getByRole("columnheader", { name: label });
    assert.equal(header.getAttribute("scope"), "col");
    assert.equal(within(header).queryByRole("button"), null);
    assert.equal(header.hasAttribute("aria-sort"), false);
  }
  assert.equal(document.querySelectorAll("th[aria-sort]").length, 0);
});

test("controlled sorting delegates to the caller without reordering its current server page", async () => {
  const calls: [string, "asc" | "desc"][] = [];
  const user = userEvent.setup();
  render(
    <Locale>
      <Table
        sorting={{
          value: "name",
          direction: "asc",
          options,
          onChange: (key, order) => calls.push([key, order]),
        }}
      />
    </Locale>,
  );
  await user.click(
    screen.getByRole("button", { name: "Sort by Player · Descending" }),
  );
  assert.deepEqual(calls, [["name", "desc"]]);
  assert.deepEqual(
    screen.getAllByRole("cell").map((cell) => cell.textContent),
    rows,
  );
});

test("a controlled header keeps its keyboard focus while the table body is held empty", async () => {
  const sorting: ListSorting = {
    value: "name",
    direction: "asc",
    options,
    onChange() {},
  };
  const user = userEvent.setup();
  const view = render(
    <Locale>
      <Table sorting={sorting} />
    </Locale>,
  );
  const header = screen.getByRole("button", {
    name: "Sort by Player · Descending",
  });
  await user.click(header);
  view.rerender(
    <Locale>
      <Table sorting={{ ...sorting, direction: "desc" }} records={[]} />
    </Locale>,
  );
  assert.equal(document.activeElement, header);
  assert.equal(
    screen.getByRole("button", { name: "Sort by Player · Ascending" }),
    header,
  );
  assert.equal(screen.queryAllByRole("cell").length, 0);
  assert.equal(
    screen
      .getByRole("columnheader", { name: "Player" })
      .getAttribute("aria-sort"),
    "descending",
  );
});

test("translated sort actions and column names remain readable without decorative icons", () => {
  render(
    <Locale
      locale="zh"
      ui={{
        player: "玩家",
        sort_by: "排序方式",
        ascending: "升序",
        descending: "降序",
      }}
    >
      <Table
        sorting={{ value: "name", direction: "asc", options, onChange() {} }}
      />
    </Locale>,
  );
  const header = screen.getByRole("columnheader", { name: "玩家" });
  assert.equal(header.getAttribute("aria-sort"), "ascending");
  assert.ok(screen.getByRole("button", { name: "排序方式 玩家 · 降序" }));
  for (const icon of document.querySelectorAll("th svg"))
    assert.equal(icon.getAttribute("aria-hidden"), "true");
});

test("header and advanced sorting share the existing allowlist and retain filters while resetting pagination", async () => {
  function Example() {
    const [drafts, setDrafts] = useState<Record<string, string>>({
      "player.search": "Alex",
      "player.page": "3",
      "player.pageSize": "50",
    });
    const state = {
      draft: (key: string, fallback = "") => drafts[key] ?? fallback,
      setDraft: (key: string, value: string) =>
        setDrafts((previous) => ({ ...previous, [key]: value })),
    } as unknown as ReturnType<typeof usePokerManagementContext>;
    return (
      <Locale>
        <PokerManagementContext.Provider value={state}>
          <Browsing />
          <output aria-label="Drafts">{JSON.stringify(drafts)}</output>
        </PokerManagementContext.Provider>
      </Locale>
    );
  }
  function Browsing() {
    const browsing = useListBrowsing("players", "player");
    return (
      <>
        <Table sorting={browsing.sorting} />
        {browsing.controls}
        <button
          onClick={() => browsing.sorting.onChange("unsupported", "desc")}
        >
          Unsupported sort
        </button>
      </>
    );
  }
  const user = userEvent.setup();
  render(<Example />);
  await user.click(
    screen.getByRole("button", { name: "Sort by Player · Ascending" }),
  );
  const selected = () =>
    JSON.parse(screen.getByLabelText("Drafts").textContent!);
  assert.deepEqual(selected(), {
    "player.search": "Alex",
    "player.page": "0",
    "player.pageSize": "50",
    "player.sort": "name",
    "player.direction": "asc",
  });
  await user.click(screen.getByRole("button", { name: "Unsupported sort" }));
  assert.equal(selected()["player.sort"], "name");
  await user.click(screen.getByRole("button", { name: "Sort by" }));
  await user.click(
    screen.getByRole("menuitemradio", { name: "Default order" }),
  );
  assert.equal(selected()["player.sort"], "");
  assert.equal(selected()["player.direction"], "");
  assert.equal(selected()["player.search"], "Alex");
  assert.equal(selected()["player.pageSize"], "50");
  assert.equal(document.querySelectorAll("th[aria-sort]").length, 0);
});
