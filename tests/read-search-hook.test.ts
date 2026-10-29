import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import type { ReadPage, ReadQuery } from "../src/domain/read-model";
import { readSearchDelay } from "../src/lib/read-search-delay";

// Run the real hook/effect against observable React slots and a fake clock.
// Browser rendering and the native PostgreSQL signal bridge have separate QA.
const filename =
  "src/components/page/PokerManagementPage/components/use-read-page.tsx";
const tree = ts.createSourceFile(
  filename,
  readFileSync(filename, "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const hook = tree.statements.find(
  (node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === "useReadPage",
);
assert.ok(hook?.body);
const javascript = ts.transpileModule(
  `function actualHook(query, enabled = true) ${ts
    .createPrinter()
    .printNode(ts.EmitHint.Unspecified, hook.body, tree)}`,
  {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  },
).outputText;

type Page = ReadPage<{ id: string }>;
type Result = {
  live: boolean;
  data: Page | null;
  error: string;
  loading: boolean;
  retry: () => void;
};
function page(id: string): Page {
  // The provided read capability owns receipt validation; this hook only binds
  // its returned page to the current raw query and request lifetime.
  return { items: [{ id }] } as Page;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
class Clock {
  now = 0;
  private next = 0;
  readonly pending = new Map<number, { at: number; run: () => void }>();
  schedule = (run: () => void, delay: number) => {
    const id = ++this.next;
    this.pending.set(id, { at: this.now + delay, run });
    return id;
  };
  cancel = (id: number) => {
    this.pending.delete(id);
  };
  tick(milliseconds: number) {
    const target = this.now + milliseconds;
    for (;;) {
      const next = [...this.pending.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      this.now = next[1].at;
      this.pending.delete(next[0]);
      next[1].run();
    }
    this.now = target;
  }
}
type Slot = {
  value?: unknown;
  deps?: unknown[];
  cleanup?: () => void;
};
type AccessSnapshot = {
  branch: { id: string | undefined };
  user: { id: string | undefined; role: string | undefined };
  revision: number;
};
function harness(prototype = false) {
  const clock = new Clock();
  const requests: Array<{
    query: ReadQuery;
    signal: AbortSignal;
    at: number;
    receipt: ReturnType<typeof deferred<Page>>;
  }> = [];
  const registrations = new Map<symbol, ReadQuery>();
  const registeredAt: number[] = [];
  const slots: Slot[] = [];
  let cursor = 0;
  let dirty = false;
  let mounted = true;
  let current: ReadQuery = { resource: "players", query: "", page: 0 };
  let enabled = true;
  let output!: Result;
  const read = (query: ReadQuery, signal: AbortSignal) => {
    const receipt = deferred<Page>();
    requests.push({ query: { ...query }, signal, receipt, at: clock.now });
    return receipt.promise;
  };
  const registerRead = (query: ReadQuery) => {
    const token = Symbol();
    registrations.set(token, { ...query });
    registeredAt.push(clock.now);
    return () => {
      registrations.delete(token);
    };
  };
  const context: {
    read: typeof read;
    registerRead: typeof registerRead;
    readGeneration: number;
    snapshot: AccessSnapshot | null;
  } = {
    read,
    registerRead,
    readGeneration: 0,
    snapshot: {
      branch: { id: "fictional-venue" },
      user: { id: "fictional-staff", role: "ADMIN" },
      revision: 1,
    },
  };
  const effects: Array<() => void> = [];
  const dependencies = {
    usePokerManagementContext: () => context,
    prototypeEnabled: prototype,
    readSearchDelay,
    AbortController,
    DOMException,
    setTimeout: clock.schedule,
    clearTimeout: clock.cancel,
    useMemo: (create: () => unknown, deps: unknown[]) => {
      const index = cursor++;
      const previous = slots[index];
      if (
        !previous ||
        deps.some((value, at) => !Object.is(value, previous.deps?.[at]))
      )
        slots[index] = { value: create(), deps };
      return slots[index].value;
    },
    useState: (initial: unknown) => {
      const index = cursor++;
      if (!slots[index]) slots[index] = { value: initial };
      return [
        slots[index].value,
        (value: unknown) => {
          assert.ok(mounted, "A disposed hook must not update state");
          const next =
            typeof value === "function" ? value(slots[index].value) : value;
          if (!Object.is(next, slots[index].value)) {
            slots[index].value = next;
            dirty = true;
          }
        },
      ];
    },
    useRef: (initial: unknown) => {
      const index = cursor++;
      if (!slots[index]) slots[index] = { value: { current: initial } };
      return slots[index].value;
    },
    useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
      const index = cursor++;
      const old = slots[index];
      if (
        !old ||
        deps.length !== old.deps?.length ||
        deps.some((value, at) => !Object.is(value, old.deps?.[at]))
      ) {
        const next: Slot = { deps };
        slots[index] = next;
        effects.push(() => {
          old?.cleanup?.();
          const cleanup = effect();
          if (cleanup) next.cleanup = cleanup;
        });
      }
    },
  };
  const actualHook = new Function(
    ...Object.keys(dependencies),
    `${javascript}; return actualHook;`,
  )(...Object.values(dependencies)) as (
    query: ReadQuery,
    enabled: boolean,
  ) => Result;
  function render(query = current, nextEnabled = enabled) {
    assert.ok(mounted);
    current = query;
    enabled = nextEnabled;
    cursor = 0;
    dirty = false;
    output = actualHook(current, enabled);
    while (effects.length) effects.shift()!();
    return output;
  }
  async function flush() {
    for (let turn = 0; turn < 16; turn++) {
      await Promise.resolve();
      if (dirty && mounted) render();
    }
    return output;
  }
  function unmount() {
    for (const slot of slots) slot.cleanup?.();
    mounted = false;
  }
  return {
    clock,
    context,
    requests,
    registrations,
    registeredAt,
    render,
    flush,
    unmount,
    get output() {
      return output;
    },
  };
}

test("20ms typing sends one final search after 200ms quiet time and hides old rows immediately", async () => {
  const h = harness();
  h.render();
  await h.flush();
  assert.equal(h.requests.length, 1);
  h.requests[0].receipt.resolve(page("old"));
  await h.flush();
  assert.equal(h.output.data?.items[0].id, "old");
  for (let length = 1; length <= "Keystone".length; length++) {
    const next = h.render({
      resource: "players",
      query: "Keystone".slice(0, length),
      page: 0,
    });
    assert.equal(next.data, null);
    assert.equal(next.error, "");
    assert.equal(next.loading, true);
    await h.flush();
    h.clock.tick(20);
    await h.flush();
    assert.equal(h.requests.length, 1);
    assert.equal(h.registrations.size, 0);
  }
  h.clock.tick(179);
  await h.flush();
  assert.equal(h.requests.length, 1);
  h.clock.tick(1);
  await h.flush();
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].query.query, "Keystone");
  assert.deepEqual(h.registeredAt, [0, 340]);
  h.requests[1].receipt.resolve(page("latest"));
  await h.flush();
  assert.equal(h.output.data?.items[0].id, "latest");
  assert.equal(h.registrations.size, 1);
  h.unmount();
  assert.equal(h.registrations.size, 0);
});

test("supersession and unmount cancel timers, abort old reads and prevent future registration", async () => {
  const h = harness();
  h.render();
  await h.flush();
  h.render({ resource: "players", query: "K" });
  await h.flush();
  assert.equal(h.requests[0].signal.aborted, true);
  assert.equal(h.registrations.size, 0);
  h.clock.tick(100);
  h.render({ resource: "players", query: "Ke" });
  await h.flush();
  assert.equal(h.clock.pending.size, 1);
  h.clock.tick(199);
  assert.equal(h.requests.length, 1);
  h.unmount();
  assert.equal(h.clock.pending.size, 0);
  h.clock.tick(1000);
  h.requests[0].receipt.resolve(page("too late"));
  await h.flush();
  assert.equal(h.requests.length, 1);
  assert.equal(h.registrations.size, 0);
});

test("initial, page, filter, clear and whitespace-only queries dispatch without a timer", async () => {
  for (const change of [
    { resource: "players", query: "Keystone", page: 1 },
    { resource: "players", query: "Keystone", type: "CREDIT" },
    { resource: "players", query: "" },
    { resource: "players", query: "   " },
    { resource: "transactions", query: "Keystone" },
  ] satisfies ReadQuery[]) {
    const h = harness();
    h.render({ resource: "players", query: "Keystone" });
    await h.flush();
    assert.equal(h.requests.length, 1);
    h.render(change);
    await h.flush();
    assert.equal(h.requests.length, 2, JSON.stringify(change));
    assert.equal(h.clock.pending.size, 0);
    h.unmount();
  }
});

test("explicit retry dispatches immediately and does not repeat the debounce delay", async () => {
  const h = harness();
  h.render({ resource: "players", query: "Keystone" });
  await h.flush();
  h.requests[0].receipt.reject(new Error("Cannot load records."));
  await h.flush();
  assert.equal(h.output.error, "Cannot load records.");
  h.output.retry();
  await h.flush();
  assert.equal(h.requests.length, 2);
  assert.equal(h.clock.pending.size, 0);
  assert.equal(h.output.error, "");
  h.unmount();
});

test("changed freshness dispatches the pending latest text immediately and cancels its timer", async () => {
  const updates = [
    (h: ReturnType<typeof harness>) => h.context.snapshot!.revision++,
    (h: ReturnType<typeof harness>) =>
      (h.context.snapshot!.branch.id = "another-fictional-venue"),
    (h: ReturnType<typeof harness>) => h.context.readGeneration++,
    (h: ReturnType<typeof harness>) => {
      const previous = h.context.read;
      h.context.read = (...args) => previous(...args);
    },
    (h: ReturnType<typeof harness>) => {
      const previous = h.context.registerRead;
      h.context.registerRead = (...args) => previous(...args);
    },
  ];
  for (const update of updates) {
    const h = harness();
    h.render({ resource: "players", query: "old" });
    await h.flush();
    h.render({ resource: "players", query: "latest" });
    await h.flush();
    assert.equal(h.requests.length, 1);
    update(h);
    h.render();
    await h.flush();
    assert.equal(h.requests.length, 2);
    assert.equal(h.requests[1].query.query, "latest");
    assert.equal(h.clock.pending.size, 0);
    h.clock.tick(1000);
    assert.equal(h.requests.length, 2);
    h.unmount();
  }
});

test("a previous query error is hidden on the first render of new text, before its timer starts", async () => {
  const h = harness();
  h.render({ resource: "players", query: "old" });
  await h.flush();
  h.requests[0].receipt.reject(new Error("Old query failure"));
  await h.flush();
  assert.equal(h.output.error, "Old query failure");
  const next = h.render({ resource: "players", query: "latest" });
  assert.equal(next.error, "");
  assert.equal(next.data, null);
  assert.equal(next.loading, true);
  await h.flush();
  assert.equal(h.requests.length, 1);
  h.unmount();
});

test("late successes and failures cannot replace a newer query or clear its loading state", async () => {
  for (const outcome of ["success", "failure"]) {
    const h = harness();
    h.render({ resource: "players", query: "old" });
    await h.flush();
    h.render({ resource: "players", query: "latest" });
    await h.flush();
    if (outcome === "success") h.requests[0].receipt.resolve(page("old"));
    else h.requests[0].receipt.reject(new Error("Old query failure"));
    await h.flush();
    assert.equal(h.output.data, null);
    assert.equal(h.output.error, "");
    assert.equal(h.output.loading, true);
    h.clock.tick(200);
    await h.flush();
    h.requests[1].receipt.resolve(page("latest"));
    await h.flush();
    // The simulated React output changes across flushes despite TS's narrowing.
    assert.equal((h.output.data as Page | null)?.items[0].id, "latest");
    assert.equal(h.output.loading, false);
    h.unmount();
  }
});

test("disabled and missing-venue intervals never make the first newly eligible read wait", async () => {
  const h = harness();
  h.render({ resource: "players", query: "old" });
  await h.flush();
  h.render({ resource: "players", query: "changed" }, false);
  await h.flush();
  assert.equal(h.requests.length, 1);
  assert.equal(h.registrations.size, 0);
  h.render({ resource: "players", query: "changed again" }, true);
  await h.flush();
  assert.equal(h.requests.length, 2);
  assert.equal(h.clock.pending.size, 0);
  h.context.snapshot!.branch.id = undefined;
  h.render({ resource: "players", query: "without venue" });
  await h.flush();
  h.context.snapshot!.branch.id = "fictional-venue";
  h.render({ resource: "players", query: "eligible again" });
  await h.flush();
  assert.equal(h.requests.length, 3);
  assert.equal(h.clock.pending.size, 0);
  h.unmount();
});

test("a search edit resetting a later page waits, while an immediately superseded effect never reads", async () => {
  const h = harness();
  h.render({ resource: "players", query: "old", page: 3 });
  h.render({ resource: "players", query: "latest", page: 0 });
  await h.flush();
  assert.equal(h.requests.length, 0);
  assert.equal(h.registrations.size, 0);
  h.clock.tick(200);
  await h.flush();
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.requests[0].query, {
    resource: "players",
    query: "latest",
    page: 0,
  });
  h.unmount();
});

