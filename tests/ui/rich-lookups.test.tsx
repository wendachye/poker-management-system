import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { useState, type ReactNode } from "react";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import {
  Field,
  SearchSelect,
  Select,
} from "../../src/components/page/PokerManagementPage/components/shared";
import type { SearchChoiceOption } from "../../src/lib/operation-form-options";

afterEach(cleanup);

function Locale({
  children,
  ui = {},
}: {
  children: ReactNode;
  ui?: Record<string, string>;
}) {
  return (
    <NextIntlClientProvider
      locale="en"
      timeZone="Asia/Kuala_Lumpur"
      messages={{ ui }}
    >
      {children}
    </NextIntlClientProvider>
  );
}

const choices: SearchChoiceOption[] = [
  { value: "", label: "Select player" },
  {
    value: "player-cash",
    label: "Alex Tan",
    description: "+12025550101 · Cash · Main floor · Seat 1",
    phoneNumbers: ["+12025550101"],
    searchTerms: ["Sample · Alex Tan"],
  },
  {
    value: "player-credit",
    label: "Alex Tan",
    description: "+12025550102 · Credit · Lounge · Seat 2",
    phoneNumbers: ["+12025550102"],
  },
  {
    value: "blocked-player",
    label: "Blocked player",
    description: "Unavailable credit account",
    disabled: true,
  },
];

function PlayerPicker({ initial = "" }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <Locale>
      <Field label="Player">
        <SearchSelect
          required
          options={choices}
          value={value}
          onValueChange={setValue}
        />
      </Field>
      <output aria-label="Selected identity">{value}</output>
    </Locale>
  );
}

test("two-line options distinguish duplicate player names and keyboard selection preserves identity", async () => {
  const user = userEvent.setup();
  render(<PlayerPicker />);
  const trigger = screen.getByRole("combobox", { name: "Player" });
  assert.equal(trigger.getAttribute("aria-required"), "true");
  assert.equal(trigger.getAttribute("data-required"), "true");
  await user.click(trigger);
  assert.ok(screen.getByRole("option", { name: /Alex Tan.*Cash/ }));
  assert.ok(screen.getByRole("option", { name: /Alex Tan.*Credit/ }));
  await user.type(
    screen.getByRole("combobox", { name: "Search by name or phone" }),
    "lounge credit",
  );
  assert.equal(screen.queryByRole("option", { name: /Alex Tan.*Cash/ }), null);
  await user.keyboard("{ArrowDown}{Enter}");
  assert.equal(
    screen.getByLabelText("Selected identity").textContent,
    "player-credit",
  );
  assert.equal(trigger.textContent, "Alex Tan");
  assert.equal(
    screen.getByRole("combobox", {
      name: "Player",
      description: choices[2].description,
    }),
    trigger,
  );
  assert.equal(trigger.getAttribute("data-value"), "player-credit");
});

test("phone lookup still matches formatted phone digits after moving context out of the player label", async () => {
  const user = userEvent.setup();
  render(<PlayerPicker />);
  await user.click(screen.getByRole("combobox", { name: "Player" }));
  await user.type(
    screen.getByRole("combobox", { name: "Search by name or phone" }),
    "+1 (202) 555-0101",
  );
  const result = screen.getByRole("option", { name: /Alex Tan.*Cash/ });
  assert.ok(within(result).getByText(choices[1].description!));
  assert.equal(
    screen.queryByRole("option", { name: /Alex Tan.*Credit/ }),
    null,
  );
  await user.keyboard("{Enter}");
  assert.equal(
    screen.getByLabelText("Selected identity").textContent,
    "player-cash",
  );
});

test("disabled lookup results cannot be selected with the keyboard", async () => {
  const user = userEvent.setup();
  render(<PlayerPicker />);
  await user.click(screen.getByRole("combobox", { name: "Player" }));
  await user.type(
    screen.getByRole("combobox", { name: "Search by name or phone" }),
    "blocked",
  );
  assert.equal(
    screen
      .getByRole("option", { name: /Blocked player/ })
      .getAttribute("aria-disabled"),
    "true",
  );
  await user.keyboard("{ArrowDown}{Enter}");
  assert.equal(screen.getByLabelText("Selected identity").textContent, "");
});

