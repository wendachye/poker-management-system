import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";
import {
  maintenancePoolOptions,
  nativeMaintenanceMessage,
} from "../scripts/local-postgres-maintenance";

const target =
  "postgresql://fictional:private-maintenance-password@127.0.0.1:55440/poker_local_sample";

function withEnvironment(
  values: Record<string, string | undefined>,
  work: () => void,
) {
  const previous = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    work();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("native maintenance uses one connection and deliberate server/client budgets", () => {
  withEnvironment({ PGOPTIONS: undefined }, () => {
    assert.deepEqual(maintenancePoolOptions(target), {
      max: 1,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 10000,
      statement_timeout: 60000,
      lock_timeout: 5000,
      idle_in_transaction_session_timeout: 15000,
      query_timeout: 65000,
      options:
        "-c statement_timeout=60000 -c lock_timeout=5000 -c idle_in_transaction_session_timeout=15000",
    });
  });
});

test("routine environment budgets cannot disable or enlarge maintenance limits", () => {
  withEnvironment(
    {
      PGOPTIONS: "",
      DATABASE_URL: "private-invalid-global-url",
      DATABASE_POOL_MAX: "50",
      DATABASE_CONNECTION_TIMEOUT_MS: "0",
      DATABASE_IDLE_TIMEOUT_MS: "0",
      DATABASE_STATEMENT_TIMEOUT_MS: "0",
      DATABASE_LOCK_TIMEOUT_MS: "0",
      DATABASE_IDLE_TRANSACTION_TIMEOUT_MS: "0",
    },
    () => {
      const options = maintenancePoolOptions(target);
      assert.equal(options.max, 1);
      assert.equal(options.connectionTimeoutMillis, 5000);
      assert.equal(options.statement_timeout, 60000);
      assert.equal(options.lock_timeout, 5000);
      assert.equal(options.idle_in_transaction_session_timeout, 15000);
      assert.equal(options.query_timeout, 65000);
    },
  );
});

test("maintenance refuses URL timeout overrides and PGOPTIONS without echoing credentials", () => {
  withEnvironment({ PGOPTIONS: undefined }, () => {
    assert.throws(
      () => maintenancePoolOptions(""),
      /guarded database connection/,
    );
    for (const key of [
      "options",
      "OPTIONS",
      "%6fptions",
      "statement_timeout",
      "lock_timeout",
      "idle_in_transaction_session_timeout",
      "query_timeout",
    ]) {
      assert.throws(
        () => maintenancePoolOptions(`${target}?${key}=0`),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /cannot override/);
          assert.equal(
            error.message.includes("private-maintenance-password"),
            false,
          );
          return true;
        },
      );
    }
    assert.throws(
      () => maintenancePoolOptions("private-invalid-supplied-url"),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(
          error.message.includes("private-invalid-supplied-url"),
          false,
        );
        return true;
      },
    );
  });
  withEnvironment(
    { PGOPTIONS: "-c statement_timeout=0 private-option" },
    () => {
      assert.throws(
        () => maintenancePoolOptions(target),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /PGOPTIONS/);
          assert.equal(error.message.includes("private-option"), false);
          return true;
        },
      );
    },
  );
});

test("explicit pg startup options block later environment fallback without changing search path", () => {
  withEnvironment({ PGOPTIONS: undefined }, () => {
    const options = maintenancePoolOptions(target);
    withEnvironment(
      { PGOPTIONS: "-c statement_timeout=0 -c search_path=private" },
      () => {
        // Constructing a Client reads pg's actual connection parameters but does
        // not open any connection or contact the native local database.
        const client = new Client({ connectionString: target, ...options });
        const connection = client as unknown as {
          connectionParameters: {
            options: string;
            statement_timeout: number;
            lock_timeout: number;
            idle_in_transaction_session_timeout: number;
            query_timeout: number;
          };
        };
        assert.equal(connection.connectionParameters.options, options.options);
        assert.equal(
          connection.connectionParameters.options.includes("search_path"),
          false,
        );
        assert.equal(connection.connectionParameters.statement_timeout, 60000);
        assert.equal(connection.connectionParameters.lock_timeout, 5000);
        assert.equal(
          connection.connectionParameters.idle_in_transaction_session_timeout,
          15000,
        );
        assert.equal(connection.connectionParameters.query_timeout, 65000);
      },
    );
  });
});

test("recognized maintenance failures receive actionable fixed feedback without driver details", () => {
  const cases = [
    ["55P03", /lock within five seconds/],
    ["57014", /cancelled or exceeded its statement budget/],
    ["ECONNREFUSED", /database connection/],
    ["ETIMEDOUT", /database connection/],
    ["57P03", /database connection/],
  ] as const;
  for (const [code, expected] of cases) {
    const message = nativeMaintenanceMessage(
      Object.assign(new Error(`private-maintenance-password ${target}`), {
        code,
      }),
    );
    assert.ok(message);
    assert.match(message, expected);
    assert.match(message, /retry/);
    assert.equal(message.includes("private-maintenance-password"), false);
    assert.equal(message.includes(target), false);
  }
});

test("maintenance recognizes exact client deadlines while preserving unknown failures", () => {
  for (const [driverMessage, expected] of [
    ["Query read timeout", /query result within its deadline/],
    ["timeout exceeded when trying to connect", /database connection/],
    ["Connection terminated due to connection timeout", /database connection/],
  ] as const) {
    const message = nativeMaintenanceMessage(new Error(driverMessage));
    assert.ok(message);
    assert.match(message, expected);
    assert.notEqual(message, driverMessage);
  }
  for (const error of [
    null,
    undefined,
    "private failure",
    new Error("Query read timeout with private details"),
    Object.assign(new Error("private constraint"), { code: "23505" }),
    { code: "unrecognized-private-code" },
  ])
    assert.equal(nativeMaintenanceMessage(error), null);
});

test("maintenance failure mapping cannot throw through unusual error accessors", () => {
  const throwingMessage = Object.create(Error.prototype);
  Object.defineProperty(throwingMessage, "message", {
    get() {
      throw new Error("private message accessor");
    },
  });
  const throwingCode = Object.defineProperty({}, "code", {
    get() {
      throw new Error("private code accessor");
    },
  });
  const throwingProxy = new Proxy(
    {},
    {
      has() {
        throw new Error("private has trap");
      },
    },
  );
  for (const error of [throwingMessage, throwingCode, throwingProxy]) {
    assert.doesNotThrow(() => nativeMaintenanceMessage(error));
    assert.equal(nativeMaintenanceMessage(error), null);
  }
  let codeReads = 0;
  const changingCode = Object.defineProperty({}, "code", {
    get() {
      codeReads++;
      return codeReads === 1 ? "55P03" : "private-later-code";
    },
  });
  assert.match(nativeMaintenanceMessage(changingCode)!, /database lock/);
  assert.equal(codeReads, 1);
});