test("prototype searches preserve local behavior without live reads, timers or registrations", async () => {
  const h = harness(true);
  h.render({ resource: "players", query: "old" });
  await h.flush();
  h.render({ resource: "players", query: "latest" });
  await h.flush();
  h.clock.tick(1000);
  assert.equal(h.output.live, false);
  assert.equal(h.output.loading, false);
  assert.equal(h.requests.length, 0);
  assert.equal(h.registrations.size, 0);
  assert.equal(h.clock.pending.size, 0);
  h.unmount();
});

const accessChanges = [
  {
    name: "venue",
    change: (h: ReturnType<typeof harness>) => {
      h.context.snapshot!.branch.id = "other-fictional-venue";
    },
  },
  {
    name: "staff account",
    change: (h: ReturnType<typeof harness>) => {
      h.context.snapshot!.user.id = "other-fictional-staff";
    },
  },
  {
    name: "staff role",
    change: (h: ReturnType<typeof harness>) => {
      h.context.snapshot!.user.role = "CASHIER";
    },
  },
  {
    name: "read capability",
    change: (h: ReturnType<typeof harness>) => {
      const previous = h.context.read;
      h.context.read = (...args) => previous(...args);
    },
  },
];

test("same-query rows disappear on the first render of changed access and stay hidden until its read completes", async () => {
  for (const { name, change } of accessChanges) {
    const h = harness();
    h.render({ resource: "players", query: "Keystone" });
    await h.flush();
    h.requests[0].receipt.resolve(page("previous-access"));
    await h.flush();
    assert.equal(h.output.data?.items[0].id, "previous-access");
    change(h);
    const changed = h.render();
    assert.equal(changed.data, null, name);
    assert.equal(changed.error, "", name);
    assert.equal(changed.loading, true, name);
    await h.flush();
    assert.equal(h.requests.length, 2, name);
    assert.equal(h.clock.pending.size, 0, name);
    assert.equal(h.output.data, null, name);
    h.requests[1].receipt.resolve(page("current-access"));
    await h.flush();
    assert.equal((h.output.data as Page | null)?.items[0].id, "current-access");
    assert.equal(h.output.loading, false, name);
    h.unmount();
  }
});

