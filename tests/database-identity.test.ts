import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "pg";
import {
  DATABASE_IDENTITY_KEYS,
  databasePoolIdentity,
} from "../src/server/database-identity";

test("database identities retain only a stable opaque digest of explicit connection inputs", () => {
  const first = databasePoolIdentity({
    DATABASE_URL: "private-url",
    PGPASSWORD: "private-password",
  });
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(
    first,
    databasePoolIdentity({
      PGPASSWORD: "private-password",
      DATABASE_URL: "private-url",
    }),
  );
  assert.equal(
    first,
    databasePoolIdentity({
      DATABASE_URL: "private-url",
      PGPASSWORD: "private-password",
      UNRELATED_SETTING: "other",
    }),
  );
  assert.doesNotMatch(first, /private/);
  assert.equal(
    new Set(DATABASE_IDENTITY_KEYS).size,
    DATABASE_IDENTITY_KEYS.length,
  );
  assert.equal(Object.isFrozen(DATABASE_IDENTITY_KEYS), true);
  for (const key of DATABASE_IDENTITY_KEYS)
    assert.notEqual(
      databasePoolIdentity({}),
      databasePoolIdentity({ [key]: "changed" }),
      key,
    );
  assert.notEqual(
    databasePoolIdentity({}),
    databasePoolIdentity({ PGPORT: "" }),
  );
});

test("database identity rejects invalid or throwing environment values without echoing secrets", () => {
  for (const env of [
    { DATABASE_URL: { privatePassword: "private-password" } },
    {
      get DATABASE_URL() {
        throw new Error("private-getter-value");
      },
    },
    new Proxy(
      {},
      {
        get() {
          throw new Error("private-getter-value");
        },
      },
    ),
  ])
    assert.throws(
      () =>
        databasePoolIdentity(
          env as Readonly<Record<string, string | undefined>>,
        ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /could not be verified.*Restart/);
        assert.doesNotMatch(error.message, /private/);
        return true;
      },
    );
});

test("the identity tracks real node-postgres port fallback changes when the URL omits its port", () => {
  const original = process.env.PGPORT;
  const connectionString =
    "postgresql://fixture:fictional@127.0.0.1/poker_test";
  const ports: number[] = [],
    identities: string[] = [];
  try {
    for (const port of ["55491", "55492"]) {
      process.env.PGPORT = port;
      const client = new Client({ connectionString });
      // Client construction does not connect. Inspect the driver-resolved port.
      ports.push((client as Client & { port: number }).port);
      identities.push(
        databasePoolIdentity({ DATABASE_URL: connectionString, PGPORT: port }),
      );
    }
  } finally {
    if (original === undefined) delete process.env.PGPORT;
    else process.env.PGPORT = original;
  }
  assert.deepEqual(ports, [55491, 55492]);
  assert.notEqual(identities[0], identities[1]);
});
