import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { DomainError } from "../src/domain/operations";
import { body, verifyOrigin } from "../src/server/http";

const origin = process.env.APP_ORIGIN || "https://poker.test";
const encoder = new TextEncoder();

function request(payload?: string, headers: Record<string, string> = {}) {
  return new Request(`${origin}/api/state`, {
    method: "POST",
    headers: {
      origin,
      "content-type": "application/json",
      ...headers,
    },
    body: payload,
  });
}

function streamed(chunks: Uint8Array[], headers: Record<string, string> = {}) {
  let reads = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const chunk = chunks[reads++];
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  const init: RequestInit & { duplex: "half" } = {
    method: "POST",
    headers: { origin, "content-type": "application/json", ...headers },
    body: stream,
    duplex: "half",
  };
  return {
    request: new Request(`${origin}/api/state`, init),
    reads: () => reads,
    cancelled: () => cancelled,
  };
}

function domainError(status: number, message: string) {
  return (error: unknown) => {
    assert.ok(error instanceof DomainError);
    assert.equal(error.status, status);
    assert.equal(error.message, message);
    return true;
  };
}

const uploadTimedOut = "Request upload timed out. Please try again.";
const uploadCancelled = "Request upload was cancelled. Please try again.";
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function uploadClock(t: TestContext) {
  let current = 0;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(performance, "now", () => current);
  const scheduled = t.mock.method(globalThis, "setTimeout");
  const cleared = t.mock.method(globalThis, "clearTimeout");
  t.after(() => {
    t.mock.restoreAll();
    t.mock.timers.reset();
  });
  return {
    advance(milliseconds: number) {
      current += milliseconds;
      t.mock.timers.tick(milliseconds);
    },
    setMonotonicTime(milliseconds: number) {
      current = milliseconds;
    },
    scheduled,
    cleared,
  };
}

function openBody(
  initial = "{}",
  signal?: AbortSignal,
  cancel?: () => void | Promise<void>,
  headers: Record<string, string> = {},
) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let cancellations = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      start(value) {
        controller = value;
        if (initial) value.enqueue(encoder.encode(initial));
      },
      cancel() {
        cancellations++;
        return cancel?.();
      },
    },
    { highWaterMark: 0 },
  );
  const init: RequestInit & { duplex: "half" } = {
    method: "POST",
    headers: { origin, "content-type": "application/json", ...headers },
    body: stream,
    signal,
    duplex: "half",
  };
  return {
    request: new Request(`${origin}/api/state`, init),
    controller,
    cancellations: () => cancellations,
  };
}

test("JSON reader accepts valid UTF-8 and the exact 16000-byte boundary", async () => {
  assert.deepEqual(await body(request('{"name":"玩家"}')), { name: "玩家" });
  const value = "x".repeat(15992);
  const payload = JSON.stringify({ v: value });
  assert.equal(encoder.encode(payload).byteLength, 16000);
  assert.deepEqual(await body(request(payload)), { v: value });
});

test("declared oversized bodies are cancelled without reading their stream", async () => {
  for (const length of ["16001", "9".repeat(100)]) {
    const source = streamed([encoder.encode("{}")], {
      "content-length": length,
    });
    await assert.rejects(
      body(source.request),
      domainError(413, "Request is too large."),
    );
    assert.equal(source.reads(), 0);
    assert.equal(source.cancelled(), true);
    assert.equal(source.request.body?.locked, false);
  }
});

test("an oversized chunk is cancelled before reading any later chunk", async () => {
  const source = streamed([
    new Uint8Array(16001),
    encoder.encode("must not be read"),
  ]);
  await assert.rejects(
    body(source.request),
    domainError(413, "Request is too large."),
  );
  assert.equal(source.reads(), 1);
  assert.equal(source.cancelled(), true);
  assert.equal(source.request.body?.locked, false);
});

