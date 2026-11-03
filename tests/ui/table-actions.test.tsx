import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { PokerManagementContext } from "../../src/components/page/PokerManagementPage/PokerManagementProvider";
import type { PokerManagementState } from "../../src/components/page/PokerManagementPage/usePokerManagementState";
import {
  TableActions,
  TableSeatingHelp,
} from "../../src/components/page/PokerManagementPage/components/table-actions";
import { configuredStore } from "../helpers/store";

afterEach(cleanup);

function example(
  options: {
    canManage?: boolean;
    canMove?: boolean;
    hasTables?: boolean;
    locale?: "en" | "zh";
  } = {},
) {
  const calls: string[] = [];
  const state = {
    store: configuredStore(),
    busy: false,
    retryRequired: false,
    error: "",
    setError() {},
  } as unknown as PokerManagementState;
  render(
    <NextIntlClientProvider
      locale={options.locale ?? "en"}
      timeZone="Asia/Kuala_Lumpur"
      messages={{
        ui:
          options.locale === "zh"
            ? {
                move_player: "转移玩家",
                manage_tables: "管理牌桌",
                venue_rules: "场所规则",
                seating_help: "座位操作帮助",
              }
            : {},
      }}
    >
      <PokerManagementContext.Provider value={state}>
        <TableActions
          canManage={options.canManage ?? true}
          canMove={options.canMove ?? true}
          hasTables={options.hasTables ?? true}
          onAdd={() => calls.push("add")}
          onMove={() => calls.push("move")}
        />
        <TableSeatingHelp />
      </PokerManagementContext.Provider>
    </NextIntlClientProvider>,
  );
  return calls;
}

test("seated-player operations come first while configuration stays in the menu", async () => {
  const calls = example();
  const user = userEvent.setup();
  const buttons = screen.getAllByRole("button");
  assert.equal(buttons[0].textContent, "Move player");
  assert.equal(buttons[0].getAttribute("data-variant"), "default");
  assert.equal(screen.queryByRole("button", { name: "Add table" }), null);
  assert.equal(screen.queryByRole("button", { name: "Venue rules" }), null);
  await user.click(buttons[0]);
  assert.deepEqual(calls, ["move"]);
  await user.click(screen.getByRole("button", { name: "Manage tables" }));
  assert.ok(screen.getByRole("menuitem", { name: "Venue rules" }));
  await user.click(screen.getByRole("menuitem", { name: "Add table" }));
  assert.deepEqual(calls, ["move", "add"]);
  assert.equal(screen.queryByRole("menu"), null);
});

test("venue rules open from the menu and return keyboard focus to Manage tables", async () => {
  example();
  const user = userEvent.setup();
  const manage = screen.getByRole("button", { name: "Manage tables" });
  await user.click(manage);
  await user.click(screen.getByRole("menuitem", { name: "Venue rules" }));
  assert.ok(screen.getByRole("dialog", { name: "Venue rules" }));
  assert.ok(screen.getByText("Default stakes"));
  await user.keyboard("{Escape}");
  await waitFor(() => assert.equal(screen.queryByRole("dialog"), null));
  await waitFor(() => assert.equal(document.activeElement, manage));
});

test("empty-table onboarding keeps Add table prominent", async () => {
  const calls = example({ hasTables: false, canMove: false });
  const user = userEvent.setup();
  const add = screen.getByRole("button", { name: "Add table" });
  assert.equal(screen.getAllByRole("button")[0], add);
  assert.equal(add.getAttribute("data-variant"), "default");
  assert.equal(screen.queryByRole("button", { name: "Move player" }), null);
  assert.equal(screen.queryByRole("button", { name: "Manage tables" }), null);
  await user.click(add);
  assert.deepEqual(calls, ["add"]);
});

for (const role of [
  { name: "cashier", canMove: true },
  { name: "dealer or paused operations", canMove: false },
]) {
  test(`${role.name} retains venue-rule access without table-configuration actions`, async () => {
    example({ canManage: false, canMove: role.canMove });
    const user = userEvent.setup();
    assert.equal(
      !!screen.queryByRole("button", { name: "Move player" }),
      role.canMove,
    );
    assert.equal(screen.queryByRole("button", { name: "Add table" }), null);
    assert.equal(screen.queryByRole("button", { name: "Manage tables" }), null);
    await user.click(screen.getByRole("button", { name: "Venue rules" }));
    assert.ok(screen.getByRole("dialog", { name: "Venue rules" }));
  });
}

test("seating instructions stay available on demand without a persistent caption", async () => {
  example();
  const user = userEvent.setup();
  const instruction =
    "Drag to an empty seat to move, or onto a player to swap. On a phone, press and hold.";
  assert.equal(screen.queryByText(instruction), null);
  await user.click(screen.getByRole("button", { name: "Seating help" }));
  assert.ok(screen.getByRole("dialog", { name: "Seating help" }));
  assert.ok(screen.getByText(instruction));
  await user.keyboard("{Escape}");
  assert.equal(screen.queryByText(instruction), null);
  assert.ok(screen.getByRole("button", { name: "Move player" }));
});

test("translated operation and management labels remain explicit", () => {
  example({ locale: "zh" });
  assert.equal(screen.getAllByRole("button")[0].textContent, "转移玩家");
  assert.ok(screen.getByRole("button", { name: "管理牌桌" }));
  assert.ok(screen.getByRole("button", { name: "座位操作帮助" }));
});
