import assert from "node:assert/strict";
import { test } from "node:test";
import type { Snapshot } from "../src/domain/model";
import {
  decodeExportAccess,
  encodeExportAccess,
  EXPORT_ACCESS_HEADER,
  type ExportAccess,
} from "../src/lib/export-access";
import { ManagementResponseError } from "../src/lib/management-response";
import { readReportCsv } from "../src/lib/report-export";

const context: Pick<Snapshot, "user" | "branch"> = {
  user: {
    id: "fictional-admin",
    username: "fictional.admin",
    branchId: "fictional-venue",
    role: "ADMIN",
  },
  branch: {
    id: "fictional-venue",
    name: "Fictional venue",
    timezone: "Asia/Kuala_Lumpur",
    role: "ADMIN",
  },
};
const access: ExportAccess = {
  actorId: context.user.id,
  branchId: context.branch.id,
  role: context.user.role,
};
const changed =
  "Staff access or venue changed. Refresh the report before exporting.";
function csv(header: string | null = encodeExportAccess(access)) {
  return new Response('"Branch","Fictional venue"\n', {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      ...(header === null ? {} : { [EXPORT_ACCESS_HEADER]: header }),
    },
  });
}

test("daily and period downloads bind the reviewed access in a header before reading CSV", async () => {
  for (const query of [
    { resource: "report" as const, dayId: "fictional-day" },
    { resource: "range" as const, from: "2026-10-01", to: "2026-10-29" },
  ]) {
    const result = await readReportCsv(query, context, async (url, init) => {
      const params = new URL(url, "http://localhost").searchParams;
      assert.equal(params.get("format"), "csv");
      assert.equal(params.get("resource"), query.resource);
      assert.equal(url.includes(access.actorId), false);
      assert.equal(url.includes(access.branchId), false);
      assert.equal(init.cache, "no-store");
      assert.ok(init.signal instanceof AbortSignal);
      assert.deepEqual(
        decodeExportAccess(new Headers(init.headers).get(EXPORT_ACCESS_HEADER)),
        access,
      );
      return csv();
    });
    assert.equal(await result.text(), '"Branch","Fictional venue"\n');
  }
});

test("an unverified or crossed export receipt never reads its report body", async () => {
  for (const header of [
    null,
    "bad%escape",
    encodeExportAccess({ ...access, actorId: "another-staff" }),
    encodeExportAccess({ ...access, branchId: "another-venue" }),
    encodeExportAccess({ ...access, role: "MANAGER" }),
  ]) {
    const response = csv(header);
    let bodyReads = 0;
    response.blob = async () => {
      bodyReads++;
      throw new Error("private-report-body");
    };
    await assert.rejects(
      readReportCsv({ resource: "report" }, context, async () => response),
      (error: unknown) =>
        error instanceof ManagementResponseError &&
        error.status === 409 &&
        error.message === changed,
    );
    assert.equal(bodyReads, 0);
  }
});

test("the reviewed identity cannot change while its export request is pending", async () => {
  const mutable = structuredClone(context);
  let finish!: () => void;
  const waiting = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const result = readReportCsv(
    { resource: "report" },
    mutable,
    async (_, init) => {
      assert.deepEqual(
        decodeExportAccess(new Headers(init.headers).get(EXPORT_ACCESS_HEADER)),
        access,
      );
      await waiting;
      return csv();
    },
  );
  mutable.user.id = "later-staff";
  mutable.user.branchId = mutable.branch.id = "later-venue";
  mutable.user.role = mutable.branch.role = "CASHIER";
  finish();
  assert.ok((await (await result).text()).includes("Fictional venue"));
});

test("inconsistent reviewed access and non-report resources send no export request", async () => {
  let requests = 0;
  const request = async () => {
    requests++;
    return csv();
  };
  for (const mismatched of [
    { ...context, branch: { ...context.branch, id: "another-venue" } },
    { ...context, branch: { ...context.branch, role: "CASHIER" as const } },
  ])
    await assert.rejects(
      readReportCsv({ resource: "report" }, mismatched, request),
      { message: "Reload the report before exporting." },
    );
  await assert.rejects(
    readReportCsv({ resource: "players" }, context, request),
    { message: "Reload the report before exporting." },
  );
  assert.equal(requests, 0);
});

test("download failures expose safe messages and reject non-CSV or oversized responses", async () => {
  await assert.rejects(
    readReportCsv({ resource: "report" }, context, async () => {
      throw new Error("postgresql://private-credentials/private-records");
    }),
    { message: "Cannot download report. Please try again." },
  );
  for (const response of [
    new Response("private-error", {
      headers: {
        "Content-Type": "text/csvevil",
        [EXPORT_ACCESS_HEADER]: encodeExportAccess(access),
      },
    }),
    new Response("x".repeat(4_000_001), {
      headers: {
        "Content-Type": "text/csv",
        [EXPORT_ACCESS_HEADER]: encodeExportAccess(access),
      },
    }),
  ])
    await assert.rejects(
      readReportCsv({ resource: "report" }, context, async () => response),
      { message: "Cannot download report. Please try again." },
    );
  await assert.rejects(
    readReportCsv({ resource: "range" }, context, async () =>
      Response.json({ error: changed }, { status: 409 }),
    ),
    (error: unknown) =>
      error instanceof ManagementResponseError &&
      error.status === 409 &&
      error.message === changed,
  );
});

test("an aborted report read reports a download timeout without financial retry advice", async (t) => {
  t.mock.method(AbortSignal, "timeout", () => AbortSignal.abort());
  await assert.rejects(
    readReportCsv({ resource: "report" }, context, async (_, init) => {
      assert.equal(init.signal!.aborted, true);
      throw init.signal!.reason;
    }),
    (error: unknown) =>
      error instanceof ManagementResponseError &&
      error.status === 408 &&
      error.message === "Report download timed out. Try exporting again.",
  );
});