test("chunked bodies enforce a cumulative byte limit without Content-Length", async () => {
  const source = streamed([
    new Uint8Array(8000),
    new Uint8Array(8000),
    new Uint8Array(1),
    encoder.encode("must not be read"),
  ]);
  await assert.rejects(
    body(source.request),
    domainError(413, "Request is too large."),
  );
  assert.equal(source.reads(), 3);
  assert.equal(source.cancelled(), true);
});

test("a small declared length cannot bypass streaming size enforcement", async () => {
  const source = streamed([new Uint8Array(16001)], {
    "content-length": "2",
  });
  await assert.rejects(
    body(source.request),
    domainError(413, "Request is too large."),
  );
  assert.equal(source.cancelled(), true);
});

test("multibyte strings are limited by bytes rather than character count", async () => {
  const payload = JSON.stringify({ v: "你".repeat(6000) });
  assert.ok(payload.length < 16000);
  assert.ok(encoder.encode(payload).byteLength > 16000);
  await assert.rejects(
    body(request(payload)),
    domainError(413, "Request is too large."),
  );
});

test("valid UTF-8 split between chunks decodes correctly", async () => {
  const bytes = encoder.encode('{"name":"玩家"}');
  const source = streamed([...bytes].map((byte) => Uint8Array.of(byte)));
  assert.deepEqual(await body(source.request), { name: "玩家" });
  assert.equal(source.cancelled(), false);
  assert.equal(source.request.body?.locked, false);
});

test("invalid Content-Length values fail before reading", async () => {
  for (const length of ["", "-1", "1.5", "1e4", "two", "2, 2"]) {
    const source = streamed([encoder.encode("{}")], {
      "content-length": length,
    });
    await assert.rejects(
      body(source.request),
      domainError(400, "Invalid Content-Length."),
    );
    assert.equal(source.reads(), 0);
  }
});

test("JSON media types accept case and well-formed optional parameters", async () => {
  for (const type of [
    "application/json",
    "Application/JSON",
    "application/json; charset=utf-8",
    'application/json; charset="UTF-8"',
    'application/json; profile="one;two"; version=1',
  ]) {
    assert.deepEqual(await body(request("{}", { "content-type": type })), {});
  }
});

test("malformed and non-JSON media types fail before reading", async () => {
  for (const type of [
    "",
    "text/plain",
    "application/jsonx",
    "application/json-patch+json",
    "application/json, text/plain",
    "application/json;",
    "application/json; charset",
    "application/json; charset=",
    'application/json; charset="unterminated',
    "application/json; charset=utf-8 trailing",
  ]) {
    const source = streamed([encoder.encode("{}")], { "content-type": type });
    await assert.rejects(
      body(source.request),
      domainError(415, "JSON is required."),
    );
    assert.equal(source.reads(), 0);
  }
});

test("empty, malformed JSON and invalid UTF-8 receive normal validation errors", async () => {
  for (const payload of [undefined, "", "{", '{"a":1} trailing']) {
    await assert.rejects(
      body(request(payload)),
      domainError(400, "Invalid JSON."),
    );
  }
  const source = streamed([Uint8Array.of(0xff)]);
  await assert.rejects(body(source.request), domainError(400, "Invalid JSON."));
});

test("a failed request stream returns a validation error and releases its lock", async () => {
  const init: RequestInit & { duplex: "half" } = {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: new ReadableStream({
      start(controller) {
        controller.error(new Error("connection interrupted"));
      },
    }),
    duplex: "half",
  };
  const interrupted = new Request(`${origin}/api/state`, init);
  await assert.rejects(
    body(interrupted),
    domainError(400, "Could not read request body."),
  );
  assert.equal(interrupted.body?.locked, false);
});

test("origin verification continues to reject cross-origin requests", () => {
  assert.throws(
    () => verifyOrigin(request("{}", { origin: "https://untrusted.test" })),
    domainError(403, "Request origin is not allowed."),
  );
});