test("server lookup keeps pending results distinct from empty results and accepts only a ready selection", async () => {
  const queries: string[] = [];
  function Example({ pending }: { pending: boolean }) {
    const [value, setValue] = useState("");
    return (
      <Locale>
        <Field label="Table">
          <SearchSelect
            required
            value={value}
            options={
              pending
                ? [
                    {
                      value: "old",
                      label: "Old table",
                      description: "Stale result",
                    },
                  ]
                : [
                    {
                      value: "lounge",
                      label: "Lounge",
                      description: "5 / 10 · 6 seats available",
                    },
                  ]
            }
            onValueChange={setValue}
            onSearchChange={(q) => queries.push(q)}
            searching={pending}
            searchLabel="Search tables"
            searchPlaceholder="Table name or dealer"
            emptyText="No matching tables."
            placeholder="Select table"
          />
        </Field>
        <output aria-label="Selected table">{value}</output>
      </Locale>
    );
  }
  const user = userEvent.setup();
  const view = render(<Example pending />);
  const trigger = screen.getByRole("combobox", { name: "Table" });
  assert.equal(trigger.getAttribute("aria-busy"), "true");
  await user.click(trigger);
  assert.equal(
    screen.getByText("Loading records…").getAttribute("role"),
    "status",
  );
  assert.equal(screen.queryByText("No matching tables."), null);
  assert.equal(
    screen
      .getByRole("option", { name: /Old table/ })
      .getAttribute("aria-disabled"),
    "true",
  );
  await user.type(
    screen.getByRole("combobox", { name: "Search tables" }),
    "server query",
  );
  view.rerender(<Example pending={false} />);
  assert.equal(trigger.getAttribute("aria-busy"), null);
  assert.equal(screen.queryByText("Loading records…"), null);
  await user.click(screen.getByRole("option", { name: /Lounge/ }));
  assert.equal(screen.getByLabelText("Selected table").textContent, "lounge");
  assert.equal(queries.at(-1), "");
  assert.ok(queries.includes("server query"));
});

test("standard selects retain complete long option context while the selected field stays compact", async () => {
  const description =
    "10 / 25 · 8 seats available · " + "LongDealerName".repeat(15);
  function Example() {
    const [value, setValue] = useState("main");
    return (
      <Locale>
        <Field label="Table">
          <Select
            required
            value={value}
            onValueChange={setValue}
            options={[
              {
                value: "main",
                label: "Main floor",
                description: "5 / 10 · Full",
                disabled: true,
              },
              { value: "reserve", label: "Reserve", description },
            ]}
          />
        </Field>
        <output aria-label="Selected table">{value}</output>
      </Locale>
    );
  }
  const user = userEvent.setup();
  render(<Example />);
  const trigger = screen.getByRole("combobox", { name: "Table" });
  assert.equal(trigger.textContent, "Main floor");
  assert.equal(
    screen.getByRole("combobox", {
      name: "Table",
      description: "5 / 10 · Full",
    }),
    trigger,
  );
  await user.click(trigger);
  assert.equal(
    screen
      .getByRole("option", { name: /Main floor/ })
      .getAttribute("aria-disabled"),
    "true",
  );
  assert.ok(screen.getByText(description));
  await user.keyboard("{End}{Enter}");
  assert.equal(screen.getByLabelText("Selected table").textContent, "reserve");
  assert.equal(trigger.textContent, "Reserve");
  assert.equal(
    screen.getByRole("combobox", { name: "Table", description }),
    trigger,
  );
});

test("translated search labels and unavailable selections remain explicit", async () => {
  const user = userEvent.setup();
  render(
    <Locale
      ui={{
        search_tables: "搜索牌桌",
        no_matching_tables: "没有匹配的牌桌。",
        unavailable_selection: "所选项目不可用",
      }}
    >
      <Field label="Table">
        <SearchSelect
          options={[]}
          value="missing-id"
          onValueChange={() => {}}
          searchLabel="Search tables"
          emptyText="No matching tables."
        />
      </Field>
    </Locale>,
  );
  const trigger = screen.getByRole("combobox", { name: "Table" });
  assert.equal(trigger.textContent, "所选项目不可用");
  assert.equal(trigger.getAttribute("data-value"), "missing-id");
  await user.click(trigger);
  assert.ok(screen.getByRole("combobox", { name: "搜索牌桌" }));
  assert.ok(screen.getByText("没有匹配的牌桌。"));
});

