import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { test, type TestContext } from "node:test";
import type { Snapshot } from "../src/domain/model";
import {
  encodeExportAccess,
  EXPORT_ACCESS_HEADER,
} from "../src/lib/export-access";
import { ManagementResponseError } from "../src/lib/management-response";
import { readReportCsv } from "../src/lib/report-export";

const limit = 4_000_000;
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
const access = encodeExportAccess({
  actorId: context.user.id,
  branchId: context.branch.id,
  role: "ADMIN",
});
const headers = {
  "content-type": "text/csv; charset=utf-8",
  [EXPORT_ACCESS_HEADER]: access,
};
const safeFailure = "Cannot download report. Please try again.";
const timeoutMessage = "Report download timed out. Try exporting again.";
const reference = "acdbd459-c1e4-4931-b7b2-2aec14135be7";
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function clock(t: TestContext) {
  let now = 100;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(performance, "now", () => now);
  const scheduled = t.mock.method(globalThis, "setTimeout");
  const cleared = t.mock.method(globalThis, "clearTimeout");
  t.after(() => {
    t.mock.restoreAll();
    t.mock.timers.reset();
  });
  return {
    scheduled,
    cleared,
    advance(ms: number) {
      now += ms;
      t.mock.timers.tick(ms);
    },
    monotonicOnly(ms: number) {
      now += ms;
    },
  };
}

function watch<T>(promise: Promise<T>) {
  const outcome: {
    settled: boolean;
    accepted: boolean;
    error?: unknown;
    value?: T;
  } = { settled: false, accepted: false };
  const done = promise.then(
    (value) => {
      outcome.settled = true;
      outcome.accepted = true;
      outcome.value = value;
    },
    (error) => {
      outcome.settled = true;
      outcome.error = error;
    },
  );
  return { outcome, done };
}
function timedOut(outcome: ReturnType<typeof watch>["outcome"]) {
  assert.equal(outcome.settled, true, "the export must settle at its deadline");
  assert.equal(outcome.accepted, false);
  assert.ok(outcome.error instanceof ManagementResponseError);
  assert.equal(outcome.error.status, 408);
  assert.equal(outcome.error.message, timeoutMessage);
}
function cancelled(outcome: ReturnType<typeof watch>["outcome"]) {
  assert.equal(outcome.settled, true, "the cancelled export must settle");
  assert.equal(outcome.accepted, false);
  assert.ok(outcome.error instanceof DOMException);
  assert.equal(outcome.error.name, "AbortError");
  assert.equal(outcome.error.message, "Report download cancelled.");
}

/** A real, demand-driven stream exposes byte delivery and cancellation. */
function chunked(
  chunks: Uint8Array[],
  options: {
    status?: number;
    headers?: HeadersInit;
    cancel?: () => Promise<void> | void;
  } = {},
) {
  let reads = 0,
    bytes = 0,
    cancels = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const value = chunks[reads++];
        if (value) {
          bytes += value.byteLength;
          controller.enqueue(value);
        } else controller.close();
      },
      cancel() {
        cancels++;
        return options.cancel?.();
      },
    },
    { highWaterMark: 0 },
  );
  return {
    body,
    response: new Response(body, {
      status: options.status ?? 200,
      headers: options.headers ?? headers,
    }),
    reads: () => reads,
    bytes: () => bytes,
    cancels: () => cancels,
  };
}

function pendingBody(options: { status?: number; neverCancel?: boolean } = {}) {
  const started = Promise.withResolvers<void>(),
    gate = Promise.withResolvers<void>();
  let wasCancelled = false,
    cancels = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        started.resolve();
        await gate.promise;
        if (!wasCancelled) {
          controller.enqueue(new TextEncoder().encode("late report"));
          controller.close();
        }
      },
      cancel() {
        wasCancelled = true;
        cancels++;
        if (options.neverCancel) return new Promise<void>(() => {});
      },
    },
    { highWaterMark: 0 },
  );
  return {
    body,
    response: new Response(body, {
      status: options.status ?? 200,
      headers: options.status
        ? { "content-type": "application/json", "x-request-id": reference }
        : headers,
    }),
    started: started.promise,
    release: () => gate.resolve(),
    cancels: () => cancels,
  };
}

