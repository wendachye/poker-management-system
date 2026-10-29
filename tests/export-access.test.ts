import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkedExportAccess,
  decodeExportAccess,
  encodeExportAccess,
  EXPORT_ACCESS_HEADER,
  sameExportAccess,
  type ExportAccess,
} from "../src/lib/export-access";
import type { Role } from "../src/domain/model";

const access: ExportAccess = Object.freeze({
  actorId: "fictional-staff",
  branchId: "fictional-venue",
  role: "ADMIN",
});

test("export access has one header codec and accepts every exact staff role", () => {
  assert.equal(EXPORT_ACCESS_HEADER, "X-Poker-Export-Access");
  for (const role of ["ADMIN", "MANAGER", "CASHIER", "DEALER"] as Role[]) {
    const input = Object.freeze({ ...access, role });
    const checked = checkedExportAccess(input);
    assert.deepEqual(checked, input);
    assert.notEqual(checked, input);
    assert.deepEqual(decodeExportAccess(encodeExportAccess(input)), input);
  }
});

test("Unicode, punctuation and boundary-length IDs round-trip without normalization", () => {
  for (const input of [
    { ...access, actorId: ' 职员🂡/é"?&=\n', branchId: " 场馆·甲  " },
    { ...access, actorId: "a".repeat(100), branchId: "b".repeat(100) },
    { ...access, actorId: "🂡".repeat(50), branchId: "场".repeat(100) },
    { ...access, actorId: "\ud800", branchId: "\udfff" },
  ]) {
    const encoded = encodeExportAccess(input);
    assert.ok(encoded.length <= 2048);
    assert.ok(!/[\r\n\u0080-\uffff]/.test(encoded));
    assert.deepEqual(decodeExportAccess(encoded), input);
    assert.deepEqual(checkedExportAccess(input), input);
  }
});

test("strict access rejects missing, empty, oversized and extra identity data", () => {
  for (const input of [
    null,
    undefined,
    false,
    "staff",
    [],
    {},
    { actorId: access.actorId, branchId: access.branchId },
    { ...access, actorId: "" },
    { ...access, actorId: " \t\n" },
    { ...access, branchId: "" },
    { ...access, branchId: "\u3000" },
    { ...access, actorId: "a".repeat(101) },
    { ...access, branchId: "b".repeat(101) },
    { ...access, actorId: 1 },
    { ...access, role: "OWNER" },
    { ...access, role: "admin" },
    { ...access, password: "must-not-retain" },
    Object.assign(Object.create(access), { extra: true }),
    Object.defineProperty({ ...access }, "private", { value: "secret" }),
    { ...access, [Symbol("private")]: "secret" },
  ])
    assert.equal(checkedExportAccess(input), null);
});

test("malformed, oversized and incomplete header values safely return null", () => {
  for (const header of [
    null,
    "",
    "%",
    "%C0%AF",
    "%E0%A4%A",
    "x".repeat(2049),
    ...[
      "not-json",
      "null",
      "[]",
      "{}",
      JSON.stringify({ ...access, extra: true }),
    ].map(encodeURIComponent),
  ])
    assert.equal(decodeExportAccess(header), null);
});

test("checked and encoded access do not expose failures from untrusted objects", () => {
  const invalid = Object.defineProperty({ ...access }, "actorId", {
    get() {
      throw new Error("private-untrusted-property");
    },
  });
  assert.equal(checkedExportAccess(invalid), null);
  for (const input of [invalid, null, { ...access, role: "OWNER" }])
    assert.throws(
      () => encodeExportAccess(input as ExportAccess),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, "Reload the report before exporting.");
        return true;
      },
    );
});

test("export equality requires all exact fields and valid metadata on both sides", () => {
  assert.equal(sameExportAccess(access, { ...access }), true);
  for (const different of [
    null,
    { ...access, actorId: "other-staff" },
    { ...access, actorId: access.actorId + " " },
    { ...access, branchId: "other-venue" },
    { ...access, role: "MANAGER" },
    { ...access, extra: true },
  ]) {
    assert.equal(sameExportAccess(access, different), false);
    assert.equal(sameExportAccess(different, access), false);
  }
});