test("same-query failures disappear on the first render of changed access", async () => {
  for (const { name, change } of accessChanges) {
    const h = harness();
    h.render();
    await h.flush();
    h.requests[0].receipt.reject(new Error("Previous access failed"));
    await h.flush();
    assert.equal(h.output.error, "Previous access failed");
    change(h);
    const changed = h.render();
    assert.equal(changed.error, "", name);
    assert.equal(changed.data, null, name);
    assert.equal(changed.loading, true, name);
    await h.flush();
    assert.equal(h.requests.length, 2, name);
    h.unmount();
  }
});

test("an access change with a text edit dispatches immediately rather than retaining the typing delay", async () => {
  for (const { name, change } of accessChanges) {
    const h = harness();
    h.render({ resource: "players", query: "old" });
    await h.flush();
    change(h);
    h.render({ resource: "players", query: "latest" });
    await h.flush();
    assert.equal(h.requests.length, 2, name);
    assert.equal(h.clock.pending.size, 0, name);
    assert.equal(h.requests[1].query.query, "latest", name);
    h.unmount();
  }
});

test("disabling and reenabling a same-query read never restores its earlier rows or errors", async () => {
  for (const outcome of ["success", "failure"]) {
    const h = harness();
    h.render();
    await h.flush();
    if (outcome === "success") h.requests[0].receipt.resolve(page("earlier"));
    else h.requests[0].receipt.reject(new Error("Earlier failure"));
    await h.flush();
    const disabled = h.render(undefined, false);
    assert.equal(disabled.data, null, outcome);
    assert.equal(disabled.error, "", outcome);
    assert.equal(disabled.loading, false, outcome);
    await h.flush();
    assert.equal(h.requests.length, 1, outcome);
    assert.equal(h.registrations.size, 0, outcome);
    const enabled = h.render(undefined, true);
    assert.equal(enabled.data, null, outcome);
    assert.equal(enabled.error, "", outcome);
    assert.equal(enabled.loading, true, outcome);
    await h.flush();
    assert.equal(h.requests.length, 2, outcome);
    assert.equal(h.clock.pending.size, 0, outcome);
    assert.equal(h.output.data, null, outcome);
    h.requests[1].receipt.resolve(page("fresh"));
    await h.flush();
    assert.equal((h.output.data as Page | null)?.items[0].id, "fresh");
    h.unmount();
  }
});

