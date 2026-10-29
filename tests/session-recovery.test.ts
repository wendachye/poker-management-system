import assert from "node:assert/strict";
import { test } from "node:test";
import type { Role, Staff } from "../src/domain/model";
import { ManagementResponseError } from "../src/lib/management-response";
import { StaffAccountMismatchError } from "../src/lib/login-identity";
import { checkStaffSession } from "../src/lib/session-recovery";

const staff: Staff = Object.freeze({
  id: "fictional-staff",
  username: "fictional.cashier",
  branchId: "fictional-venue",
  role: "CASHIER",
});
const fallback = "Cannot check staff access right now. Please try again.";
const unavailable = { status: "unavailable", message: fallback };

test("a session check performs one provided read and validates each staff role", async () => {
  let reads = 0;
  for (const role of ["ADMIN", "MANAGER", "CASHIER", "DEALER"] as Role[]) {
    const user = Object.freeze({ ...staff, role });
    assert.deepEqual(
      await checkStaffSession(async () => {
        reads++;
        return user;
      }),
      {
        status: "authenticated",
        user,
      },
    );
    assert.equal(user.role, role);
  }
  assert.equal(reads, 4);
});

test("only a null read or a confirmed typed 401 establishes signed-out state", async () => {
  assert.deepEqual(await checkStaffSession(async () => null), {
    status: "signed-out",
  });
  const confirmed = new ManagementResponseError("Expired.", 401, null);
  Object.defineProperty(confirmed, "message", {
    get() {
      throw new Error("private-message");
    },
  });
  assert.deepEqual(
    await checkStaffSession(async () => {
      throw confirmed;
    }),
    { status: "signed-out" },
  );
  assert.deepEqual(
    await checkStaffSession(async () => {
      throw { status: 401, message: "private-untrusted-status" };
    }),
    unavailable,
  );
  const ambiguous = new ManagementResponseError(
    "The response is unconfirmed.",
    401,
    null,
    true,
  );
  assert.deepEqual(
    await checkStaffSession(async () => {
      throw ambiguous;
    }),
    {
      status: "unavailable",
      message: ambiguous.message,
    },
  );
});

test("permission, conflict, timeout, service and incomplete-response errors remain unavailable", async () => {
  for (const status of [403, 408, 409, 500, 503, 200]) {
    const error = new ManagementResponseError(
      "Please retry the access check.",
      status,
      null,
      true,
    );
    assert.deepEqual(
      await checkStaffSession(async () => {
        throw error;
      }),
      {
        status: "unavailable",
        message: error.message,
      },
    );
  }
});

test("malformed successful staff responses cannot authenticate or silently sign out", async () => {
  for (const input of [
    undefined,
    false,
    "ok",
    [],
    {},
    { ...staff, id: "" },
    { ...staff, username: " " },
    { ...staff, branchId: null },
    { ...staff, role: "OWNER" },
    { ...staff, id: "x".repeat(101) },
    Object.defineProperty({}, "id", {
      get() {
        throw new Error("private-getter");
      },
    }),
  ]) {
    assert.deepEqual(
      await checkStaffSession(async () => input as Staff),
      unavailable,
    );
  }
});

test("a 503 followed by a successful read preserves credentials, drafts and recovery metadata", async () => {
  const existing = Object.freeze({
    user: staff,
    draft: Object.freeze({ playerName: "Fictional player", amount: "500" }),
    pending: Object.freeze({
      operationId: "4e43e2f4-a4eb-40d0-9437-9152c370ab23",
    }),
    cookie: "private-existing-cookie",
  });
  const before = structuredClone(existing);
  const methods: string[] = [];
  const refresh = async () => {
    methods.push("GET");
    if (methods.length === 1)
      throw new ManagementResponseError(
        "The service is unavailable. Please try again.",
        503,
        null,
      );
    return existing.user;
  };
  const first = await checkStaffSession(refresh);
  assert.equal(first.status, "unavailable");
  assert.deepEqual(await checkStaffSession(refresh), {
    status: "authenticated",
    user: staff,
  });
  assert.deepEqual(methods, ["GET", "GET"]);
  assert.deepEqual(existing, before);
});

