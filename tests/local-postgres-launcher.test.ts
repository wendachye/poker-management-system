import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { EventEmitter } from "node:events";
import { parseArgs, promisify } from "node:util";
import vm from "node:vm";
import ts from "typescript";
import { databasePoolOptions } from "../src/server/database-options";
import {
  maintenancePoolOptions,
  nativeMaintenanceMessage,
} from "../scripts/local-postgres-maintenance";
import {
  assertNativeResource,
  assertNativeSecrets,
  nativeLocalIdentity,
  LOCAL_RUNTIME_LABEL,
  NATIVE_APP,
  NATIVE_BOOTSTRAP,
  NATIVE_DATABASE,
  type NativeLocalSecrets,
} from "../scripts/local-postgres-setup";

const filename = "scripts/local-postgres.ts";
const source = readFileSync(filename, "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
  },
  transformers: {
    before: [
      (context) => (tree) => {
        const final = tree.statements.at(-1);
        assert.ok(final && ts.isExpressionStatement(final));
        assert.ok(final.expression.getText(tree).startsWith("main().catch("));
        // Only expose the actual entry invocation's promise. Every launcher
        // function, decision, cleanup path and catch body executes unchanged.
        return context.factory.updateSourceFile(tree, [
          ...tree.statements.slice(0, -1),
          context.factory.createExpressionStatement(
            context.factory.createAssignment(
              context.factory.createPropertyAccessExpression(
                context.factory.createIdentifier("globalThis"),
                "launcherCompletion",
              ),
              final.expression,
            ),
          ),
        ]);
      },
    ],
  },
}).outputText;

type Scenario =
  | "success"
  | "bootstrap-query-failure"
  | "verification-query-failure"
  | "bootstrap-idle-failure"
  | "verification-idle-failure"
  | "backup-query-failure";

const backupFailureMessage = "Fictional backup lock wait was not completed.";

/** Mocked CLI execution, not Docker/PostgreSQL acceptance. Only the source file
 * is read. All launcher FS, socket, process, Docker and database seams below
 * have fictional implementations and cannot reach native records or services.
 */
