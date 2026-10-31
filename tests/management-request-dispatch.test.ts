import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";
import {
  ManagementResponseError,
  requestManagementJson,
} from "../src/lib/management-response";

const filename = "src/lib/management-request.ts";
const compiled = ts.transpileModule(readFileSync(filename, "utf8"), {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
  },
}).outputText;
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Actual compiled adapter with fictional import/fetch seams. This verifies
 * dispatch boundaries; it does not load the prototype runtime or contact HTTP.
 */
function adapter(prototype: boolean, holdImport = false) {
  const imports = Promise.withResolvers<unknown>();
  const network: { path: string; init?: RequestInit }[] = [];
  const samples: { path: string; init?: RequestInit }[] = [];
  let importCount = 0;
  const prototypeModule = {
    prototypeRequest: async (path: string, init?: RequestInit) => {
      samples.push({ path, init });
      return Response.json({ saved: true });
    },
  };
  const exports = {} as {
    managementRequest(path: string, init?: RequestInit): Promise<Response>;
    managementJson<T>(path: string, init?: RequestInit): Promise<T>;
  };
  vm.runInNewContext(
    compiled,
    {
      exports,
      require(path: string) {
        if (path === "@/prototype/config")
          return { prototypeEnabled: prototype };
        if (path === "./management-response") return { requestManagementJson };
        assert.equal(path, "@/prototype/runtime");
        importCount++;
        return holdImport ? imports.promise : prototypeModule;
      },
      fetch: async (path: string, init?: RequestInit) => {
        network.push({ path, init });
        return Response.json({ saved: true });
      },
    },
    { filename },
  );
  return {
    ...exports,
    network,
    samples,
    imports: () => importCount,
    releaseImport: () => imports.resolve(prototypeModule),
  };
}

for (const prototype of [false, true])
  test(`pre-aborted ${prototype ? "prototype" : "operations"} dispatch cannot enter its adapter`, async () => {
    const caller = new AbortController();
    const reason = new DOMException("View closed", "AbortError");
    caller.abort(reason);
    const app = adapter(prototype);
    await assert.rejects(
      app.managementRequest("/api/state", {
        method: "POST",
        signal: caller.signal,
        body: "fictional-command",
      }),
      (error: unknown) => error === reason,
    );
    assert.equal(app.network.length, 0);
    assert.equal(app.samples.length, 0);
    assert.equal(app.imports(), 0);
  });

test("cancelling a prototype import prevents its later sample dispatch", async () => {
  const caller = new AbortController();
  const reason = new DOMException("View closed", "AbortError");
  const app = adapter(true, true);
  const result = app.managementRequest("/api/state", {
    method: "POST",
    signal: caller.signal,
    body: "fictional-command",
  });
  const rejected = assert.rejects(result, (error: unknown) => error === reason);
  await flush();
  assert.equal(app.imports(), 1);
  caller.abort(reason);
  app.releaseImport();
  await rejected;
  assert.equal(app.samples.length, 0);
  assert.equal(app.network.length, 0);
});

test("an expired JSON deadline prevents delayed prototype-import side effects", async (t) => {
  let current = 100;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(performance, "now", () => current);
  t.after(() => {
    t.mock.restoreAll();
    t.mock.timers.reset();
  });
  const app = adapter(true, true);
  const pending = app.managementJson("/api/state", {
    method: "POST",
    body: "fictional-command",
  });
  let settled = false;
  const observed = pending
    .then(
      () => ({ accepted: true, error: undefined as unknown }),
      (error: unknown) => ({ accepted: false, error }),
    )
    .finally(() => {
      settled = true;
    });
  await flush();
  assert.equal(app.imports(), 1);
  current += 45_000;
  t.mock.timers.tick(45_000);
  await flush();
  try {
    assert.equal(settled, true);
  } finally {
    app.releaseImport();
    await flush();
  }
  const result = await observed;
  assert.equal(result.accepted, false);
  assert.ok(result.error instanceof ManagementResponseError);
  assert.equal(result.error.status, 408);
  assert.equal(result.error.uncertain, true);
  assert.equal(app.samples.length, 0);
  assert.equal(app.network.length, 0);
});

for (const prototype of [false, true])
  test(`active ${prototype ? "prototype" : "operations"} requests preserve dispatch options`, async () => {
    const caller = new AbortController();
    const app = adapter(prototype);
    const init: RequestInit = {
      method: "POST",
      cache: "no-store",
      signal: caller.signal,
      headers: { "Content-Type": "application/json" },
      body: '{"operationId":"fictional-operation"}',
    };
    const response = await app.managementRequest("/api/state", init);
    assert.deepEqual(await response.json(), { saved: true });
    const calls = prototype ? app.samples : app.network;
    assert.equal(calls.length, 1);
    assert.equal(calls[0].path, "/api/state");
    assert.equal(calls[0].init, init);
    assert.equal(prototype ? app.network.length : app.samples.length, 0);
  });

test("the actual JSON bridge forwards its combined signal and preserves the original init", async () => {
  const caller = new AbortController();
  const app = adapter(false);
  const init: RequestInit = {
    method: "POST",
    signal: caller.signal,
    body: '{"operationId":"fictional-operation"}',
  };
  const value = await app.managementJson("/api/state", init);
  assert.deepEqual(value, { saved: true });
  assert.equal(app.network.length, 1);
  const sent = app.network[0].init;
  assert.ok(sent?.signal instanceof AbortSignal);
  assert.notEqual(sent.signal, caller.signal);
  assert.equal(sent.signal.aborted, false);
  assert.equal(sent.method, init.method);
  assert.equal(sent.body, init.body);
  assert.equal(init.signal, caller.signal);
});
