import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import type { Branch, Staff } from "../src/domain/model";
import {
  authReceipt,
  loginReceipt,
  okReceipt,
} from "../src/lib/management-contracts";
import {
  checkedLoginIdentity,
  StaffAccountMismatchError,
  STAFF_ACCOUNT_MISMATCH_MESSAGE,
} from "../src/lib/login-identity";
import { ManagementResponseError } from "../src/lib/management-response";
import {
  clearSignOutIntent,
  readSignOutIntent,
  readSignOutUrlIntent,
  SIGN_OUT_INTENT_KEY,
  writeSignOutIntent,
  writeSignOutUrlIntent,
  type SignOutIntentStorage,
} from "../src/lib/sign-out-intent";

// Execute the provider's actual callbacks with observable browser/React
// capabilities. Browser rendering and HTTP revocation have separate QA suites.
const filename = "src/contexts/auth-context.tsx";
const source = readFileSync(filename, "utf8");
const tree = ts.createSourceFile(
  filename,
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const provider = tree.statements.find(
  (node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === "AuthProvider",
);
assert.ok(provider?.body);
const statements = provider.body.statements.filter(
  (statement) => !ts.isReturnStatement(statement),
);
const constants = tree.statements.filter(
  (statement) =>
    ts.isVariableStatement(statement) &&
    statement.declarationList.declarations.some(
      (declaration) =>
        ts.isIdentifier(declaration.name) &&
        [
          "signOutFailed",
          "signOutStorageFailed",
          "signOutProtectionFailed",
          "loginBusy",
        ].includes(declaration.name.text),
    ),
);
const printer = ts.createPrinter();
const javascript = ts.transpileModule(
  [
    ...constants.map((node) =>
      printer.printNode(ts.EmitHint.Unspecified, node, tree),
    ),
    "function actualProvider() {",
    ...statements.map((node) =>
      printer.printNode(ts.EmitHint.Unspecified, node, tree),
    ),
    "return { refresh, login, logout, switchBranch }; }",
  ].join("\n"),
  {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  },
).outputText;
const stateNames = statements.flatMap((statement) =>
  ts.isVariableStatement(statement)
    ? statement.declarationList.declarations.flatMap((declaration) =>
        ts.isArrayBindingPattern(declaration.name) &&
        ts.isBindingElement(declaration.name.elements[0]) &&
        declaration.initializer &&
        ts.isCallExpression(declaration.initializer) &&
        declaration.initializer.expression.getText(tree) === "useState"
          ? [declaration.name.elements[0].name!.getText(tree)]
          : [],
      )
    : [],
);

const staff: Staff = Object.freeze({
  id: "fictional-signout-staff",
  username: "fictional.signout",
  branchId: "fictional-signout-venue",
  role: "ADMIN",
});
const branch: Branch = Object.freeze({
  id: staff.branchId,
  name: "Fictional sign-out venue",
  timezone: "Asia/Kuala_Lumpur",
  role: staff.role,
});
const failed = "Could not finish signing out. Please try again.";
const storageFailed =
  "Your session ended. Allow browser storage and retry to continue.";
const protectionFailed =
  "Could not save sign-out protection. Keep this page open, allow browser storage and retry signing out.";
const financialKey = "poker.pending-operation.v1.fictional-signout";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function flush() {
  for (let count = 0; count < 8; count++) await Promise.resolve();
}

function harness(
  options: {
    marker?: string;
    prototype?: boolean;
    pathname?: string;
    url?: string;
    historyFailure?: boolean;
    storageFailure?: boolean;
    request?: (path: string, init?: RequestInit) => Promise<unknown>;
    onStateChange?: (name: string, value: unknown) => void;
  } = {},
) {
  const values = new Map<string, string>([
    [financialKey, "untouched-checkpoint"],
  ]);
  if (options.marker !== undefined)
    values.set(SIGN_OUT_INTENT_KEY, options.marker);
  const storage: SignOutIntentStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  };
  const effects: Array<() => void | (() => void)> = [];
  const cleanups: Array<() => void> = [];
  const listeners = new Map<string, (event: { persisted: boolean }) => void>();
  const state: Record<string, unknown> = {};
  const stateChanges: Array<{ name: string; value: unknown }> = [];
  const requests: Array<{ path: string; method: string }> = [];
  const navigations: Array<{ kind: string; path: string }> = [];
  const historyChanges: Array<{ state: unknown; url: string }> = [];
  const restorationEvents: string[] = [];
  const historyState = { fictionalRouterState: ["preserved"] };
  let href =
    options.url ?? `http://localhost:3002${options.pathname ?? "/en/players"}`;
  let stateIndex = 0;
  const dependencies = {
    useRouter: () => ({
      replace: (path: string) => navigations.push({ kind: "router", path }),
    }),
    useState: (initial: unknown) => {
      const name = stateNames[stateIndex++];
      assert.ok(name);
      state[name] = initial;
      return [
        initial,
        (value: unknown) => {
          state[name] = value;
          stateChanges.push({ name, value });
          options.onStateChange?.(name, value);
        },
      ];
    },
    useRef: (initial: unknown) => ({ current: initial }),
    useCallback: <T>(callback: T) => callback,
    flushSync: (callback: () => void) => {
      restorationEvents.push("flush-start");
      callback();
      restorationEvents.push("flush-end");
    },
    useEffect: (effect: () => void | (() => void)) => effects.push(effect),
    prototypeEnabled: !!options.prototype,
    managementJson: async (path: string, init?: RequestInit) => {
      requests.push({ path, method: init?.method ?? "GET" });
      return options.request
        ? options.request(path, init)
        : init?.method === "DELETE"
          ? { ok: true }
          : { user: staff, branches: [branch] };
    },
    authReceipt,
    loginReceipt,
    okReceipt,
    checkedLoginIdentity,
    StaffAccountMismatchError,
    ManagementResponseError,
    clearSignOutIntent,
    readSignOutIntent,
    readSignOutUrlIntent,
    writeSignOutIntent,
    writeSignOutUrlIntent,
    window: {
      get sessionStorage() {
        if (options.storageFailure) throw new Error("private storage denial");
        return storage;
      },
      history: {
        state: historyState,
        replaceState: (state: unknown, _unused: string, url: string) => {
          if (options.historyFailure) throw new Error("private history denial");
          historyChanges.push({ state, url });
          href = url;
        },
      },
      location: {
        get pathname() {
          return new URL(href).pathname;
        },
        get href() {
          return href;
        },
        replace: (path: string) => navigations.push({ kind: "replace", path }),
        assign: (path: string) => navigations.push({ kind: "assign", path }),
        reload: () => {
          assert.equal(state.signingOut, true);
          assert.equal(state.user, null);
          assert.deepEqual(state.branches, []);
          restorationEvents.push("reload");
          navigations.push({ kind: "reload", path: href });
        },
      },
      addEventListener: (
        name: string,
        callback: (event: { persisted: boolean }) => void,
      ) => listeners.set(name, callback),
      removeEventListener: (name: string) => listeners.delete(name),
    },
  };
  const create = new Function(
    ...Object.keys(dependencies),
    `${javascript}\nreturn actualProvider;`,
  )(...Object.values(dependencies)) as () => {
    refresh: () => Promise<Staff | null>;
    login: (username: string, password: string) => Promise<void>;
    logout: () => Promise<void>;
    switchBranch: (branchId: string) => Promise<void>;
  };
  const callbacks = create();
  return {
    ...callbacks,
    state,
    stateChanges,
    values,
    storage,
    requests,
    navigations,
    historyChanges,
    historyState,
    restorationEvents,
    currentUrl: () => href,
    async mount() {
      for (const effect of effects) {
        const cleanup = effect();
        if (cleanup) cleanups.push(cleanup);
      }
      await flush();
    },
    dispose() {
      for (const cleanup of cleanups) cleanup();
    },
    restore(persisted = true) {
      listeners.get("pageshow")?.({ persisted });
    },
    hide(persisted = true) {
      listeners.get("pagehide")?.({ persisted });
    },
    installTransitionHandlers() {
      const cleanup = effects[1]();
      if (cleanup) cleanups.push(cleanup);
    },
    listenerCount: () => listeners.size,
  };
}

test("normal startup checks intent before GET and retains ordinary staff access", async () => {
  const value = harness();
  assert.equal(value.state.loading, true);
  assert.deepEqual(value.requests, []);
  await value.mount();
  assert.deepEqual(value.requests, [{ path: "/api/auth", method: "GET" }]);
  assert.deepEqual(value.state.user, staff);
  assert.deepEqual(value.state.branches, [branch]);
  assert.equal(value.state.loading, false);
  assert.equal(value.state.signingOut, false);
  assert.equal(value.listenerCount(), 2);
  value.dispose();
  assert.equal(value.listenerCount(), 0);
});

test("a restored or unreadable intent locks before any auth request", async () => {
  for (const options of [
    { marker: "1" },
    { marker: "" },
    { storageFailure: true },
    { url: "http://localhost:3002/en/players?signout=1" },
    { url: "http://localhost:3002/en/players?signout=" },
  ]) {
    const value = harness(options);
    await value.mount();
    assert.deepEqual(value.requests, []);
    assert.equal(value.state.user, null);
    assert.deepEqual(value.state.branches, []);
    assert.equal(value.state.loading, false);
    assert.equal(value.state.signingOut, true);
    await assert.rejects(value.refresh(), { message: failed });
    await assert.rejects(value.login("fictional", "fictional"), {
      message: failed,
    });
    await assert.rejects(value.switchBranch("fictional-next"), {
      message: failed,
    });
    assert.deepEqual(value.requests, []);
    assert.equal(value.values.get(financialKey), "untouched-checkpoint");
  }
});

test("logout hides identity synchronously before DELETE and double clicks send once", async () => {
  const response = deferred<unknown>();
  const value = harness({
    request: async (_path, init) =>
      init?.method === "DELETE"
        ? response.promise
        : { user: staff, branches: [branch] },
  });
  await value.mount();
  const first = value.logout();
  assert.equal(value.state.signingOut, true);
  assert.equal(value.state.signOutBusy, true);
  assert.equal(value.state.user, null);
  assert.deepEqual(value.state.branches, []);
  assert.equal(value.state.loading, false);
  assert.equal(value.values.get(SIGN_OUT_INTENT_KEY), "1");
  await value.logout();
  assert.equal(
    value.requests.filter((row) => row.method === "DELETE").length,
    1,
  );
  await assert.rejects(value.refresh(), { message: failed });
  await assert.rejects(value.login(staff.username, "fictional"), {
    message: failed,
  });
  await assert.rejects(value.switchBranch("fictional-next"), {
    message: failed,
  });
  assert.equal(value.requests.length, 2);
  response.resolve({ ok: true });
  await first;
  assert.deepEqual(value.navigations, [{ kind: "replace", path: "/en/login" }]);
  assert.equal(value.state.signingOut, true);
  assert.equal(value.state.signOutBusy, false);
  assert.equal(value.values.has(SIGN_OUT_INTENT_KEY), false);
  assert.equal(value.values.get(financialKey), "untouched-checkpoint");
});

test("lost or malformed DELETE receipts retain the barrier until an explicit DELETE retry", async () => {
  for (const first of [
    new Error("private network internals"),
    new ManagementResponseError("private 503 details", 503, null),
    new ManagementResponseError("private 401 details", 401, null),
    {},
    { ok: false },
  ]) {
    let deletes = 0;
    const value = harness({
      request: async (_path, init) => {
        if (init?.method !== "DELETE")
          return { user: staff, branches: [branch] };
        if (++deletes > 1) return { ok: true };
        if (first instanceof Error) throw first;
        return first;
      },
    });
    await value.mount();
    await assert.rejects(value.logout(), { message: failed });
    assert.equal(value.state.signingOut, true);
    assert.equal(value.state.signOutBusy, false);
    assert.equal(value.state.signOutError, failed);
    assert.equal(value.state.user, null);
    assert.equal(value.values.get(SIGN_OUT_INTENT_KEY), "1");
    assert.deepEqual(value.navigations, []);
    assert.equal(
      value.requests.filter((row) => row.method === "GET").length,
      1,
    );
    await value.logout();
    assert.equal(deletes, 2);
    assert.equal(value.state.signingOut, true);
    assert.equal(value.state.signOutError, "");
    assert.deepEqual(value.navigations, [
      { kind: "replace", path: "/en/login" },
    ]);
    assert.equal(value.values.get(financialKey), "untouched-checkpoint");
  }
});

test("quota-only marker failure plus failed DELETE remains locked after fresh-provider reload", async () => {
  const first = harness({
    url: "http://localhost:3002/zh/players?status=active#details",
    request: async (_path, init) => {
      if (init?.method === "DELETE") throw new Error("private response loss");
      return { user: staff, branches: [branch] };
    },
  });
  first.storage.setItem = () => {
    throw new Error("private quota exceeded");
  };
  await first.mount();
  await assert.rejects(first.logout(), { message: failed });
  assert.equal(first.storage.getItem(SIGN_OUT_INTENT_KEY), null);
  assert.equal(first.state.signingOut, true);
  assert.equal(first.state.user, null);
  assert.equal(first.historyChanges.length, 1);
  assert.strictEqual(first.historyChanges[0].state, first.historyState);
  const savedUrl = new URL(first.currentUrl());
  assert.equal(savedUrl.pathname, "/zh/login");
  assert.equal(savedUrl.searchParams.get("signout"), "1");
  assert.equal(savedUrl.searchParams.get("status"), "active");
  assert.equal(savedUrl.hash, "#details");
  const reloaded = harness({ url: first.currentUrl() });
  reloaded.storage.setItem = first.storage.setItem;
  await reloaded.mount();
  assert.deepEqual(reloaded.requests, []);
  assert.equal(reloaded.state.signingOut, true);
  assert.equal(reloaded.state.user, null);
  await assert.rejects(reloaded.refresh(), { message: failed });
  assert.deepEqual(reloaded.requests, []);
  await reloaded.logout();
  assert.deepEqual(reloaded.requests, [
    { path: "/api/auth", method: "DELETE" },
  ]);
  assert.deepEqual(reloaded.navigations, [
    { kind: "replace", path: "/zh/login" },
  ]);
  assert.equal(reloaded.state.signingOut, true);
  assert.equal(reloaded.values.get(financialKey), "untouched-checkpoint");
});

test("both persistence failures warn immediately, keep the document locked and still attempt revocation", async () => {
  const response = deferred<unknown>();
  const value = harness({
    historyFailure: true,
    request: async (_path, init) =>
      init?.method === "DELETE"
        ? response.promise
        : { user: staff, branches: [branch] },
  });
  await value.mount();
  value.storage.setItem = () => {
    throw new Error("private quota exceeded");
  };
  const logout = value.logout();
  assert.equal(value.state.signingOut, true);
  assert.equal(value.state.signOutBusy, true);
  assert.equal(value.state.user, null);
  assert.equal(value.state.signOutError, protectionFailed);
  assert.equal(
    value.requests.filter((row) => row.method === "DELETE").length,
    1,
  );
  const rejected = assert.rejects(logout, { message: protectionFailed });
  response.reject(new Error("private response loss"));
  await rejected;
  assert.equal(value.state.signOutError, protectionFailed);
  assert.equal(value.state.signOutBusy, false);
  assert.deepEqual(value.navigations, []);
  assert.equal(value.values.get(financialKey), "untouched-checkpoint");
});

test("late pre-signout GET success and failures cannot restore identity or navigate", async () => {
  for (const outcome of [
    { user: staff, branches: [branch] },
    new ManagementResponseError("private expired", 401, null),
    new ManagementResponseError("private unavailable", 503, null),
    { malformed: true },
  ]) {
    const authRead = deferred<unknown>();
    const deletion = deferred<unknown>();
    const value = harness({
      request: async (_path, init) =>
        init?.method === "DELETE" ? deletion.promise : authRead.promise,
    });
    await value.mount();
    const logout = value.logout();
    const changes = value.stateChanges.length;
    if (outcome instanceof Error) authRead.reject(outcome);
    else authRead.resolve(outcome);
    await flush();
    assert.equal(value.stateChanges.length, changes);
    assert.equal(value.state.user, null);
    assert.equal(value.state.error, "");
    assert.equal(value.state.loading, false);
    assert.deepEqual(value.navigations, []);
    deletion.resolve({ ok: true });
    await logout;
  }
});

test("late login and venue switch completions cannot navigate through a signout barrier", async () => {
  for (const action of ["login", "switch"] as const) {
    const write = deferred<unknown>();
    const deletion = deferred<unknown>();
    const value = harness({
      request: async (_path, init) =>
        init?.method === "DELETE"
          ? deletion.promise
          : init?.method === "POST"
            ? write.promise
            : { user: staff, branches: [branch] },
    });
    await value.mount();
    const original =
      action === "login"
        ? value.login("fictional", "fictional")
        : value.switchBranch("fictional-next");
    const rejected = assert.rejects(original, { message: failed });
    const logout = value.logout();
    write.resolve({ ok: true });
    await rejected;
    assert.deepEqual(value.navigations, []);
    assert.equal(
      value.requests.filter((row) => row.method === "GET").length,
      1,
    );
    deletion.resolve({ ok: true });
    await logout;
  }
});

test("login cannot finish when signout starts between refreshed access and its continuation", async () => {
  const deletion = deferred<unknown>();
  let armed = false;
  let logout: Promise<void> | undefined;
  const value = harness({
    request: async (_path, init) =>
      init?.method === "DELETE"
        ? deletion.promise
        : { user: staff, branches: [branch] },
    onStateChange(name, state) {
      if (armed && name === "loading" && state === false) {
        armed = false;
        queueMicrotask(() => {
          logout = value.logout();
        });
      }
    },
  });
  await value.mount();
  armed = true;
  await assert.rejects(value.login(staff.username, "fictional"), {
    message: failed,
  });
  assert.ok(logout);
  assert.equal(value.state.signingOut, true);
  assert.equal(value.state.user, null);
  assert.deepEqual(value.navigations, []);
  deletion.resolve({ ok: true });
  await logout;
});

test("storage failures still revoke the server session and require safe retry before navigation", async () => {
  for (const failure of ["access", "write", "remove", "readback"] as const) {
    const value = harness({ storageFailure: failure === "access" });
    if (failure === "write")
      value.storage.setItem = () => {
        throw new Error("private write");
      };
    if (failure === "remove")
      value.storage.removeItem = () => {
        throw new Error("private remove");
      };
    if (failure === "readback") value.storage.removeItem = () => {};
    await value.mount();
    if (failure === "write") {
      await value.logout();
      assert.deepEqual(value.navigations, [
        { kind: "replace", path: "/en/login" },
      ]);
    } else {
      await assert.rejects(value.logout(), { message: storageFailed });
      assert.equal(value.state.signOutError, storageFailed);
      assert.deepEqual(value.navigations, []);
    }
    assert.equal(
      value.requests.filter((row) => row.method === "DELETE").length,
      1,
    );
    assert.equal(value.state.signingOut, true);
    assert.equal(value.state.signOutBusy, false);
    assert.equal(value.values.get(financialKey), "untouched-checkpoint");
  }
});

test("every persisted pageshow locks and reloads even when a completed logout removed all intent markers", async () => {
  const older = harness();
  await older.mount();
  assert.deepEqual(older.state.user, staff);
  assert.equal(older.values.has(SIGN_OUT_INTENT_KEY), false);
  older.restore();
  assert.deepEqual(older.restorationEvents, [
    "flush-start",
    "flush-end",
    "reload",
  ]);
  assert.equal(older.state.signingOut, true);
  assert.equal(older.state.user, null);
  assert.deepEqual(older.state.branches, []);
  assert.deepEqual(older.navigations, [
    { kind: "reload", path: "http://localhost:3002/en/players" },
  ]);
  assert.equal(older.requests.length, 1);
  await assert.rejects(older.refresh(), { message: failed });

  const value = harness();
  await value.mount();
  value.values.set(SIGN_OUT_INTENT_KEY, "1");
  value.restore(false);
  assert.equal(value.state.signingOut, false);
  value.restore();
  assert.equal(value.state.signingOut, true);
  assert.equal(value.state.user, null);
  assert.deepEqual(value.state.branches, []);
  assert.equal(value.requests.length, 1);
  assert.equal(
    value.navigations.filter((entry) => entry.kind === "reload").length,
    1,
  );
  value.values.delete(SIGN_OUT_INTENT_KEY);
  value.restore();
  assert.equal(value.state.signingOut, true);
  assert.equal(
    value.navigations.filter((entry) => entry.kind === "reload").length,
    2,
  );
  await assert.rejects(value.refresh(), { message: failed });
});

test("persisted pagehide synchronously stores a neutral frame without signout intent or auth work", async () => {
  const access = deferred<unknown>();
  let readCount = 0;
  const value = harness({
    request: async () =>
      ++readCount === 1 ? { user: staff, branches: [branch] } : access.promise,
  });
  await value.mount();
  const current = structuredClone(value.state);
  value.hide(false);
  assert.deepEqual(value.state, current);
  assert.deepEqual(value.restorationEvents, []);
  const lateRead = value.refresh();
  const rejected = assert.rejects(lateRead, { message: failed });
  value.hide();
  assert.deepEqual(value.restorationEvents, ["flush-start", "flush-end"]);
  assert.equal(value.state.user, null);
  assert.deepEqual(value.state.branches, []);
  assert.equal(value.state.loading, true);
  assert.equal(value.state.signingOut, false);
  assert.equal(value.values.has(SIGN_OUT_INTENT_KEY), false);
  assert.equal(new URL(value.currentUrl()).searchParams.has("signout"), false);
  assert.equal(value.values.get(financialKey), "untouched-checkpoint");
  assert.equal(value.requests.length, 2);
  assert.deepEqual(value.navigations, []);
  const changes = value.stateChanges.length;
  access.resolve({ user: staff, branches: [branch] });
  await rejected;
  assert.equal(value.stateChanges.length, changes);
  assert.equal(value.state.loading, true);
  value.restore();
  assert.equal(value.state.signingOut, true);
  assert.deepEqual(value.restorationEvents, [
    "flush-start",
    "flush-end",
    "flush-start",
    "flush-end",
    "reload",
  ]);
  assert.equal(value.requests.length, 2);
});

test("prototype page transitions install no privacy listener or navigation override", () => {
  const value = harness({ prototype: true });
  const before = structuredClone(value.state);
  value.installTransitionHandlers();
  assert.equal(value.listenerCount(), 0);
  value.hide();
  value.restore();
  assert.deepEqual(value.state, before);
  assert.deepEqual(value.restorationEvents, []);
  assert.deepEqual(value.requests, []);
  assert.deepEqual(value.navigations, []);
});

test("successful signout retains its document barrier and preserves Chinese navigation", async () => {
  const value = harness({ pathname: "/zh/reports" });
  await value.mount();
  await value.logout();
  assert.deepEqual(value.navigations, [{ kind: "replace", path: "/zh/login" }]);
  value.restore();
  assert.equal(value.state.signingOut, true);
  await assert.rejects(value.refresh(), { message: failed });
  assert.equal(value.requests.length, 2);
});

test("prototype logout keeps the persona behavior and never touches production intent or DELETE", async () => {
  const value = harness({
    prototype: true,
    marker: "1",
    pathname: "/zh/players",
  });
  // Prototype subscription imports are integration-tested by the demo suite;
  // direct logout executes this provider's real prototype branch only.
  await value.logout();
  assert.deepEqual(value.navigations, [{ kind: "router", path: "/zh/login" }]);
  assert.deepEqual(value.requests, []);
  assert.equal(value.state.signingOut, false);
  assert.equal(value.values.get(SIGN_OUT_INTENT_KEY), "1");
  assert.equal(value.values.get(financialKey), "untouched-checkpoint");
});

test("a successful login pins requested account identity and permits its latest role and venue", async () => {
  const latest = {
    ...staff,
    role: "CASHIER",
    branchId: "fictional-latest-venue",
  } as Staff;
  let reads = 0;
  const value = harness({
    request: async (_path, init) => {
      if (init?.method === "POST") return { user: { ...staff } };
      const user = ++reads === 1 ? staff : latest;
      return {
        user,
        branches: [{ ...branch, id: user.branchId, role: user.role }],
      };
    },
  });
  await value.mount();
  await value.login(` ${staff.username.toUpperCase()} `, "fictional-password");
  assert.deepEqual(value.state.user, latest);
  assert.deepEqual(value.state.branches, [
    { ...branch, id: latest.branchId, role: latest.role },
  ]);
  assert.equal(value.state.error, "");
  assert.equal(value.requests.filter((row) => row.method === "POST").length, 1);
  assert.equal(value.values.get(financialKey), "untouched-checkpoint");
  assert.equal(value.values.has(SIGN_OUT_INTENT_KEY), false);
});

test("a credential receipt for another username is rejected before any followup GET or state commit", async () => {
  const other = {
    ...staff,
    id: "fictional-login-b",
    username: "fictional.other",
  };
  const value = harness({
    request: async (_path, init) =>
      init?.method === "POST"
        ? { user: other }
        : { user: staff, branches: [branch] },
  });
  await value.mount();
  const before = value.stateChanges.length;
  await assert.rejects(
    value.login(staff.username, "fictional-password"),
    (error) => {
      assert.ok(error instanceof StaffAccountMismatchError);
      assert.equal(error.message, STAFF_ACCOUNT_MISMATCH_MESSAGE);
      return true;
    },
  );
  assert.deepEqual(
    value.requests.map((row) => row.method),
    ["GET", "POST"],
  );
  assert.equal(value.state.user, null);
  assert.deepEqual(value.state.branches, []);
  assert.equal(value.state.error, "");
  assert.equal(
    value.stateChanges
      .slice(before)
      .some((event) => event.name === "user" && event.value !== null),
    false,
  );
});

test("successful POST followed by a different account GET never commits that account, including recovery", async () => {
  for (const other of [
    { ...staff, id: "fictional-login-b", username: "fictional.other" },
    { ...staff, id: "fictional-reused-username-id" },
  ]) {
    let candidate: Staff = staff;
    const value = harness({
      request: async (_path, init) =>
        init?.method === "POST"
          ? { user: { ...staff } }
          : { user: candidate, branches: [branch] },
    });
    await value.mount();
    const before = value.stateChanges.length;
    candidate = other;
    await assert.rejects(
      value.login(staff.username, "fictional-password"),
      StaffAccountMismatchError,
    );
    assert.equal(value.state.user, null);
    assert.equal(value.state.error, "");
    await assert.rejects(value.refresh(), StaffAccountMismatchError);
    assert.equal(
      value.stateChanges
        .slice(before)
        .some((event) => event.name === "user" && event.value !== null),
      false,
    );
    candidate = staff;
    assert.deepEqual(await value.refresh(), staff);
    assert.deepEqual(value.state.user, staff);
    assert.equal(
      value.requests.filter((row) => row.method === "POST").length,
      1,
    );
  }
});

test("a validated POST keeps its pinned id across unavailable and malformed followup reads", async () => {
  for (const unavailable of [
    new ManagementResponseError("Fictional unavailable", 503, null),
    {},
    { user: { ...staff, username: "  " }, branches: [branch] },
    { user: { ...staff, id: "x".repeat(101) }, branches: [branch] },
  ]) {
    let reads = 0;
    let candidate: Staff = { ...staff, id: "fictional-reused-username-id" };
    const value = harness({
      request: async (_path, init) => {
        if (init?.method === "POST") return { user: staff };
        if (++reads === 1) return { user: staff, branches: [branch] };
        if (reads === 2) {
          if (unavailable instanceof Error) throw unavailable;
          return unavailable;
        }
        return { user: candidate, branches: [branch] };
      },
    });
    await value.mount();
    await assert.rejects(
      value.login(staff.username, "fictional-password"),
      ManagementResponseError,
    );
    assert.equal(value.state.user, null);
    await assert.rejects(value.refresh(), StaffAccountMismatchError);
    candidate = staff;
    assert.deepEqual(await value.refresh(), staff);
    assert.equal(
      value.requests.filter((row) => row.method === "POST").length,
      1,
    );
  }
});

test("uncertain and malformed credential outcomes retain the requested username for read-only recovery", async () => {
  for (const outcome of [
    new ManagementResponseError("Fictional response loss", 0, null, true),
    undefined,
    {},
    { user: {} },
  ]) {
    let candidate: Staff = staff;
    const value = harness({
      request: async (_path, init) => {
        if (init?.method === "POST") {
          if (outcome instanceof Error) throw outcome;
          return outcome;
        }
        return { user: candidate, branches: [branch] };
      },
    });
    await value.mount();
    await assert.rejects(
      value.login(staff.username, "fictional-password"),
      ManagementResponseError,
    );
    candidate = {
      ...staff,
      id: "fictional-login-b",
      username: "fictional.other",
    };
    await assert.rejects(value.refresh(), StaffAccountMismatchError);
    assert.equal(value.state.user, null);
    candidate = staff;
    assert.deepEqual(await value.refresh(), staff);
    assert.equal(
      value.requests.filter((row) => row.method === "POST").length,
      1,
    );
    assert.deepEqual(
      [...value.values],
      [[financialKey, "untouched-checkpoint"]],
    );
  }
});

test("duplicate provider login and public reads are refused while credentials are in flight", async () => {
  const post = deferred<unknown>();
  const value = harness({
    request: async (_path, init) =>
      init?.method === "POST"
        ? post.promise
        : { user: staff, branches: [branch] },
  });
  await value.mount();
  const first = value.login(staff.username, "fictional-password");
  assert.equal(value.state.user, null);
  assert.deepEqual(value.state.branches, []);
  const busy = "Wait for sign-in to finish before trying again.";
  await assert.rejects(value.login("fictional.other", "fictional-password"), {
    message: busy,
  });
  await assert.rejects(value.refresh(), { message: busy });
  await assert.rejects(value.switchBranch("fictional-next"), { message: busy });
  assert.deepEqual(
    value.requests.map((row) => row.method),
    ["GET", "POST"],
  );
  post.resolve({ user: staff });
  await first;
  assert.deepEqual(value.state.user, staff);
});

test("a login epoch invalidates the older bootstrap GET before it can overwrite the verified account", async () => {
  const bootstrap = deferred<unknown>();
  let reads = 0;
  const value = harness({
    request: async (_path, init) =>
      init?.method === "POST"
        ? { user: staff }
        : ++reads === 1
          ? bootstrap.promise
          : { user: staff, branches: [branch] },
  });
  await value.mount();
  await value.login(staff.username, "fictional-password");
  const changes = value.stateChanges.length;
  bootstrap.resolve({
    user: {
      ...staff,
      id: "fictional-bootstrap-old",
      username: "fictional.old",
    },
    branches: [branch],
  });
  await flush();
  assert.equal(value.stateChanges.length, changes);
  assert.deepEqual(value.state.user, staff);
  assert.equal(value.state.loading, false);
});

test("known rejected credentials release the login guard and a new explicit login replaces the expectation", async () => {
  let candidate: Staff = staff;
  let rejectCredentials = true;
  const value = harness({
    request: async (_path, init) => {
      if (init?.method === "POST") {
        if (rejectCredentials)
          throw new ManagementResponseError(
            "Fictional rejected credentials",
            401,
            null,
          );
        return { user: candidate };
      }
      return { user: candidate, branches: [branch] };
    },
  });
  await value.mount();
  await assert.rejects(
    value.login("fictional.rejected", "fictional-password"),
    ManagementResponseError,
  );
  candidate = {
    ...staff,
    id: "fictional-login-b",
    username: "fictional.other",
  };
  assert.deepEqual(await value.refresh(), candidate);
  rejectCredentials = false;
  await value.login(candidate.username, "fictional-password");
  assert.deepEqual(value.state.user, candidate);
});

test("prototype credential behavior remains independent of production account binding", async () => {
  const other = {
    ...staff,
    id: "fictional-demo-persona",
    username: "fictional.demo",
  };
  const value = harness({
    prototype: true,
    request: async (_path, init) =>
      init?.method === "POST" ? {} : { user: other, branches: [branch] },
  });
  await value.login("fictional.requested", "fictional-password");
  assert.deepEqual(value.state.user, other);
  assert.deepEqual(
    value.requests.map((row) => row.method),
    ["POST", "GET"],
  );
  assert.equal(value.state.signingOut, false);
});
