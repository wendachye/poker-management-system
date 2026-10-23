import test from "node:test";
import assert from "node:assert/strict";
import { staffCommandSchema } from "../src/domain/staff";
import { staffFormCommand } from "../src/lib/staff-form-command";
import { prototypeRequest, resetPrototype } from "../src/prototype/runtime";
import type { Snapshot } from "../src/domain/model";

const values = {
  action: "create" as const,
  username: "showcase.cashier",
  role: "CASHIER" as const,
  password: "",
  confirmation: "",
  reason: "Demonstrate sample staff setup",
};

test("ordinary staff create and reset preserve entered passwords and reject mismatched confirmation", () => {
  for (const action of ["create", "password"] as const) {
    const input = {
      ...values,
      action,
      account: { id: "staff-1", active: false },
      password: "An-entered-password-123",
      confirmation: "An-entered-password-123",
    };
    const command = staffFormCommand(input);
    assert.ok("password" in command);
    assert.equal(command.password, input.password);
    assert.equal(staffCommandSchema.safeParse(command).success, true);
    assert.throws(
      () =>
        staffFormCommand({ ...input, confirmation: "A-different-password" }),
      /Passwords do not match/,
    );
    assert.equal(
      staffCommandSchema.safeParse(
        staffFormCommand({
          ...input,
          password: "short",
          confirmation: "short",
        }),
      ).success,
      false,
    );
  }
});

test("sample staff creation needs no password and does not create prototype sign-in credentials", async () => {
  resetPrototype("walkthrough");
  try {
    const before: Snapshot = await (
      await prototypeRequest("/api/state")
    ).json();
    const command = staffFormCommand(values, true);
    assert.equal(staffCommandSchema.safeParse(command).success, true);
    const saved = await prototypeRequest("/api/staff", {
      method: "POST",
      body: JSON.stringify({
        branchId: before.branch.id,
        revision: before.revision,
        operationId: crypto.randomUUID(),
        command,
      }),
    });
    assert.equal(saved.status, 200);
    const list = await (await prototypeRequest("/api/staff")).json();
    const account = list.accounts.find(
      (entry: { username: string }) => entry.username === values.username,
    );
    assert.ok(account);
    assert.equal(account.role, "CASHIER");
    assert.equal(Object.hasOwn(account, "password"), false);
    const login = await prototypeRequest("/api/auth", {
      method: "POST",
      body: JSON.stringify({
        username: values.username,
        password: "Not-a-real-demo-credential",
      }),
    });
    assert.equal(login.status, 401);
    assert.match((await login.json()).error, /sample role/);
    const after: Snapshot = await (await prototypeRequest("/api/state")).json();
    assert.equal(after.user.id, before.user.id);
    assert.equal(
      JSON.stringify(after.store.auditLogs).includes("prototype-only-no-login"),
      false,
    );
  } finally {
    resetPrototype("busy");
  }
});

test("sample password resets and account enabling retain the intended staff target", () => {
  for (const active of [true, false]) {
    const command = staffFormCommand(
      {
        ...values,
        action: "password",
        account: { id: "sample-cashier", active },
      },
      true,
    );
    assert.equal(staffCommandSchema.safeParse(command).success, true);
    assert.equal(command.kind, "STAFF_PASSWORD");
    if (command.kind === "STAFF_PASSWORD") {
      assert.equal(command.userId, "sample-cashier");
      assert.equal(command.enable, !active);
    }
  }
});