async function launcher(scenario: Scenario) {
  const fixtureRoot = resolve("fictional-launcher-workspace");
  const identity = nativeLocalIdentity(fixtureRoot);
  const secrets: NativeLocalSecrets = {
    version: 1,
    workspace: identity.workspace,
    bootstrapPassword: "1".repeat(64),
    ownerPassword: "2".repeat(64),
    appPassword: "3".repeat(64),
  };
  const logs: string[] = [];
  const errors: string[] = [];
  const events: string[] = [];
  const spawns: unknown[][] = [];
  const pools: FakePool[] = [];
  let exitCode: number | undefined;
  const args =
    scenario === "success"
      ? ["--database-only"]
      : scenario === "backup-query-failure"
        ? ["--backup"]
        : [];
  args.push("--port", "3001");
  const privateError = (code: string) =>
    Object.assign(
      new Error(`private-driver-detail ${secrets.bootstrapPassword}`),
      { code },
    );

  class FakePool extends EventEmitter {
    readonly options: Record<string, unknown>;
    readonly index: number;
    ended = 0;
    constructor(options: Record<string, unknown>) {
      super();
      this.options = { ...options };
      this.index = pools.length;
      pools.push(this);
      events.push(`pool:${this.index}:created`);
    }
    async end() {
      this.ended++;
      events.push(`pool:${this.index}:end`);
      if (scenario === "bootstrap-idle-failure" && this.index === 0)
        this.emit("error", privateError("ECONNRESET"));
      if (scenario === "verification-idle-failure" && this.index === 1)
        this.emit("error", privateError("57P03"));
    }
  }

  const labels = (resource: "container" | "data") => ({
    "com.poker.local.runtime": LOCAL_RUNTIME_LABEL,
    "com.poker.local.workspace": identity.workspace,
    "com.poker.local.resource": resource,
  });
  const container = {
    Config: { Image: "postgres:18-alpine", Labels: labels("container") },
    HostConfig: {
      PortBindings: {
        "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "55440" }],
      },
    },
    Mounts: [
      {
        Destination: "/var/lib/postgresql",
        Type: "volume",
        Name: identity.volume,
      },
    ],
    State: { Running: true },
  };
  const execFile = Object.assign(
    () => assert.fail("Use promisified Docker seam"),
    {
      [promisify.custom]: async (command: string, parameters: string[]) => {
        assert.equal(command, "docker");
        events.push(`docker:${parameters.slice(0, 2).join(":")}`);
        if (parameters[0] === "info") return { stdout: "28.0.0", stderr: "" };
        if (parameters[0] === "volume" && parameters[1] === "inspect") {
          assert.equal(parameters[2], identity.volume);
          return {
            stdout: JSON.stringify([{ Labels: labels("data") }]),
            stderr: "",
          };
        }
        if (parameters[0] === "container" && parameters[1] === "inspect") {
          assert.equal(parameters[2], identity.container);
          return { stdout: JSON.stringify([container]), stderr: "" };
        }
        assert.deepEqual(
          [...parameters],
          [
            "exec",
            identity.container,
            "pg_isready",
            "-U",
            NATIVE_BOOTSTRAP,
            "-d",
            NATIVE_DATABASE,
          ],
        );
        return { stdout: "accepting fictional connections", stderr: "" };
      },
    },
  );
  const modules: Record<string, unknown> = {
    "node:crypto": {
      randomBytes: () => assert.fail("Existing configuration must be retained"),
    },
    "node:child_process": {
      execFile,
      spawn: (...parameters: unknown[]) => {
        spawns.push(parameters);
        return new EventEmitter();
      },
    },
    "node:util": {
      promisify,
      parseArgs: (options: Parameters<typeof parseArgs>[0]) =>
        parseArgs({ ...options, args }),
    },
    "node:net": {
      createServer() {
        const probe = new EventEmitter() as EventEmitter & {
          listen(port: number, host: string, callback: () => void): void;
          close(callback: (error?: Error) => void): void;
        };
        probe.listen = (port, host, callback) => {
          assert.equal(port, 3001);
          assert.equal(host, "127.0.0.1");
          events.push("port:checked");
          queueMicrotask(callback);
        };
        probe.close = (callback) => callback();
        return probe;
      },
    },
    "node:fs/promises": {
      mkdir: async () => {
        events.push("config:directory");
      },
      readFile: async (path: string) => {
        assert.equal(
          path,
          resolve(fixtureRoot, ".local/native-postgres/credentials.json"),
        );
        return JSON.stringify(secrets);
      },
      open: () => assert.fail("Existing configuration must not be overwritten"),
    },
    "node:path": { resolve },
    pg: { Pool: FakePool },
    "../src/server/database": { databaseFromPool: (pool: FakePool) => pool },
    "../src/server/database-options": { databasePoolOptions },
    "./local-environment": {
      localOperationsEnvironment: (env: unknown) => env,
    },
    "./local-postgres-backup": {
      backupNativeSamples: async (pool: FakePool) => {
        assert.equal(scenario, "backup-query-failure");
        assert.equal(pool, pools[0]);
        events.push("backup");
        throw Object.assign(new Error(backupFailureMessage), { code: "55P03" });
      },
    },
    "./local-postgres-maintenance": {
      maintenancePoolOptions,
      nativeMaintenanceMessage,
    },
    "./local-postgres-setup": {
      assertNativeResource,
      assertNativeSecrets,
      nativeLocalIdentity,
      LOCAL_RUNTIME_LABEL,
      LOCAL_SAMPLE_PASSWORD: "fictional-initial-password",
      NATIVE_APP,
      NATIVE_BOOTSTRAP,
      NATIVE_DATABASE,
      initializeNativeSamples: async (
        pool: FakePool,
        configuration: NativeLocalSecrets,
      ) => {
        assert.equal(pool, pools[0]);
        assert.deepEqual({ ...configuration }, secrets);
        events.push("initialize");
        if (scenario === "bootstrap-query-failure") throw privateError("55P03");
        return {
          created: false,
          users: [{ username: "fictional.admin", role: "ADMIN" }],
        };
      },
      verifyNativeSamples: async (pool: FakePool) => {
        assert.equal(pool, pools[1]);
        events.push("verify");
        if (scenario === "verification-query-failure")
          throw privateError("57014");
        return { counts: { profiles: 1, transactions: 2, approvals: 2 } };
      },
    },
  };
  const context = vm.createContext({
    exports: {},
    require: (name: string) => {
      assert.ok(Object.hasOwn(modules, name), `Unexpected dependency: ${name}`);
      return modules[name];
    },
    process: {
      cwd: () => fixtureRoot,
      env: {},
      argv: ["fictional-node", filename, ...args],
      platform: "linux",
      execPath: "fictional-node",
      on: () => {},
      get exitCode() {
        return exitCode;
      },
      set exitCode(value: number | undefined) {
        exitCode = value;
      },
    },
    console: {
      log: (value: unknown) => {
        logs.push(String(value));
        if (String(value).includes('"database-ready"'))
          events.push("database-ready");
      },
      error: (value: unknown) => errors.push(String(value)),
    },
    URL,
    Error,
    setTimeout: () => assert.fail("No readiness retry was expected"),
  });
  const previousOptions = process.env.PGOPTIONS;
  delete process.env.PGOPTIONS;
  try {
    vm.runInContext(compiled, context, { filename });
    await context.launcherCompletion;
    for (const pool of pools) {
      const connectionString = pool.options.connectionString as string;
      const options =
        scenario === "backup-query-failure"
          ? databasePoolOptions({
              DATABASE_URL: connectionString,
              DATABASE_POOL_MAX: "1",
            })
          : maintenancePoolOptions(connectionString);
      for (const [name, expected] of Object.entries(options))
        assert.equal(
          pool.options[name],
          expected,
          `Pool ${pool.index} budget ${name}`,
        );
      assert.equal(pool.ended, 1, `Pool ${pool.index} must close exactly once`);
    }
  } finally {
    if (previousOptions === undefined) delete process.env.PGOPTIONS;
    else process.env.PGOPTIONS = previousOptions;
  }
  assert.equal(spawns.length, 0, "No tested path may start Next.js");
  for (const value of [...logs, ...errors]) {
    assert.equal(value.includes("private-driver-detail"), false);
    for (const secret of [
      secrets.bootstrapPassword,
      secrets.ownerPassword,
      secrets.appPassword,
    ])
      assert.equal(value.includes(secret), false);
  }
  return { logs, errors, events, pools, exitCode };
}