test("a CSV at the exact byte budget succeeds across chunks and releases its reader", async () => {
  const fixture = chunked([
    new Uint8Array(1_000_000),
    new Uint8Array(3_000_000),
  ]);
  const value = await readReportCsv(
    { resource: "report" },
    context,
    async () => fixture.response,
  );
  assert.equal(value.size, limit);
  assert.equal(fixture.bytes(), limit);
  assert.equal(fixture.cancels(), 0);
  assert.equal(fixture.body.locked, false);
});

test("tiny CSV chunks are coalesced before constructing the download Blob", async () => {
  const bytes = 10_000;
  let delivered = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (delivered === bytes) controller.close();
        else {
          delivered++;
          controller.enqueue(new Uint8Array([97]));
        }
      },
    },
    { highWaterMark: 0 },
  );
  const response = new Response(body, { headers });
  const OriginalBlob = globalThis.Blob;
  const parts: number[] = [];
  globalThis.Blob = class extends OriginalBlob {
    constructor(values: BlobPart[] = [], options?: BlobPropertyBag) {
      parts.push(values.length);
      super(values, options);
    }
  };
  let value: Blob;
  try {
    value = await readReportCsv(
      { resource: "report" },
      context,
      async () => response,
    );
  } finally {
    globalThis.Blob = OriginalBlob;
  }
  assert.equal(value.size, bytes);
  assert.equal(await value.text(), "a".repeat(bytes));
  assert.ok(parts.length > 0);
  assert.ok(parts.every((count) => count <= Math.ceil(bytes / 65_536)));
  assert.equal(body.locked, false);
});

test("the first oversized chunk cancels CSV before later chunks or EOF are read", async () => {
  for (const contentLength of [undefined, "1"]) {
    const fixture = chunked(
      [
        new Uint8Array(2_000_000),
        new Uint8Array(2_000_000),
        new Uint8Array(1),
        new Uint8Array(1_000_000),
      ],
      {
        headers: {
          ...headers,
          ...(contentLength ? { "content-length": contentLength } : {}),
        },
      },
    );
    await assert.rejects(
      readReportCsv(
        { resource: "report" },
        context,
        async () => fixture.response,
      ),
      { message: safeFailure },
    );
    assert.equal(fixture.bytes(), limit + 1);
    assert.equal(fixture.reads(), 3);
    assert.equal(fixture.cancels(), 1);
    assert.equal(fixture.body.locked, false);
  }
});

test("CSV size failures do not await an uncooperative underlying cancel promise", async () => {
  const fixture = chunked([new Uint8Array(limit + 1)], {
    cancel: () => new Promise<void>(() => {}),
  });
  const result = watch(
    readReportCsv(
      { resource: "report" },
      context,
      async () => fixture.response,
    ),
  );
  await flush();
  assert.equal(result.outcome.settled, true);
  assert.equal(result.outcome.accepted, false);
  assert.equal((result.outcome.error as Error).message, safeFailure);
  assert.equal(fixture.cancels(), 1);
  assert.equal(fixture.body.locked, false);
});

test("CSV chunks preserve UTF-8, zero-length chunks and its media type", async () => {
  const text = '"玩家","😀"\n';
  const bytes = new TextEncoder().encode(text);
  const fixture = chunked([
    new Uint8Array(0),
    bytes.subarray(0, 2),
    new Uint8Array(0),
    bytes.subarray(2, 8),
    bytes.subarray(8),
  ]);
  const value = await readReportCsv(
    { resource: "range" },
    context,
    async () => fixture.response,
  );
  assert.equal(await value.text(), text);
  assert.equal(value.size, bytes.byteLength);
  assert.equal(value.type.replaceAll(" ", ""), "text/csv;charset=utf-8");
  assert.equal(fixture.body.locked, false);
});

test("empty CSV responses retain the existing empty-download behavior", async () => {
  for (const response of [
    new Response(null, { headers }),
    chunked([]).response,
  ]) {
    const value = await readReportCsv(
      { resource: "report" },
      context,
      async () => response,
    );
    assert.equal(value.size, 0);
    assert.equal(await value.text(), "");
    assert.equal(value.type.replaceAll(" ", ""), "text/csv;charset=utf-8");
    assert.equal(response.body?.locked ?? false, false);
  }
});

