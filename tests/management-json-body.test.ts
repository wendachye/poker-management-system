import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { test } from "node:test";
import {
  MAX_MANAGEMENT_JSON_BYTES,
  readManagementJsonBody,
} from "../src/lib/management-json-body";
import {
  ManagementResponseError,
  readManagementResponse,
  requestManagementJson,
} from "../src/lib/management-response";
import { snapshotReceipt } from "../src/lib/management-contracts";
import { createPrototypeSample } from "../src/prototype/sample-data";
import type { Snapshot } from "../src/domain/model";

const limit = 16 * 1024 * 1024;
const reference = "acdbd459-c1e4-4931-b7b2-2aec14135be7";
const encoder = new TextEncoder();
const headers = {
  "content-type": "application/json",
  "x-request-id": reference,
};
const unconfirmed =
  "The server response could not be confirmed. Refresh records and retry the last request.";
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function chunked(
  chunks: Uint8Array[],
  options: {
    status?: number;
    headers?: HeadersInit;
    cancel?: () => Promise<void> | void;
  } = {},
) {
  let reads = 0;
  let delivered = 0;
  let cancels = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const value = chunks[reads++];
        if (value) {
          delivered += value.byteLength;
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
    delivered: () => delivered,
    cancels: () => cancels,
  };
}

function pendingBody(neverCancel = false) {
  const gate = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  let cancelled = false;
  let cancels = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        started.resolve();
        await gate.promise;
        if (!cancelled) {
          controller.enqueue(encoder.encode('{"late":true}'));
          controller.close();
        }
      },
      cancel() {
        cancelled = true;
        cancels++;
        if (neverCancel) return new Promise<void>(() => {});
      },
    },
    { highWaterMark: 0 },
  );
  return {
    body,
    response: new Response(body, { headers }),
    started: started.promise,
    release: () => gate.resolve(),
    cancels: () => cancels,
  };
}

function uncertain(status = 200) {
  return (error: unknown) => {
    assert.ok(error instanceof ManagementResponseError);
    assert.equal(error.status, status);
    assert.equal(error.requestId, reference);
    assert.equal(error.uncertain, true);
    assert.equal(error.message, unconfirmed);
    return true;
  };
}

test("management JSON has an explicit sixteen MiB decoded-byte budget", () => {
  assert.equal(MAX_MANAGEMENT_JSON_BYTES, limit);
});

test("an exact-budget JSON document parses without truncation and releases its reader", async () => {
  const prefix = encoder.encode('{"payload":"');
  const suffix = encoder.encode('"}');
  const characters = limit - prefix.byteLength - suffix.byteLength;
  const fixture = chunked([
    prefix,
    new Uint8Array(characters).fill(120),
    suffix,
  ]);
  const value = (await readManagementJsonBody(fixture.response)) as {
    payload: string;
  };
  assert.equal(value.payload.length, characters);
  assert.equal(value.payload.at(0), "x");
  assert.equal(value.payload.at(-1), "x");
  assert.equal(fixture.delivered(), limit);
  assert.equal(fixture.cancels(), 0);
  assert.equal(fixture.body.locked, false);
});

test("JSON overflow cancels before later bytes or EOF even with a misleading Content-Length", async () => {
  const initial = new Uint8Array(limit);
  for (const declared of [undefined, "1"]) {
    const fixture = chunked(
      [initial, new Uint8Array(1), new Uint8Array(1000)],
      {
        headers: {
          ...headers,
          ...(declared ? { "content-length": declared } : {}),
        },
      },
    );
    await assert.rejects(readManagementJsonBody(fixture.response));
    assert.equal(fixture.delivered(), limit + 1);
    assert.equal(fixture.reads(), 2);
    assert.equal(fixture.cancels(), 1);
    assert.equal(fixture.body.locked, false);
  }
});

test("JSON overflow does not await an underlying cancellation that never finishes", async () => {
  const fixture = chunked([new Uint8Array(limit + 1)], {
    cancel: () => new Promise<void>(() => {}),
  });
  let settled = false;
  const done = readManagementJsonBody(fixture.response).then(
    () => assert.fail("overflow must not parse"),
    () => {
      settled = true;
    },
  );
  await flush();
  assert.equal(settled, true);
  assert.equal(fixture.cancels(), 1);
  assert.equal(fixture.body.locked, false);
  await done;
});

test("a rejected underlying cancellation cannot replace the primary JSON budget failure", async () => {
  const privateFailure = new Error("private-cancel-connection-detail");
  const fixture = chunked([new Uint8Array(limit + 1)], {
    cancel: () => Promise.reject(privateFailure),
  });
  await assert.rejects(readManagementJsonBody(fixture.response), (error) => {
    assert.ok(error instanceof Error);
    assert.notEqual(error, privateFailure);
    assert.equal(error.message.includes("private-cancel"), false);
    return true;
  });
  assert.equal(fixture.cancels(), 1);
  assert.equal(fixture.body.locked, false);
  await flush();
});