test("actual launcher backup failure retains its routine budgets and original feedback", async () => {
  const result = await launcher("backup-query-failure");
  assert.equal(result.pools.length, 1);
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.errors, [backupFailureMessage]);
  assert.equal(result.pools[0].options.statement_timeout, 15000);
  assert.equal(result.pools[0].options.query_timeout, 20000);
  assert.equal(result.pools[0].options.options, undefined);
  assert.equal(result.events.includes("backup"), true);
  assert.equal(result.events.includes("initialize"), false);
  assert.equal(result.events.includes("verify"), false);
  assert.equal(result.events.includes("port:checked"), false);
  assert.equal(result.events.includes("database-ready"), false);
  assert.equal(
    new URL(result.pools[0].options.connectionString as string).username,
    NATIVE_APP,
  );
});

test("actual launcher database-only success closes both budgeted pools before readiness", async () => {
  const result = await launcher("success");
  assert.equal(result.pools.length, 2);
  assert.equal(result.exitCode, undefined);
  assert.deepEqual(result.errors, []);
  const ready = result.logs.filter((value) => value.startsWith("{"));
  assert.equal(ready.length, 1);
  assert.equal(JSON.parse(ready[0]).status, "database-ready");
  assert.equal(JSON.parse(ready[0]).sampleDataCreated, false);
  assert.equal(JSON.parse(ready[0]).passwordPreserved, true);
  assert.ok(
    result.events.indexOf("pool:0:end") < result.events.indexOf("verify"),
  );
  assert.ok(
    result.events.indexOf("pool:1:end") <
      result.events.indexOf("database-ready"),
  );
});

for (const [scenario, pools, message] of [
  ["bootstrap-query-failure", 1, /database lock within five seconds/],
  [
    "verification-query-failure",
    2,
    /cancelled or exceeded its statement budget/,
  ],
  ["bootstrap-idle-failure", 1, /maintenance connection failed/],
  ["verification-idle-failure", 2, /database connection/],
] as const) {
  test(`actual launcher ${scenario} closes pools without readiness or web startup`, async () => {
    const result = await launcher(scenario);
    assert.equal(result.pools.length, pools);
    assert.equal(result.exitCode, 1);
    assert.equal(
      result.logs.some((value) => value.includes('"database-ready"')),
      false,
    );
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], message);
    assert.ok(
      result.events.includes("port:checked"),
      "Failure path tested normal app startup",
    );
    if (pools === 1) assert.equal(result.events.includes("verify"), false);
  });
}