test("a stalled small body expires at one total ten-second upload deadline", async (t) => {
  const clock = uploadClock(t);
  const source = openBody();
  let settled = false;
  const result = assert
    .rejects(body(source.request), domainError(408, uploadTimedOut))
    .then(() => {
      settled = true;
    });
  await flush();
  clock.advance(9999);
  await flush();
  assert.equal(settled, false);
  assert.equal(source.request.body?.locked, true);
  clock.advance(1);
  await result;
  assert.equal(source.cancellations(), 1);
  assert.equal(source.request.body?.locked, false);
  assert.equal(clock.scheduled.mock.callCount(), 1);
  assert.equal(clock.cleared.mock.callCount(), 1);
});

test("drip-fed chunks cannot renew the total upload budget", async (t) => {
  const clock = uploadClock(t);
  const source = openBody('{"value":"');
  const result = assert.rejects(
    body(source.request),
    domainError(408, uploadTimedOut),
  );
  await flush();
  for (let index = 0; index < 3; index++) {
    clock.advance(3000);
    source.controller.enqueue(encoder.encode("x"));
    await flush();
  }
  assert.equal(source.cancellations(), 0);
  clock.advance(1000);
  await result;
  assert.equal(source.cancellations(), 1);
  assert.equal(source.request.body?.locked, false);
  assert.equal(clock.scheduled.mock.callCount(), 1);
});

test("a pre-aborted request is rejected without reading or retaining a timer", async (t) => {
  const clock = uploadClock(t);
  const abort = new AbortController();
  abort.abort(new Error("private-cancellation-reason"));
  const source = openBody("{}", abort.signal);
  const listener = t.mock.method(source.request.signal, "addEventListener");
  await assert.rejects(body(source.request), domainError(408, uploadCancelled));
  assert.equal(source.cancellations(), 1);
  assert.equal(source.request.body?.locked, false);
  assert.equal(clock.scheduled.mock.callCount(), 0);
  assert.equal(listener.mock.callCount(), 0);
});

test("an in-flight abort rejects safely even when cancellation resolves the read as EOF", async (t) => {
  const clock = uploadClock(t);
  const abort = new AbortController();
  const source = openBody("{}", abort.signal);
  const added = t.mock.method(source.request.signal, "addEventListener");
  const removed = t.mock.method(source.request.signal, "removeEventListener");
  const result = assert.rejects(
    body(source.request),
    domainError(408, uploadCancelled),
  );
  await flush();
  abort.abort("private-abort-detail");
  await result;
  assert.equal(source.cancellations(), 1);
  assert.equal(source.request.body?.locked, false);
  assert.equal(clock.cleared.mock.callCount(), 1);
  assert.equal(removed.mock.callCount(), 1);
  assert.equal(
    removed.mock.calls[0].arguments[1],
    added.mock.calls[0].arguments[1],
  );
});

test("overdue EOF is rejected by the monotonic deadline even before its timer runs", async (t) => {
  const clock = uploadClock(t);
  const source = openBody();
  const result = assert.rejects(
    body(source.request),
    domainError(408, uploadTimedOut),
  );
  await flush();
  // Do not advance fake timers: this models the timer being delayed by other work.
  clock.setMonotonicTime(10000);
  source.controller.close();
  await result;
  assert.equal(source.request.body?.locked, false);
  assert.equal(clock.cleared.mock.callCount(), 1);
});

test("rapid empty chunks cannot starve the absolute deadline", async (t) => {
  const clock = uploadClock(t);
  let pulls = 0;
  let cancellations = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        clock.setMonotonicTime(++pulls * 2500);
        controller.enqueue(new Uint8Array());
      },
      cancel() {
        cancellations++;
      },
    },
    { highWaterMark: 0 },
  );
  const init: RequestInit & { duplex: "half" } = {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: stream,
    duplex: "half",
  };
  const rapid = new Request(`${origin}/api/state`, init);
  await assert.rejects(body(rapid), domainError(408, uploadTimedOut));
  assert.equal(pulls, 4);
  assert.equal(cancellations, 1);
  assert.equal(rapid.body?.locked, false);
});