test("JSON byte counting preserves split UTF-8, BOM and empty chunks", async () => {
  const text = '\uFEFF{"玩家":"😀","value":"€"}';
  const bytes = encoder.encode(text);
  assert.ok(bytes.byteLength > text.length);
  const fixture = chunked([
    new Uint8Array(0),
    bytes.subarray(0, 1),
    bytes.subarray(1, 8),
    new Uint8Array(0),
    bytes.subarray(8, 15),
    bytes.subarray(15),
  ]);
  assert.deepEqual(await readManagementJsonBody(fixture.response), {
    玩家: "😀",
    value: "€",
  });
  assert.equal(fixture.delivered(), bytes.byteLength);
  assert.equal(fixture.body.locked, false);
});

test("tiny source chunks do not create one retained Blob part per byte", async () => {
  const text = JSON.stringify({ value: "a".repeat(10_000) });
  let delivered = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (delivered === text.length) controller.close();
        else controller.enqueue(new Uint8Array([text.charCodeAt(delivered++)]));
      },
    },
    { highWaterMark: 0 },
  );
  const OriginalBlob = globalThis.Blob;
  const counts: number[] = [];
  globalThis.Blob = class extends OriginalBlob {
    constructor(parts: BlobPart[] = [], options?: BlobPropertyBag) {
      counts.push(parts.length);
      super(parts, options);
    }
  };
  let value: unknown;
  try {
    value = await readManagementJsonBody(new Response(body, { headers }));
  } finally {
    globalThis.Blob = OriginalBlob;
  }
  assert.deepEqual(value, { value: "a".repeat(10_000) });
  assert.ok(counts.length > 0);
  assert.ok(counts.every((count) => count <= Math.ceil(text.length / 65_536)));
  assert.equal(body.locked, false);
});

test("reused input buffers cannot alter bytes already accepted for JSON", async () => {
  const text = '{"value":"abcdefgh"}';
  const bytes = encoder.encode(text);
  const buffer = new Uint8Array(4);
  let offset = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (offset === bytes.byteLength) controller.close();
        else {
          const length = Math.min(buffer.byteLength, bytes.byteLength - offset);
          buffer.set(bytes.subarray(offset, offset + length));
          offset += length;
          controller.enqueue(buffer.subarray(0, length));
        }
      },
    },
    { highWaterMark: 0 },
  );
  assert.deepEqual(await readManagementJsonBody(new Response(body)), {
    value: "abcdefgh",
  });
  assert.equal(body.locked, false);
});

test("malformed JSON stays unconfirmed with its successful status and request reference", async () => {
  for (const bytes of [encoder.encode('{"saved":'), encoder.encode("<html>")]) {
    const fixture = chunked([bytes], { status: 201 });
    await assert.rejects(
      readManagementResponse(fixture.response),
      uncertain(201),
    );
    assert.equal(fixture.body.locked, false);
  }
});

test("an oversized successful receipt remains uncertain instead of a definite 413", async () => {
  const fixture = chunked([new Uint8Array(limit + 1)], { status: 201 });
  await assert.rejects(
    requestManagementJson(async () => fixture.response),
    uncertain(201),
  );
  assert.equal(fixture.cancels(), 1);
  assert.equal(fixture.body.locked, false);
});

test("oversized error bodies retain their status, reference and safe fallback semantics", async () => {
  const oversized = new Uint8Array(limit + 1);
  for (const [status, message, ambiguous] of [
    [401, "Your session has expired. Sign in again.", false],
    [403, "You do not have permission to perform this action.", false],
    [
      409,
      "Records changed. Refresh records, review them and try again.",
      false,
    ],
    [429, "The service is unavailable. Please try again.", false],
    [503, "The service is unavailable. Please try again.", true],
  ] as const) {
    const fixture = chunked([oversized], { status });
    await assert.rejects(readManagementResponse(fixture.response), (error) => {
      assert.ok(error instanceof ManagementResponseError);
      assert.equal(error.status, status);
      assert.equal(error.uncertain, ambiguous);
      assert.equal(error.requestId, reference);
      assert.equal(error.message, message);
      return true;
    });
    assert.equal(fixture.cancels(), 1);
    assert.equal(fixture.body.locked, false);
  }
});