test("bad reviewed receipts and media types never pull a stream chunk", async () => {
  for (const changed of [
    { "content-type": "text/csv" },
    {
      ...headers,
      [EXPORT_ACCESS_HEADER]: encodeExportAccess({
        actorId: "another-staff",
        branchId: context.branch.id,
        role: "ADMIN",
      }),
    },
    { ...headers, "content-type": "text/csvevil" },
  ]) {
    const fixture = chunked([new Uint8Array(10)], { headers: changed });
    await assert.rejects(
      readReportCsv(
        { resource: "report" },
        context,
        async () => fixture.response,
      ),
    );
    assert.equal(fixture.bytes(), 0);
    assert.equal(fixture.reads(), 0);
    assert.equal(fixture.body.locked, false);
  }
});

test("bounded error bodies preserve safe status, request reference and API feedback", async () => {
  const message = "Refresh the report before exporting.";
  const text = new TextEncoder().encode(JSON.stringify({ error: message }));
  const fixture = chunked([text.subarray(0, 5), text.subarray(5)], {
    status: 409,
    headers: { "content-type": "application/json", "x-request-id": reference },
  });
  await assert.rejects(
    readReportCsv(
      { resource: "report" },
      context,
      async () => fixture.response,
    ),
    (error: unknown) => {
      assert.ok(error instanceof ManagementResponseError);
      assert.equal(error.status, 409);
      assert.equal(error.requestId, reference);
      assert.equal(error.message, message);
      return true;
    },
  );
  assert.equal(fixture.body.locked, false);
});

test("an empty 304 error keeps its original status and safe request reference", async () => {
  const response = new Response(null, {
    status: 304,
    headers: { "x-request-id": reference },
  });
  await assert.rejects(
    readReportCsv({ resource: "report" }, context, async () => response),
    (error: unknown) => {
      assert.ok(error instanceof ManagementResponseError);
      assert.equal(error.status, 304);
      assert.equal(error.requestId, reference);
      assert.equal(error.uncertain, false);
      assert.equal(
        error.message,
        "The service is unavailable. Please try again.",
      );
      return true;
    },
  );
});

test("oversized non-OK bodies are cancelled before all error bytes are buffered", async () => {
  const fixture = chunked(
    [new Uint8Array(limit), new Uint8Array(1), new Uint8Array(50)],
    {
      status: 503,
      headers: {
        "content-type": "application/json",
        "x-request-id": reference,
      },
    },
  );
  await assert.rejects(
    readReportCsv(
      { resource: "report" },
      context,
      async () => fixture.response,
    ),
    { message: safeFailure },
  );
  assert.equal(fixture.bytes(), limit + 1);
  assert.equal(fixture.reads(), 2);
  assert.equal(fixture.cancels(), 1);
  assert.equal(fixture.body.locked, false);
});

test("CSV deadline settles even if the request ignores its abort signal", async (t) => {
  const timer = clock(t),
    gate = Promise.withResolvers<Response>();
  const result = watch(
    readReportCsv({ resource: "report" }, context, async () => gate.promise),
  );
  try {
    timer.advance(45_000);
    await flush();
    timedOut(result.outcome);
  } finally {
    gate.resolve(new Response("late", { headers }));
    await result.done;
  }
});

test("caller cancellation settles a held request and never consumes its late body", async (t) => {
  clock(t);
  const caller = new AbortController(),
    gate = Promise.withResolvers<Response>();
  const fixture = chunked([new Uint8Array(10)]);
  const result = watch(
    readReportCsv(
      { resource: "report" },
      context,
      async () => gate.promise,
      caller.signal,
    ),
  );
  try {
    caller.abort(new Error("private abort reason"));
    await flush();
    cancelled(result.outcome);
  } finally {
    gate.resolve(fixture.response);
    await result.done;
    await flush();
  }
  assert.equal(fixture.reads(), 0);
});

for (const status of [200, 503])
  test(`the deadline cancels a pending ${status} body read without waiting for source cancellation`, async (t) => {
    const timer = clock(t),
      fixture = pendingBody({
        status: status === 200 ? undefined : status,
        neverCancel: true,
      });
    const result = watch(
      readReportCsv(
        { resource: "report" },
        context,
        async () => fixture.response,
      ),
    );
    try {
      await fixture.started;
      timer.advance(45_000);
      await flush();
      timedOut(result.outcome);
      assert.equal(fixture.cancels(), 1);
      assert.equal(fixture.body.locked, false);
    } finally {
      fixture.release();
      await result.done;
    }
  });

