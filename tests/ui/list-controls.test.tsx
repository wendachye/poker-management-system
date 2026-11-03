import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { useState } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { ListToolbar } from "../../src/components/page/PokerManagementPage/components/list-toolbar";
import {
  ListOrderControls,
  ListPager,
} from "../../src/components/page/PokerManagementPage/components/list-order-controls";

afterEach(cleanup);

test("sorting stays separate from Filters and supports field, direction and default order", async () => {
  function Example() {
    const [sort, setSort] = useState("");
    const [direction, setDirection] = useState<"asc" | "desc">("asc");
    return (
      <NextIntlClientProvider
        locale="en"
        timeZone="Asia/Kuala_Lumpur"
        messages={{}}
      >
        <ListToolbar
          search=""
          searchLabel="Search players"
          searchPlaceholder="Name or phone"
          onSearchChange={() => {}}
          onClear={() => {}}
          resultCount={3}
          orderControls={
            <ListOrderControls
              options={[
                { value: "", label: "Default order" },
                { value: "sessionStart", label: "Check-in time" },
              ]}
              value={sort}
              direction={direction}
              onChange={(next, order) => {
                setSort(next);
                setDirection(order);
              }}
            />
          }
        >
          <label>
            Tag
            <input type="text" />
          </label>
        </ListToolbar>
        <output aria-label="Selected order">
          {sort} {direction}
        </output>
      </NextIntlClientProvider>
    );
  }
  const user = userEvent.setup();
  render(<Example />);
  assert.equal(screen.queryByRole("combobox", { name: "Sort by" }), null);
  await user.click(
    screen.getByRole("button", { name: "Filters · Search players" }),
  );
  const filters = screen.getByRole("dialog", {
    name: "Filters · Search players",
  });
  assert.ok(within(filters).getByRole("textbox", { name: "Tag" }));
  assert.equal(within(filters).queryByText("Sort by"), null);
  assert.equal(within(filters).queryByRole("combobox"), null);
  assert.equal(within(filters).queryByRole("menuitemradio"), null);
  await user.click(
    within(filters).getByRole("button", { name: "Show 3 results" }),
  );
  const sortButton = screen.getByRole("button", { name: "Sort by" });
  await user.click(sortButton);
  assert.equal(
    screen
      .getByRole("menuitemradio", { name: "Descending" })
      .getAttribute("aria-disabled"),
    "true",
  );
  await user.click(
    screen.getByRole("menuitemradio", { name: "Check-in time" }),
  );
  assert.equal(
    screen.getByLabelText("Selected order").textContent,
    "sessionStart asc",
  );
  await user.click(screen.getByRole("menuitemradio", { name: "Descending" }));
  assert.equal(
    screen.getByLabelText("Selected order").textContent,
    "sessionStart desc",
  );
  await user.keyboard("{Escape}");
  assert.equal(screen.queryByRole("menu"), null);
  assert.equal(document.activeElement, sortButton);
  assert.equal(
    sortButton.getAttribute("aria-description"),
    "Check-in time · Descending",
  );
  await user.click(sortButton);
  assert.equal(
    screen
      .getByRole("menuitemradio", { name: "Check-in time" })
      .getAttribute("aria-checked"),
    "true",
  );
  await user.click(
    screen.getByRole("menuitemradio", { name: "Default order" }),
  );
  assert.equal(screen.getByLabelText("Selected order").textContent, " asc");
  await user.keyboard("{Escape}");
  assert.equal(sortButton.getAttribute("aria-description"), "Default order");
});

test("a sorting-only toolbar does not show an empty Filters panel", () => {
  render(
    <NextIntlClientProvider
      locale="en"
      timeZone="Asia/Kuala_Lumpur"
      messages={{}}
    >
      <ListToolbar
        search=""
        searchPlaceholder="Name"
        onSearchChange={() => {}}
        onClear={() => {}}
        resultCount={2}
        orderControls={
          <ListOrderControls
            options={[{ value: "", label: "Default order" }]}
            value=""
            direction="asc"
            onChange={() => {}}
          />
        }
      />
    </NextIntlClientProvider>,
  );
  assert.ok(screen.getByRole("button", { name: "Sort by" }));
  assert.equal(screen.queryByRole("button", { name: /Filters/ }), null);
});

