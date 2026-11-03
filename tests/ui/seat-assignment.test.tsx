import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { useState, type ReactNode } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { Player } from "../../src/domain/model";
import { PokerManagementContext } from "../../src/components/page/PokerManagementPage/PokerManagementProvider";
import type { PokerManagementState } from "../../src/components/page/PokerManagementPage/usePokerManagementState";
import {
  ActionForm,
  Field,
  FormActions,
  Modal,
} from "../../src/components/page/PokerManagementPage/components/shared";
import { SeatAssignment } from "../../src/components/page/PokerManagementPage/components/seat-assignment";

afterEach(cleanup);

const table = {
  id: "sample-table",
  name: "Sample · Main floor",
  status: "OPEN" as const,
};
const player = (
  id: string,
  name: string,
  seat: number,
  extra: Partial<Player> = {},
): Player => ({
  id,
  name,
  phone: "+12025550101",
  type: "CASH",
  tags: [],
  creditLimit: 0,
  creditUsed: 0,
  status: "ACTIVE",
  tableId: table.id,
  seat,
  buyIn: 0,
  cashOut: 0,
  ...extra,
});
const players = [
  player("moving-player", "Sample · Alex Tan", 1),
  player("occupied-player", "Sample · Mei Lim", 3),
  player("other-table", "Other table guest", 5, { tableId: "other-table" }),
  player("checked-out", "Checked-out guest", 7, { status: "OUT" }),
];