test("selected context preserves the field's existing hint and invalid semantics", () => {
  render(
    <Locale>
      <label htmlFor="contextual-player">Player</label>
      <p id="player-hint">Select an eligible profile.</p>
      <p id="player-error">Check this credit account.</p>
      <SearchSelect
        id="contextual-player"
        required
        options={choices}
        value="player-credit"
        onValueChange={() => {}}
        aria-invalid
        aria-describedby="player-hint player-error"
      />
    </Locale>,
  );
  const trigger = screen.getByRole("combobox", {
    name: "Player",
    description:
      /Select an eligible profile.*Check this credit account.*12025550102.*Credit/,
  });
  assert.equal(trigger.getAttribute("aria-required"), "true");
  assert.equal(trigger.getAttribute("aria-invalid"), "true");
  const ids = trigger.getAttribute("aria-describedby")!.split(" ");
  assert.equal(ids.length, 3);
  assert.ok(ids.every((id) => document.getElementById(id)));
});

test("Enter selects the actual remote result after a phone search instead of the empty placeholder", async () => {
  const player = {
    value: "irene-id",
    label: "Irene Goh",
    description: "+12025550114 · Cash",
    phoneNumbers: ["+12025550114"],
  };
  const queries: string[] = [];
  function Remote({ ready }: { ready: boolean }) {
    const [query, setQuery] = useState("");
    const [value, setValue] = useState("");
    return (
      <Locale>
        <Field label="Player">
          <SearchSelect
            required
            value={value}
            onValueChange={setValue}
            searching={!!query && !ready}
            onSearchChange={(next) => {
              queries.push(next);
              setQuery(next);
            }}
            options={[
              { value: "", label: "Select player" },
              ...(query
                ? ready
                  ? [player]
                  : []
                : value
                  ? [player]
                  : [{ value: "other", label: "Other player" }]),
            ]}
          />
        </Field>
        <output aria-label="Selected identity">{value}</output>
      </Locale>
    );
  }
  const user = userEvent.setup();
  const view = render(<Remote ready={false} />);
  await user.click(screen.getByRole("combobox", { name: "Player" }));
  await waitFor(() =>
    assert.equal(
      screen
        .getByRole("option", { name: "Select player" })
        .getAttribute("aria-selected"),
      "true",
    ),
  );
  await user.type(
    screen.getByRole("combobox", { name: "Search by name or phone" }),
    "+1 (202) 555-0114",
  );
  assert.ok(screen.getByText("Loading records…"));
  assert.equal(screen.queryByRole("option", { name: "Select player" }), null);
  view.rerender(<Remote ready />);
  await waitFor(() =>
    assert.equal(
      screen
        .getByRole("option", { name: /Irene Goh/ })
        .getAttribute("aria-selected"),
      "true",
    ),
  );
  await user.keyboard("{Enter}");
  assert.equal(
    screen.getByLabelText("Selected identity").textContent,
    "irene-id",
  );
  assert.equal(queries.at(-1), "");
  await user.click(screen.getByRole("combobox", { name: "Player" }));
  assert.ok(screen.getByRole("option", { name: "Select player" }));
  await user.keyboard("{Home}{Enter}");
  assert.equal(screen.getByLabelText("Selected identity").textContent, "");
});

test("remote lookups keep House as an intentional empty selection without showing it for phone queries", async () => {
  function Remote() {
    const [value, setValue] = useState("irene-id");
    return (
      <Locale>
        <Field label="Player">
          <SearchSelect
            value={value}
            onValueChange={setValue}
            onSearchChange={() => {}}
            options={[
              { value: "", label: "House / no player" },
              {
                value: "irene-id",
                label: "Irene Goh",
                description: "+12025550114",
              },
            ]}
          />
        </Field>
        <output aria-label="Selected identity">{value}</output>
      </Locale>
    );
  }
  const user = userEvent.setup();
  render(<Remote />);
  await user.click(screen.getByRole("combobox", { name: "Player" }));
  assert.ok(screen.getByRole("option", { name: "House / no player" }));
  const search = screen.getByRole("combobox", {
    name: "Search by name or phone",
  });
  await user.type(search, "+12025550114");
  assert.equal(
    screen.queryByRole("option", { name: "House / no player" }),
    null,
  );
  await user.clear(search);
  await user.type(search, "house");
  await user.click(screen.getByRole("option", { name: "House / no player" }));
  assert.equal(screen.getByLabelText("Selected identity").textContent, "");
});