test("list result status distinguishes pending, confirmed zero and unavailable results without losing search focus", async () => {
  function Example({
    count,
    loading,
  }: {
    count: number | null;
    loading: boolean;
  }) {
    const [search, setSearch] = useState("Aaron");
    return (
      <NextIntlClientProvider
        locale="en"
        timeZone="Asia/Kuala_Lumpur"
        messages={{}}
      >
        <ListToolbar
          search={search}
          searchLabel="Search players"
          searchPlaceholder="Name or phone"
          onSearchChange={setSearch}
          onClear={() => setSearch("")}
          resultCount={count}
          loading={loading}
        />
      </NextIntlClientProvider>
    );
  }
  const user = userEvent.setup();
  const view = render(<Example count={null} loading />);
  assert.equal(screen.getByRole("status").textContent, "Updating results…");
  assert.equal(screen.getByRole("status").getAttribute("aria-busy"), "true");
  const search = screen.getByRole("searchbox", { name: "Search players" });
  await user.click(search);
  view.rerender(<Example count={0} loading={false} />);
  assert.equal(screen.getByRole("status").textContent, "0 results");
  assert.equal(document.activeElement === search, true);
  view.rerender(<Example count={null} loading={false} />);
  assert.equal(screen.getByRole("status").textContent, "Results unavailable");
  assert.equal(document.activeElement === search, true);
  await user.type(search, " Tan");
  assert.equal((search as HTMLInputElement).value, "Aaron Tan");
  view.rerender(<Example count={1} loading={false} />);
  assert.equal(screen.getByRole("status").textContent, "1 result");
});

test("staff can close filters while counts are pending without a fabricated result total", async () => {
  function Example({ count }: { count: number | null }) {
    const [search, setSearch] = useState("");
    return (
      <NextIntlClientProvider
        locale="en"
        timeZone="Asia/Kuala_Lumpur"
        messages={{}}
      >
        <ListToolbar
          search={search}
          searchLabel="Search players"
          searchPlaceholder="Name or phone"
          onSearchChange={setSearch}
          onClear={() => setSearch("")}
          resultCount={count}
          loading={count === null}
        >
          <label>
            Tag
            <input type="text" />
          </label>
        </ListToolbar>
      </NextIntlClientProvider>
    );
  }
  const user = userEvent.setup();
  const view = render(<Example count={null} />);
  await user.click(
    screen.getByRole("button", { name: "Filters · Search players" }),
  );
  assert.ok(screen.getByRole("textbox", { name: "Tag" }));
  const done = screen.getByRole("button", { name: "Done" });
  assert.equal((done as HTMLButtonElement).disabled, false);
  assert.equal(
    !!screen.queryByRole("button", { name: /Show.*results/ }),
    false,
  );
  await user.click(done);
  assert.equal(!!screen.queryByRole("textbox", { name: "Tag" }), false);
  view.rerender(<Example count={0} />);
  await user.click(
    screen.getByRole("button", { name: "Filters · Search players" }),
  );
  assert.ok(screen.getByRole("button", { name: "Show 0 results" }));
});

test("staff can change rows per page with the keyboard and return to the first page", async () => {
  function Example() {
    const [page, setPage] = useState(2);
    const [size, setSize] = useState(20);
    return (
      <ListPager
        page={page}
        total={61}
        setPage={setPage}
        pageSize={size}
        onPageSizeChange={setSize}
      />
    );
  }
  const user = userEvent.setup();
  render(<Example />);
  assert.ok(screen.getByText("Showing 41–60 of 61"));
  await user.click(screen.getByRole("combobox", { name: /Rows per page/ }));
  await user.keyboard("{End}{Enter}");
  assert.ok(screen.getByText("Showing 1–50 of 61"));
  assert.equal(
    (screen.getByRole("button", { name: "Previous page" }) as HTMLButtonElement)
      .disabled,
    true,
  );
});

test("staff can select a sort field with the keyboard and change its direction", async () => {
  function Example() {
    const [sort, setSort] = useState("");
    const [direction, setDirection] = useState<"asc" | "desc">("asc");
    return (
      <>
        <ListOrderControls
          options={[
            { value: "", label: "Default order" },
            { value: "name", label: "Player name" },
            { value: "credit", label: "Outstanding credit" },
          ]}
          value={sort}
          direction={direction}
          onChange={(next, order) => {
            setSort(next);
            setDirection(order);
          }}
        />
        <output aria-label="Selected order">
          {sort} {direction}
        </output>
      </>
    );
  }
  const user = userEvent.setup();
  render(<Example />);
  await user.click(screen.getByRole("button", { name: "Sort by" }));
  await user.keyboard("{Home}{ArrowDown}{ArrowDown}{Enter}");
  assert.equal(
    screen.getByLabelText("Selected order").textContent,
    "credit asc",
  );
  await user.click(screen.getByRole("menuitemradio", { name: "Descending" }));
  assert.equal(
    screen.getByLabelText("Selected order").textContent,
    "credit desc",
  );
  await user.keyboard("{Escape}");
  assert.equal(screen.queryByRole("menu"), null);
  assert.equal(
    document.activeElement,
    screen.getByRole("button", { name: "Sort by" }),
  );
});

test("page-size controls stay available after filtering to one page or no results", async () => {
  function Example() {
    const [size, setSize] = useState(20);
    return (
      <ListPager
        page={0}
        total={0}
        setPage={() => {}}
        pageSize={size}
        onPageSizeChange={setSize}
        label="Player pages"
      />
    );
  }
  const user = userEvent.setup();
  render(<Example />);
  assert.ok(screen.getByText("Showing 0–0 of 0"));
  assert.equal(
    screen.queryByRole("navigation", { name: "Player pages" }),
    null,
  );
  await user.click(
    screen.getByRole("combobox", { name: "Rows per page · Player pages" }),
  );
  await user.keyboard("{End}{Enter}");
  assert.equal(
    screen.getByRole("combobox", { name: "Rows per page · Player pages" })
      .textContent,
    "50",
  );
});

