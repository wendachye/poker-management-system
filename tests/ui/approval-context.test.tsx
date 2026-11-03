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
import { PokerManagementContext } from "../../src/components/page/PokerManagementPage/PokerManagementProvider";
import type { PokerManagementState } from "../../src/components/page/PokerManagementPage/usePokerManagementState";
import { ApprovalQueue } from "../../src/components/page/PokerManagementPage/components/approval-queue";
import {
  ActionForm,
  Field,
  FormActions,
  FormSection,
  Modal,
} from "../../src/components/page/PokerManagementPage/components/shared";
import { Input } from "../../src/components/ui/input";
import { applyCommand } from "../../src/domain/operations";
import type { Command } from "../../src/domain/commands";
import type { Snapshot, Staff } from "../../src/domain/model";
import { playersForDay, tablesForDay } from "../../src/domain/selectors";
import { configuredStore } from "../helpers/store";

afterEach(cleanup);

function fixture() {
  const admin: Staff = {
    id: "context-admin",
    username: "Context admin",
    role: "ADMIN",
    branchId: "context-venue",
  };
  const cashier: Staff = {
    ...admin,
    id: "context-cashier",
    username: "Context cashier",
    role: "CASHIER",
  };
  const now = "2026-11-04T02:00:00Z";
  let store = configuredStore();
  const run = (command: Command, actor = admin) => {
    store = applyCommand(store, command, actor, now);
  };
  run({ kind: "OPEN_DAY", date: "2026-11-04", openingCash: 200000 });
  run({ kind: "TABLE", name: "Context table", dealer: "", status: "OPEN" });
  run({
    kind: "CHECK_IN",
    name: "Context player",
    phone: "+12025550101",
    type: "CREDIT",
    creditLimit: 1000000,
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
      note: "Fictional opening credit",
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
      type: "Cash-out",
      amount: 70000,
      playerId,
      tableId: store.tables[0].id,
      note: "Fictional cash-out context",
    },
    cashier,
  );
  const request = store.approvals.find((entry) => entry.status === "PENDING")!;
  const snapshot: Snapshot = {
    revision: 1,
    branch: {
      id: admin.branchId,
      name: "Context sample venue",
      timezone: "Asia/Kuala_Lumpur",
      role: admin.role,
    },
    user: admin,
    store,
  };
  const submissions: Command[] = [];
  const state = {
    snapshot,
    store,
    user: admin,
    day: store.days[0],
    players: playersForDay(store),
    tables: tablesForDay(store),
    activePlayers: playersForDay(store),
    pendingApprovals: [request],
    locked: false,
    busy: false,
    error: "",
    retryRequired: false,
    setError() {},
    focusRead: async () => {},
    clearReadFocus() {},
    submit: async (command: Command) => {
      submissions.push(command);
      return true;
    },
    withReviewedRevision: async (
      _revision: number | undefined,
      save: () => unknown,
    ) => save(),
  } as unknown as PokerManagementState;
  return { state, request, submissions };
}

function Boundary({
  data,
  children,
}: {
  data: ReturnType<typeof fixture>;
  children: ReactNode;
}) {
  return (
    <NextIntlClientProvider
      locale="en"
      timeZone="Asia/Kuala_Lumpur"
      messages={{}}
    >
      <PokerManagementContext.Provider value={data.state}>
        {children}
      </PokerManagementContext.Provider>
    </NextIntlClientProvider>
  );
}

test("approval review opens at its heading, preserves financial context and returns focus on Escape", async () => {
  const data = fixture();
  const user = userEvent.setup();
  render(
    <Boundary data={data}>
      <ApprovalQueue embedded requests={[data.request]} />
    </Boundary>,
  );
  const trigger = within(
    screen.getByRole("list", { name: "Approval queue" }),
  ).getByRole("button", { name: /^Review request/ });
  await user.click(trigger);
  const dialog = await screen.findByRole("dialog", { name: "Review request" });
  const heading = within(dialog).getByRole("heading", {
    name: "Review request",
  });
  await waitFor(() => assert.equal(document.activeElement, heading));
  assert.ok(
    within(dialog).getByText("Cash-out · Context player · Context table"),
  );
  assert.ok(within(dialog).getByText("Requested by: Context cashier"));
  assert.ok(within(dialog).getByText("Chips returned:", { exact: false }));
  assert.ok(within(dialog).getAllByText(/700\.00/).length);
  assert.ok(within(dialog).getAllByText(/200\.00/).length);
  assert.ok(within(dialog).getAllByText(/500\.00/).length);
  assert.equal(
    within(dialog).queryByText("Fields marked * are required."),
    null,
  );
  assert.equal(
    within(dialog).queryByRole("group", { name: "Review decision" }),
    null,
  );
  assert.ok(within(dialog).getByRole("tablist", { name: "Review decision" }));
  await user.tab();
  assert.equal(
    document.activeElement,
    within(dialog).getByRole("tab", { name: "Approve" }),
  );
  await user.keyboard("{Escape}");
  await waitFor(() => assert.equal(screen.queryByRole("dialog"), null));
  await waitFor(() => assert.equal(document.activeElement, trigger));
  assert.equal(data.submissions.length, 0);
});