test("a small structured API conflict retains its feedback and definite outcome", async () => {
  const fixture = chunked(
    [encoder.encode('{"error":"Review this player before retrying."}')],
    { status: 409 },
  );
  await assert.rejects(readManagementResponse(fixture.response), (error) => {
    assert.ok(error instanceof ManagementResponseError);
    assert.equal(error.status, 409);
    assert.equal(error.requestId, reference);
    assert.equal(error.uncertain, false);
    assert.equal(error.message, "Review this player before retrying.");
    return true;
  });
});

test("empty successful bodies remain unconfirmed and empty 304 errors keep their reference", async () => {
  for (const response of [
    new Response(null, { status: 204, headers }),
    chunked([]).response,
  ]) {
    await assert.rejects(
      readManagementResponse(response),
      uncertain(response.status),
    );
    assert.equal(response.body?.locked ?? false, false);
  }
  await assert.rejects(
    readManagementResponse(new Response(null, { status: 304, headers })),
    (error) => {
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

test("non-byte chunks fail safely, cancel the source and release its reader", async () => {
  let cancels = 0;
  const body = new ReadableStream(
    {
      pull(controller) {
        controller.enqueue("private-invalid-byte-source");
      },
      cancel() {
        cancels++;
      },
    },
    { highWaterMark: 0 },
  );
  await assert.rejects(
    readManagementResponse(new Response(body, { headers })),
    uncertain(),
  );
  assert.equal(cancels, 1);
  assert.equal(body.locked, false);
});

test("a pre-aborted JSON body sends no read and exposes only the original caller reason", async () => {
  const caller = new AbortController();
  const reason = new DOMException("View closed", "AbortError");
  caller.abort(reason);
  const fixture = chunked([encoder.encode('{"saved":true}')]);
  await assert.rejects(
    readManagementJsonBody(fixture.response, caller.signal),
    (error) => error === reason,
  );
  assert.equal(fixture.reads(), 0);
  assert.equal(fixture.body.locked, false);
  assert.equal(getEventListeners(caller.signal, "abort").length, 0);
});

test("caller cancellation settles a pending body without awaiting source cancellation", async () => {
  const caller = new AbortController();
  const reason = new DOMException("View closed", "AbortError");
  const fixture = pendingBody(true);
  const rejected = assert.rejects(
    readManagementJsonBody(fixture.response, caller.signal),
    (error) => error === reason,
  );
  await fixture.started;
  caller.abort(reason);
  try {
    await rejected;
    assert.equal(fixture.cancels(), 1);
    assert.equal(fixture.body.locked, false);
    assert.equal(getEventListeners(caller.signal, "abort").length, 0);
  } finally {
    fixture.release();
  }
});

test("body success and failure release owned abort listeners", async () => {
  for (const valid of [true, false]) {
    const caller = new AbortController();
    const fixture = chunked([encoder.encode(valid ? '{"saved":true}' : "{")]);
    if (valid)
      assert.deepEqual(
        await readManagementJsonBody(fixture.response, caller.signal),
        {
          saved: true,
        },
      );
    else
      await assert.rejects(
        readManagementJsonBody(fixture.response, caller.signal),
      );
    assert.equal(fixture.body.locked, false);
    assert.equal(getEventListeners(caller.signal, "abort").length, 0);
    const cancellations = fixture.cancels();
    caller.abort();
    assert.equal(fixture.cancels(), cancellations);
  }
});

test("the bounded parser retains native replacement behavior for malformed UTF-8", async () => {
  const fixture = chunked([
    encoder.encode('{"value":"'),
    new Uint8Array([255]),
    encoder.encode('"}'),
  ]);
  assert.deepEqual(await readManagementJsonBody(fixture.response), {
    value: "�",
  });
});

for (const scenario of ["busy", "walkthrough", "closing"] as const)
  test(`the complete ${scenario} prototype snapshot fits and deserializes through the bounded reader`, async (t) => {
    const sample = createPrototypeSample(
      "demo-city",
      "City Centre",
      scenario,
      new Date("2026-11-01T00:00:00.000Z"),
    );
    const account = sample.accounts.find((row) => row.personaId === "admin")!;
    const snapshot: Snapshot = {
      revision: 1,
      branch: {
        id: "demo-city",
        name: "City Centre",
        timezone: "Asia/Kuala_Lumpur",
        role: account.role,
      },
      user: {
        id: account.id,
        username: account.username,
        branchId: "demo-city",
        role: account.role,
      },
      store: sample.store,
    };
    const serialized = JSON.stringify(snapshot);
    const bytes = encoder.encode(serialized).byteLength;
    assert.ok(bytes < limit);
    const actual = await readManagementResponse(Response.json(snapshot));
    assert.deepEqual(actual, JSON.parse(serialized));
    assert.equal(snapshotReceipt(actual).branch.id, "demo-city");
    t.diagnostic(`${scenario}: ${bytes} UTF-8 JSON bytes`);
  });