for (const cancellation of ["rejects", "never finishes"])
  test(`upload expiry does not wait for a source whose cancellation ${cancellation}`, async (t) => {
    const clock = uploadClock(t);
    const source = openBody("{}", undefined, () =>
      cancellation === "rejects"
        ? Promise.reject(new Error("private-cancel-error"))
        : new Promise<void>(() => {}),
    );
    const result = assert.rejects(
      body(source.request),
      domainError(408, uploadTimedOut),
    );
    await flush();
    clock.advance(10000);
    await result;
    await flush();
    assert.equal(source.cancellations(), 1);
    assert.equal(source.request.body?.locked, false);
    assert.equal(clock.cleared.mock.callCount(), 1);
  });

test("success, invalid JSON, failed streams and oversized uploads clean up their resources", async (t) => {
  const clock = uploadClock(t);
  for (const outcome of ["success", "JSON", "stream", "oversize"] as const) {
    const abort = new AbortController();
    const source = openBody(
      outcome === "oversize"
        ? "x".repeat(16001)
        : outcome === "JSON"
          ? "{"
          : "{}",
      abort.signal,
    );
    const added = t.mock.method(source.request.signal, "addEventListener");
    const removed = t.mock.method(source.request.signal, "removeEventListener");
    if (outcome === "stream")
      source.controller.error(new Error("private-stream-error"));
    else source.controller.close();
    if (outcome === "success") assert.deepEqual(await body(source.request), {});
    else
      await assert.rejects(
        body(source.request),
        domainError(
          outcome === "oversize" ? 413 : 400,
          outcome === "oversize"
            ? "Request is too large."
            : outcome === "JSON"
              ? "Invalid JSON."
              : "Could not read request body.",
        ),
      );
    assert.equal(source.request.body?.locked, false);
    assert.equal(added.mock.callCount(), 1);
    assert.equal(removed.mock.callCount(), 1);
    assert.equal(
      removed.mock.calls[0].arguments[1],
      added.mock.calls[0].arguments[1],
    );
    abort.abort("must-not-affect-a-finished-request");
  }
  assert.equal(clock.scheduled.mock.callCount(), 4);
  assert.equal(clock.cleared.mock.callCount(), 4);
  clock.advance(20000);
  await flush();
});

test("ordinary upload can finish within the budget and leaves no later timeout or abort work", async (t) => {
  const clock = uploadClock(t);
  const abort = new AbortController();
  const source = openBody('{"name":"玩家"}', abort.signal);
  const result = body(source.request);
  await flush();
  clock.advance(9999);
  source.controller.close();
  assert.deepEqual(await result, { name: "玩家" });
  assert.equal(source.request.body?.locked, false);
  assert.equal(source.cancellations(), 0);
  assert.equal(clock.cleared.mock.callCount(), 1);
  abort.abort("too-late-private-reason");
  clock.advance(10001);
  await flush();
  assert.equal(source.cancellations(), 0);
});

test("fast header failures cancel without awaiting an uncooperative source", async () => {
  for (const [headers, status, message] of [
    [
      { origin: "https://untrusted.test" },
      403,
      "Request origin is not allowed.",
    ],
    [{ "content-type": "text/plain" }, 415, "JSON is required."],
    [{ "content-length": "two" }, 400, "Invalid Content-Length."],
    [{ "content-length": "16001" }, 413, "Request is too large."],
  ] as const) {
    const source = openBody(
      "{}",
      undefined,
      () => new Promise<void>(() => {}),
      headers,
    );
    await assert.rejects(body(source.request), domainError(status, message));
    assert.equal(source.cancellations(), 1);
    assert.equal(source.request.body?.locked, false);
  }
});