test("rejection still requires a reason and focuses the invalid field without submitting", async () => {
  const data = fixture();
  const user = userEvent.setup();
  render(
    <Boundary data={data}>
      <ApprovalQueue embedded requests={[data.request]} />
    </Boundary>,
  );
  await user.click(
    within(screen.getByRole("list", { name: "Approval queue" })).getByRole(
      "button",
      { name: /^Review request/ },
    ),
  );
  const dialog = await screen.findByRole("dialog", { name: "Review request" });
  await user.click(within(dialog).getByRole("tab", { name: "Reject" }));
  const reason = within(dialog).getByRole("textbox", {
    name: /Rejection reason/,
  });
  assert.equal((reason as HTMLTextAreaElement).required, true);
  await user.click(
    within(dialog).getByRole("button", { name: "Reject request" }),
  );
  await waitFor(() => assert.equal(document.activeElement, reason));
  assert.equal(reason.getAttribute("aria-invalid"), "true");
  assert.equal(data.submissions.length, 0);
  assert.ok(
    within(dialog).getByText(
      "Rejecting this request does not post an entry or change cash or credit.",
    ),
  );
  await user.click(
    within(dialog).getByRole("button", {
      name: "Request details",
    }),
  );
  assert.ok(within(dialog).getByText(data.request.riskReason));
});

for (const scenario of [
  {
    name: "a reviewer who already approved a dual-review request",
    message: "Already reviewed",
    prepare(data: ReturnType<typeof fixture>) {
      data.request.approvalLevel = "DUAL";
      data.request.votes = [
        {
          staffId: data.state.user!.id,
          username: data.state.user!.username,
          role: data.state.user!.role,
          time: "2026-11-04T02:01:00Z",
        },
      ];
    },
  },
  {
    name: "a manager viewing an admin-only request",
    message: "Admin review required",
    prepare(data: ReturnType<typeof fixture>) {
      const manager: Staff = {
        ...data.state.user!,
        id: "context-manager",
        username: "Context manager",
        role: "MANAGER",
      };
      data.state.user = manager;
      data.state.snapshot!.user = manager;
      data.state.snapshot!.branch.role = manager.role;
    },
  },
  {
    name: "the staff member who submitted the request",
    message: "Your request",
    prepare(data: ReturnType<typeof fixture>) {
      data.request.requestedById = data.state.user!.id;
      data.request.requestedBy = data.state.user!.username;
    },
  },
  {
    name: "a request from a different business day",
    message: "Only requests for the current open business day can be reviewed.",
    prepare(data: ReturnType<typeof fixture>) {
      data.state.store.currentDayId = "another-context-day";
    },
  },
  {
    name: "a request after its business day closes",
    message: "Only requests for the current open business day can be reviewed.",
    prepare(data: ReturnType<typeof fixture>) {
      data.state.store.days[0].status = "CLOSED";
      data.state.locked = true;
    },
  },
]) {
  test(`request details explain why ${scenario.name} cannot decide`, async () => {
    const data = fixture();
    scenario.prepare(data);
    const user = userEvent.setup();
    render(
      <Boundary data={data}>
        <ApprovalQueue embedded requests={[data.request]} />
      </Boundary>,
    );
    await user.click(
      within(screen.getByRole("list", { name: "Approval queue" })).getByRole(
        "button",
        { name: /^View details/ },
      ),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Request details",
    });
    assert.ok(within(dialog).getByText(scenario.message));
    assert.equal(
      within(dialog).queryByRole("tablist", { name: "Review decision" }),
      null,
    );
    assert.equal(
      within(dialog).queryByRole("button", {
        name: /^(Approve request|Record approval|Reject request)$/,
      }),
      null,
    );
    assert.deepEqual(data.submissions, []);
  });
}

test("ordinary forms keep input autofocus and required validation when section captions are visually hidden", async () => {
  const data = fixture();
  function Example() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button onClick={() => setOpen(true)}>Edit sample profile</button>
        <Modal
          open={open}
          onOpenChange={setOpen}
          title="Edit profile"
          description="Fictional profile form"
        >
          <ActionForm
            onSubmit={() => {
              throw new Error("Invalid form must not save");
            }}
          >
            <FormSection title="Profile details" hideTitle>
              <Field label="Player name">
                <Input required />
              </Field>
            </FormSection>
            <FormActions>Save profile</FormActions>
          </ActionForm>
        </Modal>
      </>
    );
  }
  const user = userEvent.setup();
  render(
    <Boundary data={data}>
      <Example />
    </Boundary>,
  );
  await user.click(screen.getByRole("button", { name: "Edit sample profile" }));
  const dialog = await screen.findByRole("dialog", { name: "Edit profile" });
  const field = within(dialog).getByRole("textbox", { name: /Player name/ });
  await waitFor(() => assert.equal(document.activeElement, field));
  assert.ok(within(dialog).getByRole("group", { name: "Profile details" }));
  assert.equal(
    within(dialog).queryByText("Fields marked * are required."),
    null,
  );
  await user.click(
    within(dialog).getByRole("button", { name: "Save profile" }),
  );
  await waitFor(() => assert.equal(document.activeElement, field));
  assert.equal(field.getAttribute("aria-invalid"), "true");
});
