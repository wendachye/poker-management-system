import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import nextConfig from "../next.config";
import { closeDatabase, database } from "../src/server/database";
import { failure, json, verifyOrigin } from "../src/server/http";
import { DomainError } from "../src/domain/operations";

const production = {
  NODE_ENV: "production",
  APP_ORIGIN: "https://operations.example.com",
  DATABASE_URL:
    "postgresql://poker_app:testing-only-password@database.example.com/poker?sslmode=verify-full",
  NEXT_PUBLIC_POKER_PROTOTYPE: "0",
  POKER_PROTOTYPE_MODE: "0",
  NODE_TLS_REJECT_UNAUTHORIZED: "1",
  PGSSLMODE: "",
  PGOPTIONS: "",
} satisfies NodeJS.ProcessEnv;

function environment(
  overrides: Record<string, string | undefined>,
  work: () => void,
) {
  const before = process.env;
  process.env = { ...before, ...production, ...overrides };
  try {
    work();
  } finally {
    process.env = before;
  }
}

function write(origin = production.APP_ORIGIN) {
  return new Request("http://internal-proxy/api/state", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: "{}",
  });
}

test("production writes use the configured public origin, not proxy URL reconstruction", () => {
  environment({}, () => {
    assert.doesNotThrow(() => verifyOrigin(write()));
    assert.throws(
      () => verifyOrigin(write("http://internal-proxy")),
      (error) => error instanceof DomainError && error.status === 403,
    );
  });
});

test("production API origin checks fail closed on missing or unsafe configuration", () => {
  for (const APP_ORIGIN of ["", "http://operations.example.com"])
    environment({ APP_ORIGIN }, () => {
      assert.throws(() => verifyOrigin(write()), /APP_ORIGIN/);
    });
  environment({ DATABASE_URL: "" }, () => {
    assert.throws(() => verifyOrigin(write()), /DATABASE_URL/);
  });
});

test("production database validation runs before opening any connection", async () => {
  await closeDatabase();
  for (const overrides of [
    { APP_ORIGIN: "" },
    {
      DATABASE_URL: production.DATABASE_URL.replace("verify-full", "no-verify"),
    },
  ])
    environment(overrides, () => assert.throws(() => database()));
  environment({}, () => assert.equal(typeof database().query, "function"));
  await closeDatabase();
});

test("unexpected server failures have a correlation ID and never log raw SQL or secrets", async () => {
  const before = console.error;
  const logs: unknown[][] = [];
  let response: Response;
  try {
    console.error = (...values: unknown[]) => logs.push(values);
    response = failure(
      Object.assign(
        new Error("private_password private_player SELECT secret"),
        {
          code: "ECONNRESET",
          detail: "private_record",
        },
      ),
    );
  } finally {
    console.error = before;
  }
  assert.equal(response.status, 503);
  const requestId = response.headers.get("x-request-id");
  assert.match(requestId ?? "", /^[a-f0-9-]{36}$/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const event = JSON.parse(logs[0][0] as string);
  assert.deepEqual(event, {
    event: "request_failed",
    requestId,
    code: "ECONNRESET",
  });
  assert.doesNotMatch(JSON.stringify(logs), /private_|SELECT/);
  assert.doesNotMatch(JSON.stringify(await response.json()), /private_|SELECT/);
});

test("all API JSON responses include a distinct request reference", () => {
  const first = json({ ok: true });
  const second = json({ ok: true });
  assert.notEqual(
    first.headers.get("x-request-id"),
    second.headers.get("x-request-id"),
  );
});

test("unrecognized error codes cannot leak arbitrary exception data to logs", () => {
  const before = console.error;
  const logs: unknown[][] = [];
  try {
    console.error = (...values: unknown[]) => logs.push(values);
    failure({ code: "PRIVATE_PASSWORD_VALUE", detail: "private detail" });
  } finally {
    console.error = before;
  }
  assert.equal(JSON.parse(logs[0][0] as string).code, "SERVER_ERROR");
  assert.doesNotMatch(JSON.stringify(logs), /PRIVATE|private/);
});

test("global page and API headers prevent framing and restrict unused browser features", async () => {
  assert.equal(nextConfig.poweredByHeader, false);
  const rules = await nextConfig.headers!();
  const global = rules.find((rule) => rule.source === "/:path*");
  assert.ok(global);
  const values = new Map(
    global.headers.map((header) => [header.key, header.value]),
  );
  assert.equal(values.get("X-Frame-Options"), "DENY");
  assert.equal(values.get("X-Content-Type-Options"), "nosniff");
  assert.equal(values.get("Referrer-Policy"), "same-origin");
  assert.match(
    values.get("Content-Security-Policy") ?? "",
    /frame-ancestors 'none'/,
  );
  assert.match(values.get("Permissions-Policy") ?? "", /camera=\(\)/);
});

test("demo and operations Vercel profiles explicitly select separate modes", () => {
  const demo = JSON.parse(readFileSync("vercel.json", "utf8"));
  const operations = JSON.parse(readFileSync("vercel.operations.json", "utf8"));
  for (const key of ["NEXT_PUBLIC_POKER_PROTOTYPE", "POKER_PROTOTYPE_MODE"]) {
    assert.equal(demo.env[key], "1");
    assert.equal(demo.build.env[key], "1");
    assert.equal(operations.env[key], "0");
    assert.equal(operations.build.env[key], "0");
  }
  assert.match(operations.buildCommand, /production:check/);
});