test("caller abort cancels a pending CSV reader with a fixed safe AbortError", async (t) => {
  clock(t);
  const caller = new AbortController(),
    fixture = pendingBody({ neverCancel: true });
  const result = watch(
    readReportCsv(
      { resource: "report" },
      context,
      async () => fixture.response,
      caller.signal,
    ),
  );
  try {
    await fixture.started;
    caller.abort(new Error("postgres://private:secret@db"));
    await flush();
    cancelled(result.outcome);
    assert.equal(fixture.cancels(), 1);
    assert.equal(fixture.body.locked, false);
  } finally {
    fixture.release();
    await result.done;
  }
});

test("overdue headers are rejected by monotonic time before its timer fires", async (t) => {
  const timer = clock(t),
    gate = Promise.withResolvers<Response>(),
    fixture = chunked([new Uint8Array(10)]);
  const result = watch(
    readReportCsv({ resource: "report" }, context, async () => gate.promise),
  );
  timer.monotonicOnly(45_001);
  gate.resolve(fixture.response);
  await result.done;
  timedOut(result.outcome);
  assert.equal(fixture.reads(), 0);
});

test("a late chunk is rejected by monotonic time before accepting CSV bytes", async (t) => {
  const timer = clock(t);
  let cancels = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        timer.monotonicOnly(45_001);
        controller.enqueue(new Uint8Array(10));
      },
      cancel() {
        cancels++;
      },
    },
    { highWaterMark: 0 },
  );
  const result = watch(
    readReportCsv(
      { resource: "report" },
      context,
      async () => new Response(body, { headers }),
    ),
  );
  await result.done;
  timedOut(result.outcome);
  assert.equal(cancels, 1);
  assert.equal(body.locked, false);
});

test("zero-byte drip reads cannot bypass the monotonic deadline", async (t) => {
  const timer = clock(t);
  let reads = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        reads++;
        timer.monotonicOnly(15_001);
        controller.enqueue(new Uint8Array(0));
      },
    },
    { highWaterMark: 0 },
  );
  const result = watch(
    readReportCsv(
      { resource: "report" },
      context,
      async () => new Response(body, { headers }),
    ),
  );
  await result.done;
  timedOut(result.outcome);
  assert.equal(reads, 3);
  assert.equal(body.locked, false);
});

test("a request rejection after CSV cancellation stays observed and cannot replace its outcome", async (t) => {
  clock(t);
  const caller = new AbortController(),
    gate = Promise.withResolvers<Response>();
  const result = watch(
    readReportCsv(
      { resource: "report" },
      context,
      async () => gate.promise,
      caller.signal,
    ),
  );
  caller.abort();
  await flush();
  cancelled(result.outcome);
  const error = result.outcome.error;
  gate.reject(new Error("private late transport failure"));
  await flush();
  assert.equal(result.outcome.error, error);
  assert.equal(result.outcome.accepted, false);
});

test("CSV outcomes clear their owned timer and abort listener", async (t) => {
  const timer = clock(t);
  for (const phase of ["success", "error", "cancel", "timeout"] as const) {
    const caller = new AbortController(),
      gate = Promise.withResolvers<Response>();
    let signal: AbortSignal | null | undefined;
    const scheduled = timer.scheduled.mock.callCount(),
      cleared = timer.cleared.mock.callCount();
    const result = watch(
      readReportCsv(
        { resource: "report" },
        context,
        async (_, init) => {
          signal = init.signal;
          if (phase === "success") return new Response("fixture", { headers });
          if (phase === "error") throw new Error("private transport failure");
          return gate.promise;
        },
        caller.signal,
      ),
    );
    if (phase === "cancel") caller.abort();
    if (phase === "timeout") timer.advance(45_000);
    try {
      await flush();
      assert.equal(result.outcome.settled, true);
    } finally {
      gate.resolve(new Response("late", { headers }));
      await result.done;
    }
    assert.ok(signal instanceof AbortSignal);
    assert.equal(getEventListeners(signal, "abort").length, 0);
    assert.equal(timer.scheduled.mock.callCount() - scheduled, 1);
    assert.equal(timer.cleared.mock.callCount() - cleared, 1);
  }
});
