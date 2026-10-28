import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ManagementResponseError,
  readManagementResponse,
  requestManagementJson,
} from "../src/lib/management-response";

const reference = "acdbd459-c1e4-4931-b7b2-2aec14135be7";

function failure(
  status: number,
  uncertain: boolean,
  message: string,
  requestId: string | null = null,
) {
  return (error: unknown) => {
    assert.ok(error instanceof ManagementResponseError);
    assert.equal(error.status, status);
    assert.equal(error.uncertain, uncertain);
    assert.equal(error.message, message);
    assert.equal(error.requestId, requestId);
    return true;
  };
}

function bodyWait(signal: AbortSignal, onRead: () => void) {
  return new Response(
    new ReadableStream<Uint8Array>(
      {
        start(controller) {
          signal.addEventListener(
            "abort",
            () => controller.error(signal.reason),
            { once: true },
          );
        },
        pull() {
          onRead();
        },
      },
      { highWaterMark: 0 },
    ),
    { headers: { "content-type": "application/json" } },
  );
}

test("structured validation and conflict failures preserve safe API messages and definite results", async () => {
  for (const status of [400, 409]) {
    await assert.rejects(
      readManagementResponse(
        Response.json(
          { error: "Review the player and try again." },
          { status, headers: { "x-request-id": reference } },
        ),
      ),
      failure(status, false, "Review the player and try again.", reference),
    );
  }
});

test("a non-JSON 401 still identifies an expired session", async () => {
  await assert.rejects(
    readManagementResponse(
      new Response("<html>Session middleware rejected this request</html>", {
        status: 401,
      }),
    ),
    failure(401, false, "Your session has expired. Sign in again."),
  );
});

test("proxy error pages expose a safe ambiguous result instead of HTML or parser errors", async () => {
  await assert.rejects(
    readManagementResponse(
      new Response("<html>postgres://private:secret@db SQL SELECT *</html>", {
        status: 502,
      }),
    ),
    failure(502, true, "The service is unavailable. Please try again."),
  );
});

test("truncated successful receipts remain unconfirmed so callers retain their operation ID", async () => {
  for (const content of [
    '{"revision":2,"store":',
    "<html>proxy response</html>",
  ]) {
    await assert.rejects(
      readManagementResponse(
        new Response(content, { headers: { "x-request-id": reference } }),
      ),
      failure(
        200,
        true,
        "The server response could not be confirmed. Refresh records and retry the last request.",
        reference,
      ),
    );
  }
});

test("empty, primitive and array success payloads cannot confirm a management save", async () => {
  for (const payload of [null, false, 7, "ok", []]) {
    await assert.rejects(
      readManagementResponse(Response.json(payload)),
      failure(
        200,
        true,
        "The server response could not be confirmed. Refresh records and retry the last request.",
      ),
    );
  }
});

test("invalid error fields fall back without rendering arbitrary response data", async () => {
  for (const error of [null, {}, [], "", "   ", "x".repeat(1001)]) {
    await assert.rejects(
      readManagementResponse(Response.json({ error }, { status: 403 })),
      failure(403, false, "You do not have permission to perform this action."),
    );
  }
});

test("only correctly grouped UUID request references are exposed", async () => {
  for (const invalid of [
    "-".repeat(36),
    "a".repeat(36),
    "private log reference",
    `${reference}0`,
  ]) {
    await assert.rejects(
      readManagementResponse(
        Response.json(
          { error: "Review the request." },
          { status: 400, headers: { "x-request-id": invalid } },
        ),
      ),
      failure(400, false, "Review the request."),
    );
  }
  await assert.rejects(
    readManagementResponse(
      Response.json(
        { error: "Review the request." },
        { status: 400, headers: { "x-request-id": reference.toUpperCase() } },
      ),
    ),
    failure(400, false, "Review the request.", reference.toUpperCase()),
  );
});

test("successful management responses preserve typed data", async () => {
  const expected = { revision: 2, branch: { id: "test-venue" } };
  const result = await requestManagementJson<typeof expected>(async () =>
    Response.json(expected),
  );
  assert.equal(result.revision, 2);
  assert.deepEqual(result, expected);
});

test("unexpected transport exceptions never expose raw SQL, connection strings or HTML", async () => {
  await assert.rejects(
    requestManagementJson(async () => {
      throw new Error(
        "<html>SELECT password_hash FROM users; postgres://private:secret@db</html>",
      );
    }),
    failure(
      0,
      true,
      "Cannot connect to the service. Check your connection and try again.",
    ),
  );
});

test("existing structured failures keep their status, reference and retry semantics through the request wrapper", async () => {
  await assert.rejects(
    requestManagementJson(async () =>
      Response.json(
        { error: "Another staff member changed this visit." },
        { status: 409, headers: { "x-request-id": reference } },
      ),
    ),
    failure(409, false, "Another staff member changed this visit.", reference),
  );
});

test("the deadline aborts a pending connection and reports an unconfirmed result", async () => {
  let aborted = false;
  await assert.rejects(
    requestManagementJson(
      (signal) =>
        new Promise<Response>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(signal.reason);
            },
            { once: true },
          );
        }),
      undefined,
      10,
    ),
    failure(
      408,
      true,
      "The request timed out. Retry the last request to confirm its result.",
    ),
  );
  assert.equal(aborted, true);
});

test("the deadline also aborts a response body after headers have arrived", async () => {
  let reading = false;
  let combined: AbortSignal | undefined;
  await assert.rejects(
    requestManagementJson(
      async (signal) => {
        combined = signal;
        return bodyWait(signal, () => {
          reading = true;
        });
      },
      undefined,
      10,
    ),
    failure(
      408,
      true,
      "The request timed out. Retry the last request to confirm its result.",
    ),
  );
  assert.equal(reading, true);
  assert.equal(combined?.aborted, true);
});

test("a caller abort while connecting preserves its original cancellation reason", async () => {
  const parent = new AbortController();
  const reason = new DOMException("View closed", "AbortError");
  const pending = requestManagementJson(
    (signal) =>
      new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      }),
    parent.signal,
    1000,
  );
  parent.abort(reason);
  await assert.rejects(pending, (error: unknown) => error === reason);
});

test("a caller abort while consuming the response body preserves its original reason", async () => {
  const parent = new AbortController();
  const reason = new DOMException("View closed", "AbortError");
  const started = Promise.withResolvers<void>();
  const pending = requestManagementJson(
    async (signal) => bodyWait(signal, () => started.resolve()),
    parent.signal,
    1000,
  );
  await started.promise;
  parent.abort(reason);
  await assert.rejects(pending, (error: unknown) => error === reason);
});
