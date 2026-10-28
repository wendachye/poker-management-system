import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clearPendingOperation,
  listPendingOperations,
  pendingOperation,
  PendingOperationStorageError,
  PENDING_OPERATION_PREFIX,
  writePendingOperation,
  type PendingOperation,
  type PendingOperationStorage,
} from "../src/lib/pending-operation";

const first = pendingOperation({
  version: 1,
  operationId: "acdbd459-c1e4-4931-b7b2-2aec14135be7",
  branchId: "sample-venue",
  actorId: "sample-cashier",
  endpoint: "/api/state",
  createdAt: 1,
});

function fixture(changes: Partial<PendingOperation> = {}) {
  return pendingOperation({ ...first, ...changes });
}

function storage() {
  const records = new Map<string, string>();
  const value: PendingOperationStorage = {
    get length() {
      return records.size;
    },
    key(index) {
      return [...records.keys()][index] ?? null;
    },
    getItem(key) {
      return records.get(key) ?? null;
    },
    setItem(key, text) {
      records.set(key, text);
    },
    removeItem(key) {
      records.delete(key);
    },
  };
  return { records, value };
}

function identity(checkpoint = first) {
  return { actorId: checkpoint.actorId, branchId: checkpoint.branchId };
}

test("a checkpoint stores only whitelisted metadata and survives reload without command or credential fields", () => {
  const { value, records } = storage();
  const input = { ...first };
  writePendingOperation(value, input);
  const serialized = records.get(PENDING_OPERATION_PREFIX + first.operationId)!;
  assert.deepEqual(JSON.parse(serialized), first);
  assert.equal(
    /password|command|fingerprint|amount|token/.test(serialized),
    false,
  );
  assert.deepEqual(listPendingOperations(value, identity()), [first]);
  input.actorId = "changed-after-save";
  assert.deepEqual(listPendingOperations(value, identity()), [first]);
  for (const secret of ["password", "command", "fingerprint", "token"])
    assert.throws(
      () => pendingOperation({ ...first, [secret]: "fictional-secret" }),
      PendingOperationStorageError,
    );
});

test("concurrent tab checkpoints remain separate, identity-scoped and ordered without automatic expiry", () => {
  const { value } = storage();
  const second = fixture({
    operationId: "bcdbd459-c1e4-4931-b7b2-2aec14135be7",
    createdAt: 2,
  });
  const anotherVenue = fixture({
    operationId: "ccdbd459-c1e4-4931-b7b2-2aec14135be7",
    branchId: "another-venue",
    endpoint: "/api/staff",
  });
  const anotherStaff = fixture({
    operationId: "dcdbd459-c1e4-4931-b7b2-2aec14135be7",
    actorId: "another-staff",
    endpoint: "/api/locations",
  });
  for (const checkpoint of [second, anotherVenue, anotherStaff, first])
    writePendingOperation(value, checkpoint);
  assert.deepEqual(listPendingOperations(value, identity()), [first, second]);
  assert.deepEqual(listPendingOperations(value, identity(anotherVenue)), [
    anotherVenue,
  ]);
  assert.deepEqual(listPendingOperations(value, identity(anotherStaff)), [
    anotherStaff,
  ]);
  clearPendingOperation(value, first);
  assert.deepEqual(listPendingOperations(value, identity()), [second]);
  assert.deepEqual(listPendingOperations(value, identity(anotherVenue)), [
    anotherVenue,
  ]);
});

test("an existing operation identifier cannot overwrite different metadata or clear another tab's checkpoint", () => {
  const { value, records } = storage();
  writePendingOperation(value, first);
  writePendingOperation(value, first);
  for (const changes of [
    { actorId: "other" },
    { branchId: "other" },
    { endpoint: "/api/staff" as const },
    { createdAt: 2 },
  ]) {
    const conflicting = fixture(changes);
    assert.throws(
      () => writePendingOperation(value, conflicting),
      PendingOperationStorageError,
    );
    assert.throws(
      () => clearPendingOperation(value, conflicting),
      PendingOperationStorageError,
    );
    assert.deepEqual(listPendingOperations(value, identity()), [first]);
  }
  clearPendingOperation(value, first);
  clearPendingOperation(value, first);
  assert.equal(records.size, 0);
});

