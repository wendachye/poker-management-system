import test from "node:test";
import assert from "node:assert/strict";
import {
  prototypeRequest,
  getPrototypeRoleOptions,
  resetPrototype,
  setPrototypePersona,
  subscribePrototype,
} from "../src/prototype/runtime";
import type { Snapshot } from "../src/domain/model";

async function snapshot(): Promise<Snapshot> {
  const response = await prototypeRequest("/api/state");
  assert.equal(response.status, 200);
  return response.json();
}

async function switchBranch(branchId: string) {
  return prototypeRequest("/api/branch", {
    method: "POST",
    body: JSON.stringify({ branchId }),
  });
}

test("a disabled sample account cannot switch venues or notify subscribers of a failed switch", async () => {
  resetPrototype("walkthrough");
  assert.equal((await switchBranch("demo-riverside")).status, 200);
  const riverside = await snapshot();
  const staff = await prototypeRequest("/api/staff");
  const { accounts } = await staff.json();
  const cashier = accounts.find(
    (account: { username: string }) => account.username === "demo.cashier",
  );
  const disabled = await prototypeRequest("/api/staff", {
    method: "POST",
    body: JSON.stringify({
      branchId: riverside.branch.id,
      revision: riverside.revision,
      operationId: crypto.randomUUID(),
      command: {
        kind: "STAFF_DISABLE",
        userId: cashier.id,
        reason: "Disable only the Riverside sample cashier",
      },
    }),
  });
  assert.equal(disabled.status, 200);
  assert.equal((await switchBranch("demo-city")).status, 200);
  setPrototypePersona("cashier");
  const before = await snapshot();
  let notifications = 0;
  const unsubscribe = subscribePrototype(() => notifications++);
  try {
    const denied = await switchBranch("demo-riverside");
    assert.equal(denied.status, 403);
    assert.match((await denied.json()).error, /disabled/i);
    assert.deepEqual(await snapshot(), before);
    assert.equal(notifications, 0);

    setPrototypePersona("admin");
    const permitted = await switchBranch("demo-riverside");
    assert.equal(permitted.status, 200);
    const after = await snapshot();
    assert.equal(after.branch.id, "demo-riverside");
    assert.equal(after.user.role, "ADMIN");
    assert.equal(after.user.branchId, "demo-riverside");
  } finally {
    unsubscribe();
    resetPrototype("busy");
  }
});

test("demo role options follow account edits, disabled status and the selected venue", async () => {
  resetPrototype("walkthrough");
  const defaults = [
    { id: "cashier", role: "CASHIER", active: true },
    { id: "manager", role: "MANAGER", active: true },
    { id: "admin", role: "ADMIN", active: true },
    { id: "dealer", role: "DEALER", active: true },
  ];
  assert.deepEqual(getPrototypeRoleOptions(), defaults);
  assert.equal((await switchBranch("demo-riverside")).status, 200);
  const staff = await prototypeRequest("/api/staff");
  const { accounts } = await staff.json();
  for (const [username, command] of [
    ["demo.manager", { kind: "STAFF_ROLE", role: "DEALER" }],
    ["demo.cashier", { kind: "STAFF_DISABLE" }],
  ] as const) {
    const before = await snapshot();
    const account = accounts.find(
      (entry: { username: string }) => entry.username === username,
    );
    const response = await prototypeRequest("/api/staff", {
      method: "POST",
      body: JSON.stringify({
        branchId: before.branch.id,
        revision: before.revision,
        operationId: crypto.randomUUID(),
        command: {
          ...command,
          userId: account.id,
          reason: "Update a destination sample account",
        },
      }),
    });
    assert.equal(response.status, 200);
  }
  const changed = [
    { id: "cashier", role: "CASHIER", active: false },
    { id: "manager", role: "DEALER", active: true },
    { id: "admin", role: "ADMIN", active: true },
    { id: "dealer", role: "DEALER", active: true },
  ];
  assert.deepEqual(getPrototypeRoleOptions(), changed);
  setPrototypePersona("manager");
  assert.equal((await snapshot()).user.role, "DEALER");
  setPrototypePersona("admin");
  assert.equal((await switchBranch("demo-city")).status, 200);
  assert.deepEqual(getPrototypeRoleOptions(), defaults);
  assert.equal((await switchBranch("demo-riverside")).status, 200);
  assert.deepEqual(getPrototypeRoleOptions(), changed);
  resetPrototype("busy");
});
