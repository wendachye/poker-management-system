import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  ManagementResponseError,
  requestManagementJson,
} from "../src/lib/management-response";

const timeoutMessage =
  "The request timed out. Retry the last request to confirm its result.";
const reference = "acdbd459-c1e4-4931-b7b2-2aec14135be7";
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function clock(t: TestContext) {
  let current = 100;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(performance, "now", () => current);
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
      current += ms;
      t.mock.timers.tick(ms);
    },
    monotonicOnly(ms: number) {
      current += ms;
    },
  };
}

function watch<T>(promise: Promise<T>) {
  const outcome: {
    settled: boolean;
    accepted: boolean;
    value?: T;
    error?: unknown;
  } = { settled: false, accepted: false };
  const done = promise.then(
    (value) => {
      outcome.settled = true;
      outcome.accepted = true;
      outcome.value = value;
    },
    (error: unknown) => {
      outcome.settled = true;
      outcome.error = error;
    },
  );
  return { outcome, done };
}

function timedOut(outcome: ReturnType<typeof watch>["outcome"]) {
  assert.equal(outcome.settled, true, "the caller must settle at its deadline");
  assert.equal(outcome.accepted, false);
  assert.ok(outcome.error instanceof ManagementResponseError);
  assert.equal(outcome.error.status, 408);
  assert.equal(outcome.error.uncertain, true);
  assert.equal(outcome.error.message, timeoutMessage);
  assert.equal(outcome.error.requestId, null);
}

function delayedBody() {
  const gate = Promise.withResolvers<unknown>();
  const response = Response.json({ unused: true });
  let reads = 0;
  response.json = async () => {
    reads++;
    return gate.promise;
  };
  return { gate, response, reads: () => reads };
}

test("a pre-aborted JSON caller never dispatches or retains a deadline timer", async (t) => {
  const timer = clock(t);
  const caller = new AbortController();
  const reason = new DOMException("View closed", "AbortError");
  caller.abort(reason);
  let requests = 0;
  await assert.rejects(
    requestManagementJson(
      async () => {
        requests++;
        return Response.json({ saved: true });
      },
      caller.signal,
      20,
    ),
    (error: unknown) => error === reason,
  );
  assert.equal(requests, 0);
  assert.equal(timer.scheduled.mock.callCount(), 0);
});

test("the JSON deadline settles even when its request never reacts to cancellation", async (t) => {
  const timer = clock(t);
  const pending = watch(
    requestManagementJson(() => new Promise<Response>(() => {}), undefined, 20),
  );
  await flush();
  timer.advance(20);
  await flush();
  timedOut(pending.outcome);
  await pending.done;
  assert.equal(timer.cleared.mock.callCount(), 1);
});

test("the JSON deadline settles an uncooperative body without waiting for EOF", async (t) => {
  const timer = clock(t);
  const response = Response.json({ unused: true });
  let reads = 0;
  response.json = () => {
    reads++;
    return new Promise(() => {});
  };
  const pending = watch(
    requestManagementJson(async () => response, undefined, 20),
  );
  await flush();
  assert.equal(reads, 1);
  timer.advance(20);
  await flush();
  timedOut(pending.outcome);
  await pending.done;
});

test("headers arriving after cancellation never start JSON body consumption", async (t) => {
  const timer = clock(t);
  const headers = Promise.withResolvers<Response>();
  const body = delayedBody();
  const pending = watch(
    requestManagementJson(() => headers.promise, undefined, 20),
  );
  await flush();
  timer.advance(20);
  await flush();
  headers.resolve(body.response);
  body.gate.resolve({ saved: true });
  await flush();
  await pending.done;
  timedOut(pending.outcome);
  assert.equal(body.reads(), 0);
});

test("a successful body arriving after the JSON deadline cannot confirm a save", async (t) => {
  const timer = clock(t);
  const body = delayedBody();
  const pending = watch(
    requestManagementJson(async () => body.response, undefined, 20),
  );
  await flush();
  assert.equal(body.reads(), 1);
  timer.advance(20);
  await flush();
  body.gate.resolve({ saved: true });
  await flush();
  await pending.done;
  timedOut(pending.outcome);
});

for (const phase of ["headers", "body"] as const)
  test(`late ${phase} failure is observed after timeout without a second caller outcome`, async (t) => {
    const timer = clock(t);
    const headers = Promise.withResolvers<Response>();
    const body = delayedBody();
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => unhandled.push(error);
    process.on("unhandledRejection", onUnhandled);
    t.after(() => process.off("unhandledRejection", onUnhandled));
    const pending = watch(
      requestManagementJson(
        phase === "headers" ? () => headers.promise : async () => body.response,
        undefined,
        20,
      ),
    );
    await flush();
    timer.advance(20);
    await flush();
    const failure = new Error("private-late-transport-detail");
    if (phase === "headers") headers.reject(failure);
    else body.gate.reject(failure);
    await flush();
    await pending.done;
    timedOut(pending.outcome);
    assert.deepEqual(unhandled, []);
  });

for (const phase of ["headers", "body"] as const)
  test(`caller cancellation settles ignored ${phase} cancellation with the original reason`, async (t) => {
    const timer = clock(t);
    const caller = new AbortController();
    const reason = new DOMException("View closed", "AbortError");
    const headers = Promise.withResolvers<Response>();
    const body = delayedBody();
    const pending = watch(
      requestManagementJson(
        phase === "headers" ? () => headers.promise : async () => body.response,
        caller.signal,
        20,
      ),
    );
    await flush();
    caller.abort(reason);
    await flush();
    try {
      assert.equal(pending.outcome.settled, true);
      assert.equal(pending.outcome.error, reason);
      assert.equal(pending.outcome.accepted, false);
      assert.equal(timer.cleared.mock.callCount(), 1);
    } finally {
      headers.resolve(body.response);
      body.gate.resolve({ saved: true });
      await flush();
      await pending.done;
    }
    assert.equal(pending.outcome.error, reason);
    if (phase === "headers") assert.equal(body.reads(), 0);
  });