test("missing access hides cached output and prevents requests until a fresh eligible read", async () => {
  for (const missing of ["snapshot", "venue", "staff", "role"]) {
    for (const outcome of ["success", "failure"]) {
      const h = harness();
      h.render();
      await h.flush();
      if (outcome === "success") h.requests[0].receipt.resolve(page("earlier"));
      else h.requests[0].receipt.reject(new Error("Earlier failure"));
      await h.flush();
      const saved = structuredClone(h.context.snapshot);
      if (missing === "snapshot") h.context.snapshot = null;
      else if (missing === "venue") h.context.snapshot!.branch.id = undefined;
      else if (missing === "staff") h.context.snapshot!.user.id = undefined;
      else h.context.snapshot!.user.role = undefined;
      const hidden = h.render();
      assert.equal(hidden.data, null, missing + outcome);
      assert.equal(hidden.error, "", missing + outcome);
      assert.equal(hidden.loading, false, missing + outcome);
      await h.flush();
      assert.equal(h.requests.length, 1, missing + outcome);
      assert.equal(h.registrations.size, 0, missing + outcome);
      h.context.snapshot = saved;
      const restored = h.render();
      assert.equal(restored.data, null, missing + outcome);
      assert.equal(restored.error, "", missing + outcome);
      assert.equal(restored.loading, true, missing + outcome);
      await h.flush();
      assert.equal(h.requests.length, 2, missing + outcome);
      assert.equal(h.clock.pending.size, 0, missing + outcome);
      h.unmount();
    }
  }
});