test("unknown results keep page-size controls usable without inventing an empty page", async () => {
  function Example() {
    const [size, setSize] = useState(20);
    const [page, setPage] = useState(2);
    return (
      <>
        <ListPager
          page={page}
          total={null}
          loading
          setPage={setPage}
          pageSize={size}
          onPageSizeChange={setSize}
          label="Player pages"
        />
        <output aria-label="Requested page">{page + 1}</output>
      </>
    );
  }
  const user = userEvent.setup();
  render(<Example />);
  assert.equal(
    !!screen.queryByText(/^Showing/),
    false,
    "No result range is known yet",
  );
  assert.equal(
    screen.queryByRole("navigation", { name: "Player pages" }),
    null,
  );
  await user.click(
    screen.getByRole("combobox", { name: "Rows per page · Player pages" }),
  );
  await user.keyboard("{End}{Enter}");
  assert.equal(
    screen.getByRole("combobox", { name: "Rows per page · Player pages" })
      .textContent,
    "50",
  );
  assert.equal(screen.getByLabelText("Requested page").textContent, "1");
  assert.equal(!!screen.queryByText(/^Showing/), false);
});

test("pagination uses the complete result total and keeps first/last boundaries usable", async () => {
  function Example() {
    const [page, setPage] = useState(0);
    return (
      <ListPager
        page={page}
        total={61}
        setPage={setPage}
        label="Player pages"
      />
    );
  }
  const user = userEvent.setup();
  render(<Example />);
  await user.click(screen.getByRole("button", { name: "Last page" }));
  assert.ok(screen.getByText("Showing 61–61 of 61"));
  assert.equal(
    (screen.getByRole("button", { name: "Next page" }) as HTMLButtonElement)
      .disabled,
    true,
  );
  await user.click(screen.getByRole("button", { name: "Previous page" }));
  assert.ok(screen.getByText("Showing 41–60 of 61"));
  await user.click(screen.getByRole("button", { name: "First page" }));
  assert.ok(screen.getByText("Showing 1–20 of 61"));
  assert.equal(
    (screen.getByRole("button", { name: "Previous page" }) as HTMLButtonElement)
      .disabled,
    true,
  );
});

test("small legacy lists keep their original pager-free layout", () => {
  render(<ListPager page={0} total={12} setPage={() => {}} />);
  assert.equal(screen.queryByRole("combobox"), null);
  assert.equal(screen.queryByRole("navigation"), null);
});

test("choosing default order clears the field and disables inapplicable direction choices", async () => {
  function Example() {
    const [sort, setSort] = useState("name");
    const [direction, setDirection] = useState<"asc" | "desc">("desc");
    return (
      <>
        <ListOrderControls
          options={[
            { value: "", label: "Default order" },
            { value: "name", label: "Player name" },
          ]}
          value={sort}
          direction={direction}
          onChange={(next, order) => {
            setSort(next);
            setDirection(order);
          }}
        />
        <output aria-label="Selected order">
          {sort || "default"} {direction}
        </output>
      </>
    );
  }
  const user = userEvent.setup();
  render(<Example />);
  await user.click(screen.getByRole("button", { name: "Sort by" }));
  await user.keyboard("{Home}{Enter}");
  assert.equal(
    screen.getByLabelText("Selected order").textContent,
    "default asc",
  );
  assert.equal(
    screen
      .getByRole("menuitemradio", { name: "Ascending" })
      .getAttribute("aria-disabled"),
    "true",
  );
  assert.equal(
    screen
      .getByRole("menuitemradio", { name: "Descending" })
      .getAttribute("aria-disabled"),
    "true",
  );
});

test("translated labels identify nested list controls without relying on icons", async () => {
  const words: Record<string, string> = {
    "Rows per page": "每页行数",
    "Player pages": "玩家分页",
    "Sort by": "排序依据",
    "Player name": "玩家姓名",
    Ascending: "升序",
    "Change sort direction": "切换排序方向",
  };
  const t = (value: string) => words[value] ?? value;
  render(
    <>
      <ListPager
        page={0}
        total={61}
        setPage={() => {}}
        onPageSizeChange={() => {}}
        label="Player pages"
        t={t}
      />
      <ListOrderControls
        options={[{ value: "name", label: "Player name" }]}
        value="name"
        direction="asc"
        onChange={() => {}}
        t={t}
      />
    </>,
  );
  assert.ok(screen.getByRole("combobox", { name: "每页行数 · 玩家分页" }));
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "排序依据" }));
  assert.equal(
    screen
      .getByRole("menuitemradio", { name: "玩家姓名" })
      .getAttribute("aria-checked"),
    "true",
  );
  assert.equal(
    screen
      .getByRole("menuitemradio", { name: "升序" })
      .getAttribute("aria-checked"),
    "true",
  );
});
