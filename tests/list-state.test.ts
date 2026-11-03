import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeListState,
  encodeListState,
  isListDraftKey,
  listStateKey,
  readListLocation,
  sanitizeListDrafts,
  writeListLocation,
} from "../src/lib/list-state";

test("a bookmarked list retains explicit all-day filters and uses one-based URL pages", () => {
  const href = writeListLocation(
    "http://localhost:3001/en/transactions?keep=1#queue",
    "/transactions",
    "venue-a",
    {
      "tx.day": "",
      "tx.status": "APPROVED",
      "tx.page": "2",
      "tx.pageSize": "50",
    },
  );
  const url = new URL(href);
  assert.equal(url.searchParams.get("tx.page"), "3");
  assert.equal(url.searchParams.get("tx.day"), "");
  assert.equal(url.searchParams.get("keep"), "1");
  assert.equal(url.hash, "#queue");
  assert.deepEqual(readListLocation(url.search, "/transactions", "venue-a"), {
    present: true,
    foreignVenue: false,
    values: {
      "tx.day": "",
      "tx.status": "APPROVED",
      "tx.page": "2",
      "tx.pageSize": "50",
    },
  });
});

test("read preferences never persist financial, credential or record-edit drafts", () => {
  const input = {
    "player.search": "Alex",
    "player.name": "Changed name",
    "table.search": "Main",
    "table.id": "table-2",
    "table.name": "Changed table",
    "entry.amount": "500",
    "entry.operationId": "retry-identity",
    "staff.password": "must-not-be-stored",
    "staff.role": "CASHIER",
    "buyIn.amount": "500",
    "checkIn.phone": "0123456789",
  };
  assert.deepEqual(sanitizeListDrafts(input), {
    "player.search": "Alex",
    "table.search": "Main",
    "staff.role": "CASHIER",
  });
  for (const key of [
    "__proto__.name",
    "constructor.name",
    "toString.name",
    "player.search.extra",
    "player.search.",
    "player.search..amount",
    "entry.operationId",
  ])
    assert.equal(isListDraftKey(key), false);
  assert.deepEqual(
    decodeListState(
      JSON.stringify({ version: 1, values: input }),
      "/en/tables",
    ),
    { "table.search": "Main" },
  );
});

test("staff, role, venue and route have separate storage scopes", () => {
  const access = {
    id: "cashier-1",
    branchId: "venue-1",
    role: "CASHIER" as const,
  };
  const keys = [
    listStateKey(access, "/en/players"),
    listStateKey({ ...access, id: "cashier-2" }, "/en/players"),
    listStateKey({ ...access, branchId: "venue-2" }, "/en/players"),
    listStateKey({ ...access, role: "MANAGER" }, "/en/players"),
    listStateKey(access, "/en/transactions"),
  ];
  assert.equal(new Set(keys).size, 5);
  assert.equal(listStateKey(access, "/zh/players"), keys[0]);
  assert.equal(listStateKey(null, "/en/players"), null);
  assert.equal(listStateKey(access, "/en/settings/venue"), null);
});

test("cleared dates retain explicit blank overrides and unsupported routes read no criteria", () => {
  const values = {
    "report.selectedDate": "",
    "range.from": "",
    "range.to": "",
    "range.preset": "custom",
  };
  const raw = encodeListState(values, "/en/reports");
  assert.deepEqual(decodeListState(raw, "/zh/reports"), values);
  assert.deepEqual(decodeListState(raw, "/en/login"), {});
  assert.equal(
    Object.hasOwn(decodeListState(raw, "/en/reports"), "report.day"),
    false,
  );
  assert.deepEqual(
    decodeListState(encodeListState(values, "/en/login"), "/en/reports"),
    {},
  );
});

test("malformed, duplicate, oversized and foreign venue URL criteria fail closed", () => {
  for (const query of [
    "?listVenue=venue-b&player.search=Other",
    "?listVenue=venue-a&listVenue=venue-a&player.search=Other",
    "?player.search=" + "a".repeat(17000),
  ]) {
    const state = readListLocation(query, "/en/players", "venue-a");
    assert.equal(state.foreignVenue, true);
    assert.deepEqual(state.values, {});
  }
  assert.deepEqual(
    readListLocation(
      "?player.search=one&player.search=two&player.page=0&player.status=BAD&player.pageSize=1000&player.direction=sideways&__proto__.name=bad",
      "/en/players",
      "venue-a",
    ).values,
    {},
  );
  assert.deepEqual(
    readListLocation(
      "?audit.from=2025-02-29&audit.to=2024-02-29&audit.search=ok",
      "/en/admin/audit",
      "venue-a",
    ).values,
    { "audit.to": "2024-02-29", "audit.search": "ok" },
  );
});

test("sorts are validated for their current resource and default order survives", () => {
  assert.deepEqual(
    sanitizeListDrafts(
      { "tx.status": "APPROVED", "tx.sort": "amount", "tx.direction": "desc" },
      "/transactions",
    ),
    { "tx.status": "APPROVED", "tx.sort": "amount", "tx.direction": "desc" },
  );
  assert.deepEqual(
    sanitizeListDrafts(
      { "tx.status": "PENDING", "tx.sort": "time" },
      "/transactions",
    ),
    { "tx.status": "PENDING" },
  );
  assert.deepEqual(
    sanitizeListDrafts(
      { "player.sort": "", "player.pageSize": "20", "player.search": "" },
      "/players",
    ),
    { "player.sort": "", "player.pageSize": "20", "player.search": "" },
  );
  assert.deepEqual(
    sanitizeListDrafts({
      "tx.filter": "DROP TABLE",
      "report.mode": "",
      "range.preset": "",
    }),
    {},
  );
});

test("storage input is bounded and versioned while URL writes preserve unrelated state", () => {
  for (const raw of [
    null,
    "{",
    "null",
    "[]",
    '{"version":2,"values":{"player.search":"old"}}',
    "a".repeat(17000),
  ])
    assert.deepEqual(decodeListState(raw, "/players"), {});
  const url = new URL(
    writeListLocation(
      "http://localhost:3001/en/players?keep=yes&tx.search=old&player.password=secret&player.search=old#details",
      "/en/players",
      "venue-a",
      { "player.search": "new", "tx.day": "day-1" },
    ),
  );
  assert.equal(url.searchParams.get("player.search"), "new");
  assert.equal(url.searchParams.has("tx.search"), false);
  assert.equal(url.searchParams.has("tx.day"), false);
  assert.equal(url.searchParams.has("player.password"), false);
  assert.equal(url.searchParams.get("keep"), "yes");
  assert.equal(url.hash, "#details");
});