function Locale({ children }: { children: ReactNode }) {
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

function Example({
  disabled = false,
  closed = false,
}: {
  disabled?: boolean;
  closed?: boolean;
}) {
  const [value, setValue] = useState("");
  return (
    <Locale>
      <Field label="Seat">
        <SeatAssignment
          table={{ ...table, status: closed ? "CLOSED" : "OPEN" }}
          players={players}
          value={value}
          onValueChange={setValue}
          currentPlayerId="moving-player"
          disabled={disabled}
          required
        />
      </Field>
      <output aria-label="Selected seat identity">{value}</output>
    </Locale>
  );
}

test("visual seats distinguish occupied and current seats while selecting only the requested available seat", async () => {
  const user = userEvent.setup();
  render(<Example />);
  const group = screen.getByRole("radiogroup", { name: /Seat/ });
  assert.equal(group.getAttribute("aria-required"), "true");
  assert.equal(screen.getAllByRole("radio").length, 9);
  const current = screen.getByRole("radio", {
    name: /Seat 1.*Alex Tan.*Current seat/i,
  });
  const occupied = screen.getByRole("radio", { name: /Seat 3.*Mei Lim/i });
  assert.equal((current as HTMLButtonElement).disabled, true);
  assert.equal((occupied as HTMLButtonElement).disabled, true);
  assert.equal(
    (
      screen.getByRole("radio", {
        name: /Seat 5.*Available/i,
      }) as HTMLButtonElement
    ).disabled,
    false,
  );
  assert.equal(
    (
      screen.getByRole("radio", {
        name: /Seat 7.*Available/i,
      }) as HTMLButtonElement
    ).disabled,
    false,
  );
  await user.click(screen.getByRole("radio", { name: /Seat 4.*Available/i }));
  assert.equal(
    screen.getByLabelText("Selected seat identity").textContent,
    "4",
  );
  assert.equal(
    screen.getByRole("radio", { name: /Seat 4/ }).getAttribute("aria-checked"),
    "true",
  );
  await user.click(current);
  await user.click(occupied);
  assert.equal(
    screen.getByLabelText("Selected seat identity").textContent,
    "4",
  );
});

test("keyboard seat navigation skips unavailable seats and updates the controlled selection", async () => {
  const user = userEvent.setup();
  render(<Example />);
  await user.tab();
  assert.equal(
    document.activeElement,
    screen.getByRole("radio", { name: /Seat 2.*Available/i }),
  );
  // Radix defers roving focus; keep the key down until that focus selects the radio.
  await user.keyboard("{ArrowRight>}");
  await waitFor(() =>
    assert.equal(
      document.activeElement,
      screen.getByRole("radio", { name: /Seat 4.*Available/i }),
    ),
  );
  await waitFor(() =>
    assert.equal(
      screen.getByLabelText("Selected seat identity").textContent,
      "4",
    ),
  );
  await user.keyboard("{/ArrowRight}{ArrowLeft>}");
  await waitFor(() =>
    assert.equal(
      screen.getByLabelText("Selected seat identity").textContent,
      "2",
    ),
  );
  await user.keyboard("{/ArrowLeft}");
});

test("an occupancy refresh invalidates a formerly available selection without mutating the draft", () => {
  const changes: string[] = [];
  const map = (occupants: Player[]) => (
    <Locale>
      <Field label="Seat">
        <SeatAssignment
          table={table}
          players={occupants}
          value="4"
          onValueChange={(value) => changes.push(value)}
          required
        />
      </Field>
    </Locale>
  );
  const view = render(map(players));
  assert.equal(
    screen.getByRole("radiogroup", { name: /Seat/ }).getAttribute("data-value"),
    "4",
  );
  assert.equal(
    screen.getByRole("radio", { name: /Seat 4/ }).getAttribute("aria-checked"),
    "true",
  );
  view.rerender(map([...players, player("new-occupant", "New occupant", 4)]));
  const unavailable = screen.getByRole("radio", {
    name: /Seat 4.*New occupant/i,
  });
  assert.equal((unavailable as HTMLButtonElement).disabled, true);
  assert.equal(unavailable.getAttribute("aria-checked"), "false");
  assert.equal(
    screen.getByRole("radiogroup", { name: /Seat/ }).getAttribute("data-value"),
    "",
  );
  assert.equal(
    screen
      .getAllByRole("radio")
      .some((radio) => radio.getAttribute("aria-checked") === "true"),
    false,
  );
  assert.deepEqual(changes, []);
});

for (const state of ["closed", "disabled"] as const) {
  test(`${state} seat maps cannot assign a seat`, () => {
    render(
      <Example closed={state === "closed"} disabled={state === "disabled"} />,
    );
    for (const seat of screen.getAllByRole("radio"))
      assert.equal((seat as HTMLButtonElement).disabled, true);
    assert.equal(
      screen.getByLabelText("Selected seat identity").textContent,
      "",
    );
  });
}

test("required visual seat assignment keeps field validation and cannot save an unselected seat", async () => {
  const saves: string[] = [];
  const state = {
    snapshot: { revision: 1 },
    busy: false,
    error: "",
    retryRequired: false,
    setError() {},
    withReviewedRevision: async (_revision: unknown, save: () => unknown) =>
      save(),
  } as unknown as PokerManagementState;
  function Form() {
    const [value, setValue] = useState("");
    return (
      <Locale>
        <PokerManagementContext.Provider value={state}>
          <Modal
            open
            onOpenChange={() => {}}
            title="Assign sample seat"
            description="Fictional selection validation"
          >
            <ActionForm
              onSubmit={() => {
                saves.push(value);
              }}
            >
              <Field label="Seat">
                <SeatAssignment
                  table={table}
                  players={players}
                  value={value}
                  onValueChange={setValue}
                  required
                />
              </Field>
              <FormActions>Assign seat</FormActions>
            </ActionForm>
          </Modal>
        </PokerManagementContext.Provider>
      </Locale>
    );
  }
  const user = userEvent.setup();
  render(<Form />);
  const group = screen.getByRole("radiogroup", { name: /Seat/ });
  await user.click(screen.getByRole("button", { name: "Assign seat" }));
  await waitFor(() => assert.equal(group.getAttribute("aria-invalid"), "true"));
  assert.deepEqual(saves, []);
  assert.ok(
    document.activeElement === group || group.contains(document.activeElement),
  );
  await user.click(screen.getByRole("radio", { name: /Seat 4.*Available/i }));
  await user.click(screen.getByRole("button", { name: "Assign seat" }));
  await waitFor(() => assert.deepEqual(saves, ["4"]));
});

test("keyboard selection participates in the modal's unsaved-change protection", async () => {
  const state = {
    snapshot: { revision: 1 },
    busy: false,
    error: "",
    retryRequired: false,
    setError() {},
  } as unknown as PokerManagementState;
  function Form() {
    const [value, setValue] = useState("");
    return (
      <Locale>
        <PokerManagementContext.Provider value={state}>
          <Modal
            open
            onOpenChange={() => {}}
            title="Assign sample seat"
            description="Fictional selection draft"
            initialFocus="heading"
          >
            <Field label="Seat">
              <SeatAssignment
                table={table}
                players={players}
                value={value}
                onValueChange={setValue}
                currentPlayerId="moving-player"
                required
              />
            </Field>
            <output aria-label="Selected seat identity">{value}</output>
          </Modal>
        </PokerManagementContext.Provider>
      </Locale>
    );
  }
  const user = userEvent.setup();
  render(<Form />);
  await waitFor(() =>
    assert.equal(
      document.activeElement,
      screen.getByRole("heading", { name: "Assign sample seat" }),
    ),
  );
  await user.tab();
  await user.keyboard("{ArrowRight>}");
  await waitFor(() =>
    assert.equal(
      screen.getByLabelText("Selected seat identity").textContent,
      "4",
    ),
  );
  await user.keyboard("{/ArrowRight}{Escape}");
  assert.ok(
    await screen.findByRole("alertdialog", {
      name: "Discard unsaved changes?",
    }),
  );
});
