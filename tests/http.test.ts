import assert from "node:assert/strict";
import { test } from "node:test";
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