test("unknown fields, malformed identifiers, endpoints and timestamps fail closed with no sensitive diagnostics", () => {
  for (const invalid of [
    null,
    [],
    false,
    { ...first, extra: "fictional-password" },
    { ...first, version: 2 },
    { ...first, operationId: "not-a-uuid" },
    { ...first, operationId: "acdbd459-c1e4-0931-b7b2-2aec14135be7" },
    { ...first, actorId: "" },
    { ...first, actorId: "a".repeat(101) },
    { ...first, branchId: " venue " },
    { ...first, branchId: "venue\nprivate" },
    { ...first, endpoint: "https://private.example" },
    { ...first, endpoint: "/api/state?password=private" },
    { ...first, createdAt: -1 },
    { ...first, createdAt: 1.5 },
    { ...first, createdAt: "1" },
    { ...first, createdAt: Infinity },
    { ...first, createdAt: Number.MAX_SAFE_INTEGER + 1 },
  ])
    assert.throws(
      () => pendingOperation(invalid),
      (error) => {
        assert.ok(error instanceof PendingOperationStorageError);
        assert.equal(
          /fictional-password|private\.example|venue\n/.test(error.message),
          false,
        );
        return true;
      },
    );
});

test("corrupted namespace records block listing and writing even for a different identity", () => {
  for (const [key, raw] of [
    [PENDING_OPERATION_PREFIX + first.operationId, "invalid JSON"],
    [PENDING_OPERATION_PREFIX + first.operationId, "x".repeat(1025)],
    [
      PENDING_OPERATION_PREFIX + first.operationId,
      JSON.stringify({ ...first, password: "private" }),
    ],
    [
      PENDING_OPERATION_PREFIX + "bcdbd459-c1e4-4931-b7b2-2aec14135be7",
      JSON.stringify(first),
    ],
  ]) {
    const { value, records } = storage();
    records.set("unrelated.setting", "unrelated");
    records.set(key, raw);
    assert.throws(
      () =>
        listPendingOperations(value, { actorId: "other", branchId: "other" }),
      PendingOperationStorageError,
    );
    assert.throws(
      () =>
        writePendingOperation(
          value,
          fixture({ operationId: "ccdbd459-c1e4-4931-b7b2-2aec14135be7" }),
        ),
      PendingOperationStorageError,
    );
    assert.equal(records.get(key), raw);
    assert.equal(records.get("unrelated.setting"), "unrelated");
  }
});

test("unavailable storage, silent writes and failed removal cannot release an unverified request", () => {
  const failed = () => {
    throw new Error("private storage failure details");
  };
  for (const method of ["key", "getItem", "setItem"] as const) {
    const backing = storage();
    backing.records.set("unrelated", "setting");
    const unavailable = { ...backing.value, [method]: failed };
    assert.throws(
      () => writePendingOperation(unavailable, first),
      PendingOperationStorageError,
    );
  }
  const backing = storage();
  const unavailableLength = Object.defineProperty(
    { ...backing.value },
    "length",
    { get: failed },
  );
  assert.throws(
    () => listPendingOperations(unavailableLength, identity()),
    PendingOperationStorageError,
  );
  assert.throws(
    () => writePendingOperation({ ...storage().value, setItem() {} }, first),
    PendingOperationStorageError,
  );
  const pending = storage();
  writePendingOperation(pending.value, first);
  assert.throws(
    () => clearPendingOperation({ ...pending.value, removeItem() {} }, first),
    PendingOperationStorageError,
  );
  assert.deepEqual(listPendingOperations(pending.value, identity()), [first]);
});

test("checkpoint work is bounded and a full pending set preserves existing recovery metadata", () => {
  const { value, records } = storage();
  for (let index = 0; index < 64; index++)
    writePendingOperation(
      value,
      fixture({
        operationId: `${index.toString(16).padStart(8, "0")}-c1e4-4931-b7b2-2aec14135be7`,
      }),
    );
  assert.equal(listPendingOperations(value, identity()).length, 64);
  assert.throws(
    () => writePendingOperation(value, first),
    PendingOperationStorageError,
  );
  assert.equal(records.size, 64);
  let scans = 0;
  assert.throws(
    () =>
      listPendingOperations(
        {
          ...value,
          length: 4097,
          key() {
            scans++;
            return null;
          },
        },
        identity(),
      ),
    PendingOperationStorageError,
  );
  assert.equal(scans, 0);
});
