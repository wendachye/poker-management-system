import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReadQuery } from "../src/domain/read-model";
import {
  readSearchDelay,
  type ReadSearchRequest,
} from "../src/lib/read-search-delay";

const readIdentity = () => {};
const registerReadIdentity = () => {};
function request(
  query: Partial<ReadQuery> = {},
  freshness: Partial<Omit<ReadSearchRequest, "query">> = {},
): ReadSearchRequest {
  return {
    query: {
      resource: "players",
      query: "Al",
      status: "ACTIVE",
      page: 0,
      ...query,
    },
    branchId: "fictional-venue-a",
    revision: 3,
    attempt: 0,
    readGeneration: 0,
    enabled: true,
    readIdentity,
    registerReadIdentity,
    ...freshness,
  };
}

test("only changed nonempty raw search text receives a 200ms delay", () => {
  for (const [before, after, expected] of [
    ["Al", "Alex", 200],
    ["Alex", "Alex ", 200],
    ["José", "José Lin", 200],
    ["601", "+60 (12) 345-6789", 200],
    ["987", "987-654", 200],
    ["Alex", "Alex", 0],
    ["Alex", "", 0],
    ["Alex", "  \t\n", 0],
    ["Alex", undefined, 0],
    [undefined, "", 0],
    [undefined, "Alex", 200],
  ] as const)
    assert.equal(
      readSearchDelay(request({ query: before }), request({ query: after })),
      expected,
      `${String(before)} -> ${String(after)}`,
    );
});

test("initial and newly enabled reads are immediate even with prefilled search text", () => {
  const next = request({ query: "Alex" });
  assert.equal(readSearchDelay(null, next), 0);
  assert.equal(readSearchDelay(undefined, next), 0);
  assert.equal(readSearchDelay(request({}, { enabled: false }), next), 0);
  assert.equal(
    readSearchDelay(request(), request({ query: "Alex" }, { enabled: false })),
    0,
  );
  assert.equal(
    readSearchDelay(
      request({}, { enabled: false }),
      request({ query: "Alex" }, { enabled: false }),
    ),
    0,
  );
  assert.equal(
    readSearchDelay(
      request({}, { branchId: undefined }),
      request({ query: "Alex" }, { branchId: undefined }),
    ),
    0,
  );
});

test("venue, revision, retry, generation and read-capability changes bypass text delay", () => {
  for (const freshness of [
    { branchId: "fictional-venue-b" },
    { branchId: undefined },
    { revision: 4 },
    { revision: undefined },
    { attempt: 1 },
    { readGeneration: 1 },
    { readIdentity: () => {} },
    { registerReadIdentity: () => {} },
    { registerReadIdentity: undefined },
  ])
    assert.equal(
      readSearchDelay(request(), request({ query: "Alex" }, freshness)),
      0,
    );
});

test("all resource, filter and page-size changes are immediate when combined with typing", () => {
  for (const criteria of [
    { resource: "requests" },
    { status: "ALL" },
    { type: "CREDIT" },
    { tag: "VIP" },
    { dayId: "fictional-day" },
    { date: "2026-10-29" },
    { from: "2026-10-01" },
    { to: "2026-10-29" },
    { staff: "fictional-manager" },
    { action: "CHECK_IN" },
    { playerId: "fictional-player" },
    { id: "fictional-request" },
    { pageSize: 50 },
    { pageSize: 0 },
  ] satisfies Partial<ReadQuery>[])
    assert.equal(
      readSearchDelay(request(), request({ ...criteria, query: "Alex" })),
      0,
    );
});

test("page-only navigation is immediate while a text edit may reset its page to zero", () => {
  assert.equal(readSearchDelay(request(), request({ page: 1 })), 0);
  assert.equal(
    readSearchDelay(request(), request({ page: 1, query: "Alex" })),
    0,
  );
  assert.equal(
    readSearchDelay(request({ page: 3 }), request({ page: 0, query: "Alex" })),
    200,
  );
  assert.equal(
    readSearchDelay(
      request({ page: 3 }),
      request({ page: undefined, query: "Alex" }),
    ),
    200,
  );
  assert.equal(
    readSearchDelay(
      request({ page: undefined }),
      request({ page: 0, query: "Alex" }),
    ),
    200,
  );
  assert.equal(readSearchDelay(request({ page: 3 }), request({ page: 0 })), 0);
  assert.equal(
    readSearchDelay(request({ page: 3 }), request({ page: 2, query: "Alex" })),
    0,
  );
});

test("transport-equivalent defaults, empty filters and key order preserve a text-only delay", () => {
  assert.equal(
    readSearchDelay(
      request({ status: undefined, pageSize: undefined }),
      request({ status: "", pageSize: 20, query: "Alex" }),
    ),
    200,
  );
  assert.equal(
    readSearchDelay(
      request({ pageSize: 20 }),
      request({ pageSize: undefined, query: "Alex" }),
    ),
    200,
  );
  const previous = request({ dayId: undefined, type: "", query: "Al" });
  const next: ReadSearchRequest = {
    ...request(),
    query: {
      page: 0,
      status: "ACTIVE",
      type: undefined,
      query: "Alex",
      resource: "players",
      dayId: "",
    },
  };
  assert.equal(readSearchDelay(previous, next), 200);
  assert.equal(
    readSearchDelay(
      request({ dayId: "0" }),
      request({ dayId: undefined, query: "Alex" }),
    ),
    0,
  );
});

test("decision snapshots stay unmodified and callback capabilities are never invoked", () => {
  let calls = 0;
  const capability = () => {
    calls++;
  };
  const previous = Object.freeze({
    ...request({}, { readIdentity: capability }),
    query: Object.freeze({
      resource: "players" as const,
      query: "Al",
      status: "ACTIVE",
      page: 0,
    }),
  });
  const next = Object.freeze({
    ...request({}, { readIdentity: capability }),
    query: Object.freeze({
      status: "ACTIVE",
      query: "Alex",
      resource: "players" as const,
      page: 0,
    }),
  });
  const before = JSON.stringify([previous, next]);
  assert.equal(readSearchDelay(previous, next), 200);
  assert.equal(JSON.stringify([previous, next]), before);
  assert.equal(calls, 0);
});
