import assert from "node:assert/strict";
import { test } from "node:test";
import type { Role, Staff } from "../src/domain/model";
import {
  checkedLoginIdentity,
  StaffAccountMismatchError,
  STAFF_ACCOUNT_MISMATCH_MESSAGE,
} from "../src/lib/login-identity";
import { loginReceipt } from "../src/lib/management-contracts";
import { ManagementResponseError } from "../src/lib/management-response";

const staff: Staff = Object.freeze({
  id: "fictional-login-a",
  username: "fictional.admin",
  branchId: "fictional-venue-a",
  role: "ADMIN",
});

test("credential receipts validate every role and snapshot primitive staff fields", () => {
  for (const role of ["ADMIN", "MANAGER", "CASHIER", "DEALER"] as Role[]) {
    const input = { user: { ...staff, role } };
    const result = loginReceipt(input);
    assert.deepEqual(result, input);
    assert.notStrictEqual(result.user, input.user);
    input.user.id = "fictional-mutated-after-receipt";
    assert.equal(result.user.id, staff.id);
  }
});

test("incomplete or malformed credential success never confirms a login", () => {
  const malformed = [
    undefined,
    null,
    [],
    {},
    { ok: true },
    { user: null },
    { user: [] },
    { user: { ...staff, role: "OWNER" } },
  ];
  for (const key of ["id", "username", "branchId"] as const)
    for (const value of [undefined, null, 1, "", "  ", "x".repeat(101)])
      malformed.push({ user: { ...staff, [key]: value } });
  for (const input of malformed)
    assert.throws(
      () => loginReceipt(input),
      (error) => {
        assert.ok(error instanceof ManagementResponseError);
        assert.equal(error.status, 200);
        assert.equal(error.uncertain, true);
        return true;
      },
    );
});

test("login identity normalizes username case and whitespace, then pins the exact staff id", () => {
  const expected = Object.freeze({ username: "  FICTIONAL.ADMIN  " });
  const pinned = checkedLoginIdentity(expected, staff);
  assert.deepEqual(pinned, { username: staff.username, actorId: staff.id });
  assert.deepEqual(expected, { username: "  FICTIONAL.ADMIN  " });
  assert.deepEqual(
    checkedLoginIdentity(pinned, { ...staff, username: " Fictional.Admin " }),
    pinned,
  );
});

test("a different username or reused username with a different id is an explicit safe mismatch", () => {
  const pinned = checkedLoginIdentity({ username: staff.username }, staff);
  for (const [expected, candidate] of [
    [{ username: "different" }, staff],
    [{ username: " " }, staff],
    [pinned, { ...staff, username: "different" }],
    [pinned, { ...staff, id: "fictional-login-b" }],
    [pinned, { ...staff, id: ` ${staff.id}` }],
  ] as const)
    assert.throws(
      () => checkedLoginIdentity(expected, candidate),
      (error) => {
        assert.ok(error instanceof StaffAccountMismatchError);
        assert.equal(error.name, "StaffAccountMismatchError");
        assert.equal(error.message, STAFF_ACCOUNT_MISMATCH_MESSAGE);
        return true;
      },
    );
});

test("the same account can acquire its latest venue and role without an identity mismatch", () => {
  const pinned = checkedLoginIdentity({ username: staff.username }, staff);
  for (const role of ["ADMIN", "MANAGER", "CASHIER", "DEALER"] as Role[]) {
    const latest: Staff = { ...staff, role, branchId: "fictional-venue-b" };
    assert.deepEqual(checkedLoginIdentity(pinned, latest), pinned);
  }
});
