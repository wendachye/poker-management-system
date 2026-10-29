import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import type { Snapshot } from "../src/domain/model";
import type { ReadQuery } from "../src/domain/read-model";

const filename =
  "src/components/page/PokerManagementPage/components/use-read-page.tsx";
const tree = ts.createSourceFile(
  filename,
  readFileSync(filename, "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
// Execute the actual exported function bodies; tests do not reimplement either
// the download helper or the hook's ownership/cancellation decisions.
function actual(name: string, dependencies: Record<string, unknown>) {
  const declaration = tree.statements.find(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === name,
  );
  assert.ok(declaration?.body);
  const printer = ts.createPrinter();
  const params = declaration.parameters
    .map((p) => printer.printNode(ts.EmitHint.Unspecified, p, tree))
    .join(",");
  const asynchronous = declaration.modifiers?.some(
    (modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword,
  );
  const source = `${asynchronous ? "async " : ""}function ${name}(${params}) ${printer.printNode(ts.EmitHint.Unspecified, declaration.body, tree)}`;
  const javascript = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  }).outputText;
  return new Function(
    ...Object.keys(dependencies),
    `${javascript}; return ${name};`,
  )(...Object.values(dependencies));
}
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const context: Pick<Snapshot, "user" | "branch"> = {
  user: {
    id: "fictional-admin",
    username: "fictional.admin",
    role: "ADMIN",
    branchId: "fictional-venue",
  },
  branch: {
    id: "fictional-venue",
    name: "Fictional venue",
    timezone: "Asia/Kuala_Lumpur",
    role: "ADMIN",
  },
};
type Download = (
  query: ReadQuery,
  filename: string,
  context: Pick<Snapshot, "user" | "branch">,
  signal?: AbortSignal,
) => Promise<void>;
type Output = { busy: boolean; download: Download };
type Slot = {
  value?: unknown;
  effect?: () => void | (() => void);
  cleanup?: () => void;
  deps?: unknown[];
};
function harness() {
  const slots: Slot[] = [];
  const effects: Array<() => void> = [];
  const requests: Array<{
    query: ReadQuery;
    filename: string;
    context: Pick<Snapshot, "user" | "branch">;
    signal?: AbortSignal;
    receipt: ReturnType<typeof deferred<void>>;
  }> = [];
  let cursor = 0;
  let mounted = true;
  let dirty = false;
  let output!: Output;
  const downloadReadCsv: Download = (query, filename, snapshot, signal) => {
    const receipt = deferred();
    requests.push({ query, filename, context: snapshot, signal, receipt });
    return receipt.promise;
  };
  const hook = actual("useReadCsvDownload", {
    downloadReadCsv,
    AbortController,
    useRef(initial: unknown) {
      const at = cursor++;
      if (!slots[at]) slots[at] = { value: { current: initial } };
      return slots[at].value;
    },
    useState(initial: unknown) {
      const at = cursor++;
      if (!slots[at]) slots[at] = { value: initial };
      return [
        slots[at].value,
        (next: unknown) => {
          assert.ok(mounted, "Disposed downloads must not update React state.");
          if (!Object.is(slots[at].value, next)) {
            slots[at].value = next;
            dirty = true;
          }
        },
      ];
    },
    useCallback(callback: unknown) {
      const at = cursor++;
      if (!slots[at]) slots[at] = { value: callback };
      return slots[at].value;
    },
    useEffect(effect: () => void | (() => void), deps: unknown[]) {
      const at = cursor++;
      if (slots[at]) return;
      const slot: Slot = { effect, deps };
      slots[at] = slot;
      effects.push(() => {
        const cleanup = effect();
        if (cleanup) slot.cleanup = cleanup;
      });
    },
  }) as () => Output;
  function render() {
    cursor = 0;
    dirty = false;
    output = hook();
    while (effects.length) effects.shift()!();
    return output;
  }
  async function flush() {
    for (let i = 0; i < 12; i++) {
      await Promise.resolve();
      if (mounted && dirty) render();
    }
  }
  function unmount() {
    mounted = false;
    for (const slot of slots) slot.cleanup?.();
  }
  function reconnectEffects() {
    for (const slot of slots) slot.cleanup?.();
    for (const slot of slots) {
      const cleanup = slot.effect?.();
      slot.cleanup = typeof cleanup === "function" ? cleanup : undefined;
    }
  }
  render();
  return {
    requests,
    render,
    flush,
    unmount,
    reconnectEffects,
    get output() {
      return output;
    },
  };
}

test("download ownership blocks duplicate clicks and captures the reviewed query and access", async () => {
  const h = harness();
  await h.flush();
  const query: ReadQuery = { resource: "report", dayId: "reviewed-day" };
  const snapshot = structuredClone(context);
  const first = h.output.download(query, "reviewed.csv", snapshot);
  await h.flush();
  assert.equal(h.output.busy, true);
  await h.output.download(query, "duplicate.csv", snapshot);
  query.dayId = "later-day";
  snapshot.user.id = "later-staff";
  h.render();
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].query.dayId, "reviewed-day");
  assert.equal(h.requests[0].context.user.id, "fictional-admin");
  assert.equal(h.requests[0].signal?.aborted, false);
  h.requests[0].receipt.resolve();
  await first;
  await h.flush();
  assert.equal(h.output.busy, false);
  h.unmount();
});