for (const phase of ["headers", "body"] as const)
  test(`caller cancellation settles a never-ending ${phase} promise`, async (t) => {
    clock(t);
    const caller = new AbortController();
    const reason = new DOMException("View closed", "AbortError");
    const response = Response.json({ unused: true });
    response.json = () => new Promise(() => {});
    const pending = watch(
      requestManagementJson(
        phase === "headers"
          ? () => new Promise<Response>(() => {})
          : async () => response,
        caller.signal,
        20,
      ),
    );
    await flush();
    caller.abort(reason);
    await flush();
    assert.equal(pending.outcome.settled, true);
    assert.equal(pending.outcome.accepted, false);
    assert.equal(pending.outcome.error, reason);
    await pending.done;
  });

test("overdue headers are refused by monotonic time before a delayed timer fires", async (t) => {
  const timer = clock(t);
  const headers = Promise.withResolvers<Response>();
  const body = delayedBody();
  const pending = watch(
    requestManagementJson(() => headers.promise, undefined, 20),
  );
  await flush();
  timer.monotonicOnly(20);
  headers.resolve(body.response);
  body.gate.resolve({ saved: true });
  await flush();
  await pending.done;
  timedOut(pending.outcome);
  assert.equal(body.reads(), 0);
});

test("an overdue JSON result is refused even when its timer has not run", async (t) => {
  const timer = clock(t);
  const body = delayedBody();
  const pending = watch(
    requestManagementJson(async () => body.response, undefined, 20),
  );
  await flush();
  timer.monotonicOnly(20);
  body.gate.resolve({ saved: true });
  await flush();
  await pending.done;
  timedOut(pending.outcome);
});

test("synchronous request work cannot carry a response beyond the monotonic deadline", async (t) => {
  const timer = clock(t);
  let reads = 0;
  const response = Response.json({ saved: true });
  response.json = async () => {
    reads++;
    return { saved: true };
  };
  const pending = watch(
    requestManagementJson(
      async () => {
        timer.monotonicOnly(20);
        return response;
      },
      undefined,
      20,
    ),
  );
  await pending.done;
  timedOut(pending.outcome);
  assert.equal(reads, 0);
});

test("a caller cancelled during JSON parsing cannot accept that parsed result", async (t) => {
  clock(t);
  const caller = new AbortController();
  const reason = new DOMException("View closed", "AbortError");
  const response = Response.json({ saved: true });
  response.json = async () => {
    caller.abort(reason);
    return { saved: true };
  };
  await assert.rejects(
    requestManagementJson(async () => response, caller.signal, 20),
    (error: unknown) => error === reason,
  );
});

test("a late definite conflict cannot downgrade an already uncertain timeout", async (t) => {
  const timer = clock(t);
  const body = delayedBody();
  const response = new Response(null, {
    status: 409,
    headers: { "x-request-id": reference },
  });
  response.json = body.response.json;
  const pending = watch(
    requestManagementJson(async () => response, undefined, 20),
  );
  await flush();
  timer.advance(20);
  await flush();
  body.gate.resolve({ error: "Another staff member changed this record." });
  await flush();
  await pending.done;
  timedOut(pending.outcome);
});

test("JSON request outcomes release their deadline timer and owned abort listeners", async (t) => {
  const timer = clock(t);
  const added = t.mock.method(AbortSignal.prototype, "addEventListener");
  const removed = t.mock.method(AbortSignal.prototype, "removeEventListener");
  for (const outcome of [
    "success",
    "conflict",
    "transport",
    "cancel",
  ] as const) {
    const caller = new AbortController();
    const beforeClear = timer.cleared.mock.callCount();
    const beforeAdded = added.mock.callCount();
    const beforeRemoved = removed.mock.callCount();
    const reason = new DOMException("View closed", "AbortError");
    const operation = requestManagementJson(
      async () => {
        if (outcome === "transport") throw new Error("private transport");
        if (outcome === "cancel") {
          caller.abort(reason);
          return Response.json({ saved: true });
        }
        return outcome === "conflict"
          ? Response.json(
              { error: "Review the player." },
              { status: 409, headers: { "x-request-id": reference } },
            )
          : Response.json({ saved: true });
      },
      caller.signal,
      20,
    );
    if (outcome === "success")
      assert.deepEqual(await operation, { saved: true });
    else if (outcome === "cancel")
      await assert.rejects(operation, (error: unknown) => error === reason);
    else
      await assert.rejects(operation, (error: unknown) => {
        assert.ok(error instanceof ManagementResponseError);
        assert.equal(error.status, outcome === "conflict" ? 409 : 0);
        assert.equal(error.uncertain, outcome !== "conflict");
        if (outcome === "conflict") {
          assert.equal(error.requestId, reference);
          assert.equal(error.message, "Review the player.");
        }
        return true;
      });
    assert.equal(timer.cleared.mock.callCount() - beforeClear, 1);
    const removals = removed.mock.calls.slice(beforeRemoved);
    for (const addition of added.mock.calls.slice(beforeAdded)) {
      if (addition.arguments[0] !== "abort") continue;
      assert.ok(
        removals.some(
          (removal) =>
            removal.this === addition.this &&
            removal.arguments[0] === addition.arguments[0] &&
            removal.arguments[1] === addition.arguments[1],
        ),
        "every owned abort listener must be removed on settlement",
      );
    }
  }
});