test("a saved login can resume after its follow-up read fails without another credential submission", async () => {
  const operations = ["POST-login-saved"];
  const currentCookie = "private-saved-session";
  const refresh = async () => {
    operations.push("GET-access");
    assert.equal(currentCookie, "private-saved-session");
    if (operations.length === 2) throw new Error("private-network-address");
    return staff;
  };
  assert.deepEqual(await checkStaffSession(refresh), unavailable);
  assert.deepEqual(await checkStaffSession(refresh), {
    status: "authenticated",
    user: staff,
  });
  assert.deepEqual(operations, [
    "POST-login-saved",
    "GET-access",
    "GET-access",
  ]);
});

test("arbitrary errors and malformed typed messages produce only a safe fallback", async () => {
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  for (const error of [
    new Error("postgresql://private-password@private-host/secret"),
    new SyntaxError("private-player SELECT * FROM private_table"),
    "private-error",
    revoked.proxy,
    new ManagementResponseError("", 503, null),
    new ManagementResponseError(" ", 503, null),
    new ManagementResponseError("private-".repeat(150), 503, null),
    Object.defineProperty(
      new ManagementResponseError("safe", 503, null),
      "status",
      {
        get() {
          throw new Error("private-status");
        },
      },
    ),
  ]) {
    const result = await checkStaffSession(async () => {
      throw error;
    });
    assert.deepEqual(result, unavailable);
    assert.doesNotMatch(JSON.stringify(result), /private|SELECT|postgresql/);
  }
});

test("an uncertain account switch cannot resume a different staff account", async () => {
  let reads = 0;
  const refresh = async () => {
    reads++;
    return staff;
  };
  assert.deepEqual(await checkStaffSession(refresh, "other.cashier"), {
    status: "different-account",
  });
  assert.deepEqual(await checkStaffSession(refresh, " Fictional.Cashier "), {
    status: "authenticated",
    user: staff,
  });
  assert.deepEqual(await checkStaffSession(async () => null, "other.cashier"), {
    status: "signed-out",
  });
  assert.equal(reads, 2);
});

test("a provider-bound account mismatch returns only a different-account result", async () => {
  let reads = 0;
  const mismatch = new StaffAccountMismatchError();
  Object.defineProperty(mismatch, "message", {
    get() {
      throw new Error("private-other-staff-identity");
    },
  });
  const refresh = async () => {
    reads++;
    throw mismatch;
  };
  for (const expected of [undefined, "requested.cashier"]) {
    const result = await checkStaffSession(refresh, expected);
    assert.deepEqual(result, { status: "different-account" });
    assert.doesNotMatch(JSON.stringify(result), /private|requested/);
  }
  assert.equal(reads, 2);
});

test("a repeated mismatch can recover through a later verified read without credential or draft mutation", async () => {
  const protectedState = Object.freeze({
    draft: Object.freeze({ amount: "500", player: "Fictional player" }),
    operationId: "b4f62930-965d-43f3-8fea-d5cd31390317",
    cookie: "fictional-existing-cookie",
  });
  const before = structuredClone(protectedState);
  const methods: string[] = [];
  const refresh = async () => {
    methods.push("GET");
    if (methods.length <= 2) throw new StaffAccountMismatchError();
    return staff;
  };
  for (let attempt = 0; attempt < 2; attempt++)
    assert.deepEqual(await checkStaffSession(refresh, staff.username), {
      status: "different-account",
    });
  assert.deepEqual(await checkStaffSession(refresh, staff.username), {
    status: "authenticated",
    user: staff,
  });
  assert.deepEqual(methods, ["GET", "GET", "GET"]);
  assert.deepEqual(protectedState, before);
});
