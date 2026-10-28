import assert from "node:assert/strict";
import { test } from "node:test";
import type { Role, Snapshot, Staff } from "../src/domain/model";
import { matchesOperationalAccess } from "../src/lib/operational-access";

const authenticated: Staff = Object.freeze({
  id: "fictional-staff-a",
  username: "fictional.staff.a",
  role: "ADMIN",
  branchId: "fictional-venue-a",
});
const context: Pick<Snapshot, "user" | "branch"> = Object.freeze({
  user: Object.freeze({ ...authenticated }),
  branch: Object.freeze({
    id: authenticated.branchId,
    name: "Fictional venue A",
    role: authenticated.role,
    timezone: "Asia/Kuala_Lumpur",
  }),
});

test("operational access accepts matching staff and venue for every role", () => {
  for (const role of ["ADMIN", "MANAGER", "CASHIER", "DEALER"] as Role[]) {
    const staff = Object.freeze({ ...authenticated, role });
    const next = Object.freeze({
      user: Object.freeze({ ...staff }),
      branch: Object.freeze({ ...context.branch, role }),
    });
    assert.equal(matchesOperationalAccess(staff, next), true);
    assert.deepEqual(staff, { ...authenticated, role });
    assert.deepEqual(next.user, staff);
  }
});

test("a first context from another staff account in the same venue is rejected", () => {
  assert.equal(
    matchesOperationalAccess(authenticated, {
      ...context,
      user: { ...context.user, id: "fictional-staff-b" },
    }),
    false,
  );
  assert.equal(matchesOperationalAccess(null, context), false);
});

test("the same staff account cannot silently change role or venue", () => {
  assert.equal(
    matchesOperationalAccess(authenticated, {
      user: { ...context.user, role: "CASHIER" },
      branch: { ...context.branch, role: "CASHIER" },
    }),
    false,
  );
  assert.equal(
    matchesOperationalAccess(authenticated, {
      user: { ...context.user, branchId: "fictional-venue-b" },
      branch: { ...context.branch, id: "fictional-venue-b" },
    }),
    false,
  );
});

test("an internally inconsistent venue or role context is rejected", () => {
  for (const next of [
    {
      ...context,
      user: { ...context.user, branchId: "fictional-venue-b" },
    },
    {
      ...context,
      branch: { ...context.branch, id: "fictional-venue-b" },
    },
    { ...context, user: { ...context.user, role: "MANAGER" as const } },
    { ...context, branch: { ...context.branch, role: "MANAGER" as const } },
  ])
    assert.equal(matchesOperationalAccess(authenticated, next), false);
});

test("record revisions and display-name changes do not change operational access", () => {
  for (const revision of [0, 1, 40, Number.MAX_SAFE_INTEGER]) {
    const next = {
      revision,
      user: { ...context.user, username: "fictional.renamed.staff" },
      branch: { ...context.branch, name: "Renamed fictional venue" },
    };
    assert.equal(matchesOperationalAccess(authenticated, next), true);
  }
});