test("unmount aborts an export and a late successful completion performs no state update", async () => {
  const h = harness();
  await h.flush();
  const result = h.output.download(
    { resource: "report" },
    "daily.csv",
    context,
  );
  await h.flush();
  assert.ok(h.requests[0].signal instanceof AbortSignal);
  h.unmount();
  assert.equal(h.requests[0].signal.aborted, true);
  await h.output.download(
    { resource: "report" },
    "stale-callback.csv",
    context,
  );
  assert.equal(h.requests.length, 1);
  h.requests[0].receipt.resolve();
  await result;
});

test("a late failed export after unmount resolves silently instead of reaching the shared error handler", async () => {
  const h = harness();
  await h.flush();
  const result = h.output.download(
    { resource: "range" },
    "period.csv",
    context,
  );
  await h.flush();
  h.unmount();
  h.requests[0].receipt.reject(new Error("obsolete report failure"));
  await result;
});

test("mounted export errors still reject and release the duplicate-click lock for an explicit retry", async () => {
  const h = harness();
  await h.flush();
  const result = h.output.download(
    { resource: "report" },
    "daily.csv",
    context,
  );
  h.requests[0].receipt.reject(new Error("Current report error"));
  await assert.rejects(result, { message: "Current report error" });
  await h.flush();
  assert.equal(h.output.busy, false);
  const retry = h.output.download({ resource: "report" }, "retry.csv", context);
  assert.equal(h.requests.length, 2);
  h.requests[1].receipt.resolve();
  await retry;
  h.unmount();
});

test("Strict Mode cleanup and reconnect permit a new export while the old completion cannot clear its busy state", async () => {
  const h = harness();
  await h.flush();
  const old = h.output.download({ resource: "report" }, "old.csv", context);
  await h.flush();
  h.reconnectEffects();
  await h.flush();
  assert.equal(h.requests[0].signal?.aborted, true);
  assert.equal(h.output.busy, false);
  const current = h.output.download({ resource: "report" }, "new.csv", context);
  await h.flush();
  assert.equal(h.requests.length, 2);
  h.requests[0].receipt.reject(new Error("old ignored cancellation"));
  await old;
  await h.flush();
  assert.equal(h.output.busy, true);
  assert.equal(h.requests[1].signal?.aborted, false);
  h.requests[1].receipt.resolve();
  await current;
  await h.flush();
  assert.equal(h.output.busy, false);
  h.unmount();
});

function browserDownload() {
  const report = deferred<Blob>();
  const urls: Blob[] = [];
  const revoked: string[] = [];
  const timers: Array<() => void> = [];
  const links: Array<{ href: string; download: string }> = [];
  const readerSignals: Array<AbortSignal | undefined> = [];
  let clicks = 0;
  let abortDuringCreate: (() => void) | undefined;
  const helper = actual("downloadReadCsv", {
    readReportCsv: (
      _query: unknown,
      _context: unknown,
      _request: unknown,
      signal?: AbortSignal,
    ) => {
      readerSignals.push(signal);
      return report.promise;
    },
    managementRequest: () => assert.fail("Injected reader owns transport"),
    DOMException,
    URL: {
      createObjectURL(value: Blob) {
        urls.push(value);
        abortDuringCreate?.();
        return "blob:fictional-report";
      },
      revokeObjectURL(value: string) {
        revoked.push(value);
      },
    },
    document: {
      createElement(tag: string) {
        assert.equal(tag, "a");
        const link = { href: "", download: "", click: () => clicks++ };
        links.push(link);
        return link;
      },
    },
    setTimeout(callback: () => void, milliseconds: number) {
      assert.equal(milliseconds, 1000);
      timers.push(callback);
    },
  }) as Download;
  return {
    helper,
    report,
    urls,
    revoked,
    timers,
    links,
    readerSignals,
    get clicks() {
      return clicks;
    },
    abortOnCreate(callback: () => void) {
      abortDuringCreate = callback;
    },
  };
}
function cancelled(error: unknown) {
  assert.ok(error instanceof DOMException);
  assert.equal(error.name, "AbortError");
  assert.equal(error.message, "Report download cancelled.");
  return true;
}

test("a late blob after cancellation never creates a browser URL or clicks a download", async () => {
  const browser = browserDownload();
  const caller = new AbortController();
  const result = browser.helper(
    { resource: "report" },
    "daily.csv",
    context,
    caller.signal,
  );
  assert.equal(browser.readerSignals[0], caller.signal);
  caller.abort(new Error("private-cancellation-reason"));
  browser.report.resolve(new Blob(["late report"]));
  await assert.rejects(result, cancelled);
  assert.equal(browser.urls.length, 0);
  assert.equal(browser.clicks, 0);
});

test("an export cancelled after URL creation never clicks and still revokes its object URL", async () => {
  const browser = browserDownload();
  const caller = new AbortController();
  browser.abortOnCreate(() => caller.abort());
  const result = browser.helper(
    { resource: "report" },
    "daily.csv",
    context,
    caller.signal,
  );
  browser.report.resolve(new Blob(["report"]));
  await assert.rejects(result, cancelled);
  assert.equal(browser.clicks, 0);
  assert.equal(browser.timers.length, 1);
  browser.timers[0]();
  assert.deepEqual(browser.revoked, ["blob:fictional-report"]);
});

test("a mounted successful download uses its reviewed filename and balances its object URL", async () => {
  const browser = browserDownload();
  const result = browser.helper(
    { resource: "report" },
    "reviewed-daily.csv",
    context,
  );
  browser.report.resolve(new Blob(["report"]));
  await result;
  assert.equal(browser.urls.length, 1);
  assert.equal(browser.clicks, 1);
  assert.equal(browser.links[0].download, "reviewed-daily.csv");
  browser.timers[0]();
  assert.deepEqual(browser.revoked, ["blob:fictional-report"]);
});
