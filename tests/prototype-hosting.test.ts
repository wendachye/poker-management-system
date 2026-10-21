import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

function run(script: string, changes: Record<string, string> = {}) {
  return spawnSync(
    process.execPath,
    ["--conditions=react-server", "--import", "tsx", "--eval", script],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 20_000,
      env: {
        ...process.env,
        NODE_ENV: "production",
        NEXT_PUBLIC_POKER_PROTOTYPE: "",
        POKER_PROTOTYPE_MODE: "",
        DATABASE_URL: "",
        APP_ORIGIN: "",
        ...changes,
      },
    },
  );
}

function output<T>(script: string, changes: Record<string, string> = {}): T {
  const result = run(script, changes);
  assert.equal(result.status, 0, result.stderr || String(result.error || ""));
  return JSON.parse(result.stdout.trim()) as T;
}

const markers = [
  {
    name: "public-only",
    NEXT_PUBLIC_POKER_PROTOTYPE: "1",
    POKER_PROTOTYPE_MODE: "",
  },
  {
    name: "server-only",
    NEXT_PUBLIC_POKER_PROTOTYPE: "",
    POKER_PROTOTYPE_MODE: "1",
  },
  {
    name: "paired",
    NEXT_PUBLIC_POKER_PROTOTYPE: "1",
    POKER_PROTOTYPE_MODE: "1",
  },
];

test("the explicitly selected prototype can open in a production browser build", () => {
  const enabled = output<boolean>(
    'console.log(JSON.stringify(require("./src/prototype/config.ts").prototypeEnabled))',
    { NEXT_PUBLIC_POKER_PROTOTYPE: "1", POKER_PROTOTYPE_MODE: "1" },
  );
  assert.equal(enabled, true);
});

test("ordinary production and development builds do not select demo authentication", () => {
  for (const NODE_ENV of ["production", "development"]) {
    for (const POKER_PROTOTYPE_MODE of ["", "1"]) {
      const enabled = output<boolean>(
        'console.log(JSON.stringify(require("./src/prototype/config.ts").prototypeEnabled))',
        { NODE_ENV, POKER_PROTOTYPE_MODE },
      );
      assert.equal(
        enabled,
        false,
        `${NODE_ENV}, server marker ${POKER_PROTOTYPE_MODE}`,
      );
    }
  }
});

test("the local explicit prototype remains available", () => {
  assert.equal(
    output<boolean>(
      'console.log(JSON.stringify(require("./src/prototype/config.ts").prototypeEnabled))',
      {
        NODE_ENV: "development",
        NEXT_PUBLIC_POKER_PROTOTYPE: "1",
        POKER_PROTOTYPE_MODE: "1",
      },
    ),
    true,
  );
});

test("production builds reject mismatched client and server demo settings", () => {
  for (const marker of markers.slice(0, 2)) {
    const result = run('require("./next.config.ts")', marker);
    assert.notEqual(result.status, 0, `${marker.name} must fail the build`);
    assert.match(result.stderr, /prototype.*together/i);
  }
});

test("ordinary and paired-demo production configurations remain buildable", () => {
  for (const changes of [{}, markers[2]]) {
    const result = run('require("./next.config.ts")', changes);
    assert.equal(result.status, 0, result.stderr || String(result.error || ""));
  }
});

for (const marker of markers) {
  test(`${marker.name} demo rejects database access even if a connection is configured`, () => {
    const result = output<{ blocked: boolean; message?: string }>(
      `(async () => {
        const { database, closeDatabase } = require("./src/server/database.ts");
        let blocked = false;
        let message;
        try { database(); } catch (error) { blocked = true; message = error.message; }
        await closeDatabase();
        console.log(JSON.stringify({ blocked, message }));
      })().catch(error => { console.error(error); process.exitCode = 1; });`,
      {
        ...marker,
        DATABASE_URL: "postgresql://prototype-test.invalid/prototype",
      },
    );
    assert.equal(result.blocked, true);
    assert.match(result.message || "", /disabled.*prototype/i);
  });
}

test("ordinary database configuration is not disabled by demo protection", () => {
  const result = output<{ configured: boolean }>(
    `(async () => {
      const { database, closeDatabase } = require("./src/server/database.ts");
      const db = database();
      await closeDatabase();
      console.log(JSON.stringify({ configured: typeof db.query === "function" }));
    })().catch(error => { console.error(error); process.exitCode = 1; });`,
    { DATABASE_URL: "postgresql://prototype-test.invalid/prototype" },
  );
  assert.equal(result.configured, true);
});

type ApiResult = {
  route: string;
  method: string;
  status: number;
  bodyRead: boolean;
  error: string;
  cacheControl: string | null;
};

for (const marker of markers) {
  test(`${marker.name} demo disables actual staff API handlers before reading requests`, async (t) => {
    const responses = output<ApiResult[]>(
      `(async () => {
        const routes = {
          auth: ["GET", "POST", "DELETE"],
          state: ["GET", "POST"],
          branch: ["POST"],
          staff: ["GET", "POST"],
          locations: ["GET", "POST"],
        };
        const results = [];
        console.error = () => {};
        for (const [route, methods] of Object.entries(routes)) {
          const handlers = require("./src/app/api/" + route + "/route.ts");
          for (const method of methods) {
            let bodyRead = false;
            const request = new Request("https://prototype.test/api/" + route, {
              method,
              headers: { origin: "https://prototype.test", "content-type": "application/json" },
            });
            request.text = async () => { bodyRead = true; throw new Error("request body must not be read"); };
            const response = await handlers[method](request);
            const payload = await response.json();
            results.push({ route, method, status: response.status, bodyRead,
              error: payload.error, cacheControl: response.headers.get("cache-control") });
          }
        }
        const { closeDatabase } = require("./src/server/database.ts");
        await closeDatabase();
        console.log(JSON.stringify(results));
      })().catch(error => { console.error(error); process.exitCode = 1; });`,
      marker,
    );
    assert.equal(responses.length, 10);
    for (const result of responses) {
      await t.test(`${result.method} /api/${result.route}`, () => {
        assert.equal(result.status, 404);
        assert.equal(result.bodyRead, false);
        assert.equal(
          result.error,
          "Staff APIs are disabled in the sample-data prototype.",
        );
        assert.equal(result.cacheControl, "no-store");
      });
    }
  });
}