test("late completions from previous access cannot replace current rows or failures", async () => {
  for (const { name, change } of accessChanges) {
    for (const outcome of ["success", "failure"]) {
      const h = harness();
      h.render();
      await h.flush();
      change(h);
      h.render();
      await h.flush();
      assert.equal(h.requests[0].signal.aborted, true, name);
      assert.equal(h.requests.length, 2, name);
      h.requests[1].receipt.resolve(page("current"));
      await h.flush();
      // These promises deliberately settle even though their signal is aborted.
      if (outcome === "success") h.requests[0].receipt.resolve(page("old"));
      else h.requests[0].receipt.reject(new Error("Old access failed"));
      await h.flush();
      assert.equal(h.output.data?.items[0].id, "current", name + outcome);
      assert.equal(h.output.error, "", name + outcome);
      assert.equal(h.output.loading, false, name + outcome);
      assert.equal(h.registrations.size, 1, name + outcome);
      h.unmount();
    }
  }
});

test("equal access in fresh snapshot objects retains rows without an extra request", async () => {
  const h = harness();
  h.render();
  await h.flush();
  h.requests[0].receipt.resolve(page("still-current"));
  await h.flush();
  for (let count = 0; count < 3; count++) {
    h.context.snapshot = structuredClone(h.context.snapshot);
    const current = h.render();
    assert.equal(current.data?.items[0].id, "still-current");
    assert.equal(current.loading, false);
    await h.flush();
    assert.equal(h.requests.length, 1);
  }
  h.unmount();
});

test("same-access revision, refresh generation and retry retain displayed rows while reading immediately", async () => {
  const h = harness();
  h.render();
  await h.flush();
  h.requests[0].receipt.resolve(page("retained"));
  await h.flush();
  const updates = [
    () => h.context.snapshot!.revision++,
    () => h.context.readGeneration++,
    () => h.output.retry(),
  ];
  for (const [index, update] of updates.entries()) {
    update();
    const current = h.render();
    assert.equal(current.data?.items[0].id, "retained");
    await h.flush();
    assert.equal(h.requests.length, index + 2);
    assert.equal(h.clock.pending.size, 0);
    assert.equal(h.output.loading, true);
    assert.equal(h.output.data?.items[0].id, "retained");
    h.requests[index + 1].receipt.resolve(page("retained"));
    await h.flush();
    assert.equal(h.output.loading, false);
  }
  h.unmount();
});
