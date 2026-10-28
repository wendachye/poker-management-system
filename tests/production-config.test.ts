import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { validateProductionConfig } from "../src/server/production-config";

const valid = {
  APP_ORIGIN: "https://operations.example.com",
  DATABASE_URL:
    "postgresql://poker_app:production-secret-example@database.example.com/poker?sslmode=verify-full",
};

test("hosted production configuration validates without any connection", () => {
  assert.deepEqual(validateProductionConfig(valid), {
    origin: valid.APP_ORIGIN,
    databaseUrl: valid.DATABASE_URL,
  });
  assert.equal(
    validateProductionConfig({
      ...valid,
      DATABASE_URL:
        valid.DATABASE_URL.replace("postgresql:", "postgres:") +
        "&application_name=poker",
    }).origin,
    valid.APP_ORIGIN,
  );
});

test("production preflight rejects demos and ambiguous flag values", () => {
  for (const flag of ["NEXT_PUBLIC_POKER_PROTOTYPE", "POKER_PROTOTYPE_MODE"]) {
    for (const value of ["1", "true", "yes"])
      assert.throws(
        () => validateProductionConfig({ ...valid, [flag]: value }),
        /Prototype flags/,
      );
  }
  assert.doesNotThrow(() =>
    validateProductionConfig({
      ...valid,
      NEXT_PUBLIC_POKER_PROTOTYPE: "0",
      POKER_PROTOTYPE_MODE: "",
    }),
  );
});

test("production origin must be exact HTTPS without local hosts or URL extras", () => {
  for (const origin of [
    undefined,
    "",
    "not-a-url",
    "http://operations.example.com",
    "https://operations.example.com/",
    "https://operations.example.com/path",
    "https://operations.example.com?x=1",
    "https://operations.example.com#part",
    "https://user:secret@operations.example.com",
    "https://localhost",
    "https://office.localhost",
    "https://office.local",
    "https://127.0.0.1",
    "https://127.2.3.4",
    "https://2130706433",
    "https://[::1]",
    "https://[::ffff:127.0.0.1]",
    "https://[::ffff:0.0.0.0]",
  ])
    assert.throws(
      () => validateProductionConfig({ ...valid, APP_ORIGIN: origin }),
      /APP_ORIGIN/,
    );
});

test("production database requires remote PostgreSQL and nonlocal credentials", () => {
  for (const url of [
    undefined,
    "",
    "not-a-url",
    valid.DATABASE_URL.replace("postgresql:", "https:"),
    valid.DATABASE_URL.replace("database.example.com", "localhost"),
    valid.DATABASE_URL.replace("database.example.com", "127.1"),
    valid.DATABASE_URL.replace("database.example.com", "[::1]"),
    valid.DATABASE_URL.replace("database.example.com", "[::ffff:0.0.0.0]"),
    valid.DATABASE_URL.replace(
      "database.example.com",
      "database.example.com:0",
    ),
    valid.DATABASE_URL.replace("production-secret-example", "postgres"),
    valid.DATABASE_URL.replace("production-secret-example", "poker_local_only"),
    valid.DATABASE_URL.replace("production-secret-example", "poker_app"),
    valid.DATABASE_URL.replace("poker_app:production-secret-example@", ""),
    valid.DATABASE_URL.replace("/poker?", "/?"),
    valid.DATABASE_URL + "#secret",
  ])
    assert.throws(
      () => validateProductionConfig({ ...valid, DATABASE_URL: url }),
      /DATABASE_URL/,
    );
});

test("production TLS policy is explicit and cannot be replaced through query options", () => {
  for (const mode of [
    "",
    "disable",
    "no-verify",
    "allow",
    "prefer",
    "require",
    "verify-ca",
  ])
    assert.throws(
      () =>
        validateProductionConfig({
          ...valid,
          DATABASE_URL: valid.DATABASE_URL.replace("verify-full", mode),
        }),
      /sslmode=verify-full/,
    );
  for (const option of [
    "sslmode=disable",
    "host=127.0.0.1",
    "ssl=no-verify",
    "sslrootcert=some-private-file",
    "sslcert=some-private-file",
    "sslkey=some-private-file",
    "options=-c%20statement_timeout%3D0",
    "statement_timeout=0",
    "lock_timeout=0",
    "uselibpqcompat=true",
  ])
    assert.throws(
      () =>
        validateProductionConfig({
          ...valid,
          DATABASE_URL: valid.DATABASE_URL + "&" + option,
        }),
      /unique sslmode and application_name/,
    );
  assert.throws(
    () =>
      validateProductionConfig({ ...valid, NODE_TLS_REJECT_UNAUTHORIZED: "0" }),
    /TLS certificate/,
  );
  assert.throws(
    () => validateProductionConfig({ ...valid, PGSSLMODE: "no-verify" }),
    /PGSSLMODE/,
  );
  assert.throws(
    () =>
      validateProductionConfig({
        ...valid,
        PGOPTIONS: "-c statement_timeout=0",
      }),
    /PGOPTIONS/,
  );
});

test("invalid configuration errors do not contain connection secrets", () => {
  const password = "do-not-print-this-password";
  try {
    validateProductionConfig({
      ...valid,
      DATABASE_URL: `postgresql://app:${password}@localhost/poker`,
    });
    assert.fail("Expected rejection");
  } catch (error) {
    assert.ok(error instanceof Error);
    assert.equal(error.message.includes(password), false);
    assert.equal(error.message.includes("postgresql://"), false);
  }
});

test("production preflight rejects invalid database connection and timeout budgets", () => {
  for (const [name, value] of [
    ["DATABASE_POOL_MAX", "0"],
    ["DATABASE_POOL_MAX", "51"],
    ["DATABASE_CONNECTION_TIMEOUT_MS", "never"],
    ["DATABASE_STATEMENT_TIMEOUT_MS", "0"],
    ["DATABASE_LOCK_TIMEOUT_MS", "0"],
    ["DATABASE_IDLE_TIMEOUT_MS", "0"],
    ["DATABASE_IDLE_TRANSACTION_TIMEOUT_MS", "999999"],
  ])
    assert.throws(
      () => validateProductionConfig({ ...valid, [name]: value }),
      new RegExp(name),
    );
  assert.throws(
    () =>
      validateProductionConfig({
        ...valid,
        DATABASE_STATEMENT_TIMEOUT_MS: "1000",
        DATABASE_LOCK_TIMEOUT_MS: "2000",
      }),
    /must not exceed/,
  );
});

test("production check CLI is read-only and reports configuration without printing secrets", () => {
  for (const accepted of [true, false]) {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/check-production.ts"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 20_000,
        env: {
          ...process.env,
          NODE_ENV: "production",
          ...valid,
          NEXT_PUBLIC_POKER_PROTOTYPE: accepted ? "" : "1",
          POKER_PROTOTYPE_MODE: "",
          NODE_TLS_REJECT_UNAUTHORIZED: "1",
          PGSSLMODE: "",
          PGOPTIONS: "",
        },
      },
    );
    assert.equal(result.status, accepted ? 0 : 1, result.stderr);
    assert.equal(
      (result.stdout + result.stderr).includes("production-secret-example"),
      false,
    );
    assert.match(
      accepted ? result.stdout : result.stderr,
      accepted ? /No database connection was opened/ : /Prototype flags/,
    );
  }
});
