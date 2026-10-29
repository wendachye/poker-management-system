import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clearSignOutIntent,
  readSignOutIntent,
  readSignOutUrlIntent,
  SIGN_OUT_INTENT_KEY,
  writeSignOutIntent,
  writeSignOutUrlIntent,
  type SignOutIntentStorage,
} from "../src/lib/sign-out-intent";

function storage(initial?: string) {
  const values = new Map<string, string>([
    ["poker.pending-operation.v1.fictional", "financial-checkpoint"],
  ]);
  if (initial !== undefined) values.set(SIGN_OUT_INTENT_KEY, initial);
  const target: SignOutIntentStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  };
  return { values, target, access: () => target };
}

test("only an absent sign-out marker permits normal access", () => {
  assert.equal(readSignOutIntent(storage().access), false);
  for (const value of ["1", "", "0", "null", "malformed marker"])
    assert.equal(readSignOutIntent(storage(value).access), true);
});

test("storage acquisition and read failures lock access without leaking errors", () => {
  assert.equal(
    readSignOutIntent(() => {
      throw new Error("private browser storage error");
    }),
    true,
  );
  const value = storage();
  value.target.getItem = () => {
    throw new Error("private read error");
  };
  assert.equal(readSignOutIntent(value.access), true);
});

test("intent writes only the constant marker and preserves unrelated checkpoints", () => {
  const value = storage();
  assert.equal(writeSignOutIntent(value.access), true);
  assert.equal(readSignOutIntent(value.access), true);
  assert.deepEqual(
    [...value.values],
    [
      ["poker.pending-operation.v1.fictional", "financial-checkpoint"],
      [SIGN_OUT_INTENT_KEY, "1"],
    ],
  );
  assert.equal(clearSignOutIntent(value.access), true);
  assert.deepEqual(
    [...value.values],
    [["poker.pending-operation.v1.fictional", "financial-checkpoint"]],
  );
});

test("write failures and failed readback cannot confirm persisted intent", () => {
  for (const change of [
    (value: SignOutIntentStorage) => {
      value.setItem = () => {
        throw new Error("private write error");
      };
    },
    (value: SignOutIntentStorage) => {
      value.setItem = () => {};
    },
    (value: SignOutIntentStorage) => {
      value.getItem = () => {
        throw new Error("private readback error");
      };
    },
  ]) {
    const value = storage();
    change(value.target);
    assert.equal(writeSignOutIntent(value.access), false);
  }
  assert.equal(
    writeSignOutIntent(() => {
      throw new Error("private acquisition error");
    }),
    false,
  );
});

test("clearing requires a null readback and never repairs an unknown marker", () => {
  for (const change of [
    (value: SignOutIntentStorage) => {
      value.removeItem = () => {
        throw new Error("private removal error");
      };
    },
    (value: SignOutIntentStorage) => {
      value.removeItem = () => {};
    },
    (value: SignOutIntentStorage) => {
      value.getItem = () => {
        throw new Error("private readback error");
      };
    },
  ]) {
    const value = storage("unrecognized marker");
    change(value.target);
    assert.equal(clearSignOutIntent(value.access), false);
    assert.equal(
      value.values.get("poker.pending-operation.v1.fictional"),
      "financial-checkpoint",
    );
  }
  assert.equal(
    clearSignOutIntent(() => {
      throw new Error("private acquisition error");
    }),
    false,
  );
  assert.equal(clearSignOutIntent(storage().access), true);
});

test("URL intent accepts only absence as unlocked, including unreadable URLs", () => {
  assert.equal(
    readSignOutUrlIntent(() => "https://fictional.test/en/players?search=alex"),
    false,
  );
  for (const url of [
    "https://fictional.test/en/players?signout=1",
    "https://fictional.test/en/players?signout=",
    "https://fictional.test/en/players?signout=unknown",
    "invalid URL",
  ])
    assert.equal(
      readSignOutUrlIntent(() => url),
      true,
    );
  assert.equal(
    readSignOutUrlIntent(() => {
      throw new Error("private URL getter");
    }),
    true,
  );
});

test("URL fallback uses the safe localized login route and preserves state, query and hash", () => {
  let url = "https://fictional.test/zh/players?search=Mei%20Lin&page=2#seat-7";
  const state = { fictionalRouter: { preserved: [1, 2] } };
  let replacements = 0;
  assert.equal(
    writeSignOutUrlIntent({
      url: () => url,
      state: () => state,
      replaceState(preserved, unused, next) {
        assert.strictEqual(preserved, state);
        assert.equal(unused, "");
        replacements++;
        url = next;
      },
    }),
    true,
  );
  const parsed = new URL(url);
  assert.equal(replacements, 1);
  assert.equal(parsed.origin, "https://fictional.test");
  assert.equal(parsed.pathname, "/zh/login");
  assert.equal(parsed.searchParams.get("search"), "Mei Lin");
  assert.equal(parsed.searchParams.get("page"), "2");
  assert.equal(parsed.searchParams.get("signout"), "1");
  assert.equal(parsed.hash, "#seat-7");
  assert.deepEqual(state, { fictionalRouter: { preserved: [1, 2] } });
});

test("URL protection stays on the unprotected English or Chinese login route", () => {
  for (const [pathname, expected] of [
    ["/zh/players", "/zh/login"],
    ["/en/reports", "/en/login"],
    ["/other/players", "/en/login"],
    ["/", "/en/login"],
    ["/ZH/players", "/en/login"],
  ]) {
    let url = `https://fictional.test${pathname}?unavailable=1#details`;
    assert.equal(
      writeSignOutUrlIntent({
        url: () => url,
        state: () => null,
        replaceState(_state, _unused, next) {
          url = next;
        },
      }),
      true,
    );
    const saved = new URL(url);
    assert.equal(saved.pathname, expected);
    assert.equal(saved.searchParams.get("unavailable"), "1");
    assert.equal(saved.searchParams.get("signout"), "1");
    assert.equal(saved.hash, "#details");
  }
});

test("blocked, no-op and unverifiable history changes cannot promise reload protection", () => {
  const original = "https://fictional.test/en/players?search=Alex#details";
  for (const failure of [
    "url",
    "state",
    "replace",
    "noop",
    "readback",
  ] as const) {
    let reads = 0;
    assert.equal(
      writeSignOutUrlIntent({
        url: () => {
          if (failure === "url" || (failure === "readback" && ++reads > 1))
            throw new Error("private location failure");
          return original;
        },
        state: () => {
          if (failure === "state") throw new Error("private state failure");
          return null;
        },
        replaceState() {
          if (failure === "replace") throw new Error("private history failure");
        },
      }),
      false,
    );
  }
});
