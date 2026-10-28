import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { localOperationsEnvironment } from "../scripts/local-environment";

test("local operations uses the HTTP transport and database adapter despite inherited demo flags", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--conditions=react-server",
      "--import",
      "tsx",
      "--eval",
      `(async () => {
        let requested = '';
        globalThis.fetch = async (path) => {
          requested = String(path);
          return Response.json({ transport: 'http' });
        };
        const { managementRequest } = require('./src/lib/management-request.ts');
        const { prototypeEnabled } = require('./src/prototype/config.ts');
        const { database, closeDatabase } = require('./src/server/database.ts');
        const response = await managementRequest('/api/auth');
        const adapter = database();
        await closeDatabase();
        console.log(JSON.stringify({
          prototypeEnabled, requested, data: await response.json(),
          databaseAdapterAvailable: typeof adapter.transaction === 'function'
        }));
      })().catch(() => { process.exitCode = 1; });`,
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 20_000,
      env: localOperationsEnvironment({
        ...process.env,
        NEXT_PUBLIC_POKER_PROTOTYPE: "1",
        POKER_PROTOTYPE_MODE: "1",
        DATABASE_URL: "postgresql://test:test@127.0.0.1:1/poker_test",
        PGOPTIONS: "",
      }),
    },
  );
  assert.equal(result.status, 0, result.stderr || String(result.error ?? ""));
  assert.deepEqual(JSON.parse(result.stdout.trim()), {
    prototypeEnabled: false,
    requested: "/api/auth",
    data: { transport: "http" },
    databaseAdapterAvailable: true,
  });
});
