import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { once } from "node:events";
import path from "node:path";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { after, before, test } from "node:test";
import { Pool } from "pg";
import type { Command } from "../src/domain/commands";
import type { LocationCommand } from "../src/domain/locations";
import type {
  EntryType,
  Snapshot,
  Store,
  Player,
  Transaction,
  AuditLog,
} from "../src/domain/model";
import type { ReadPage } from "../src/domain/read-model";
import {
  currentDay,
  debt,
  emptyStore,
  totalsForDay,
} from "../src/domain/selectors";
import { defaultSettings } from "../src/domain/settings";
import type { StaffAccount, StaffCommand } from "../src/domain/staff";
import { hashPassword } from "../src/server/auth";
import { databaseFromPool } from "../src/server/database";
import { migrate } from "../src/server/schema";
import { importStore, readStore } from "../src/server/storage";
import {
  decodeExportAccess,
  encodeExportAccess,
  EXPORT_ACCESS_HEADER,
  type ExportAccess,
} from "../src/lib/export-access";

// This suite deliberately does not load .env or use DATABASE_URL. The caller
// must supply a disposable PostgreSQL cluster; existing venue roles and schemas
// are never changed. A private login role gives Next its own default search_path
// without weakening the application's ban on PGOPTIONS/startup overrides.
function disposableTarget(value: string | undefined) {
  const message =
    "POSTGRES_TEST_DATABASE_URL must explicitly name a loopback PostgreSQL database poker_test or poker_test_* without query overrides.";
  if (!value) throw new Error(message);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(message);
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    !/^\/poker_test(?:_[a-z0-9_]+)?$/.test(url.pathname) ||
    url.search ||
    url.hash
  )
    throw new Error(message);
  return { url, database: url.pathname.slice(1) };
}

const target = disposableTarget(process.env.POSTGRES_TEST_DATABASE_URL);
const suffix = randomBytes(8).toString("hex");
const ownedName = `poker_test_http_${suffix}`;
assert.match(ownedName, /^poker_test_http_[a-f0-9]{16}$/);
const identifier = `"${ownedName}"`;
const loginSecret = randomBytes(32).toString("hex");
const password = "fictional-http-workflow-password";
const workDirectory = path.resolve(".local", `operations-http-${suffix}`);
const applicationUrl = new URL(target.url);
applicationUrl.username = ownedName;
applicationUrl.password = loginSecret;
const administrator = new Pool({
  connectionString: target.url.href,
  max: 1,
  connectionTimeoutMillis: 5_000,
  statement_timeout: 15_000,
  lock_timeout: 5_000,
  query_timeout: 20_000,
  options: "-c search_path=pg_catalog",
  application_name: `poker-http-admin-${suffix}`,
});
const fixturePool = new Pool({
  connectionString: applicationUrl.href,
  max: 1,
  connectionTimeoutMillis: 5_000,
  statement_timeout: 15_000,
  lock_timeout: 5_000,
  query_timeout: 20_000,
  application_name: `poker-http-fixture-${suffix}`,
});
for (const pool of [administrator, fixturePool])
  pool.on("error", () => {
    assert.fail("The disposable HTTP-test database pool failed.");
  });
let createdRole = false;
let createdSchema = false;
let application: ChildProcess | undefined;
let origin = "";
let serverLog: ReturnType<typeof createWriteStream> | undefined;

async function freePort() {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    probe.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

async function stopApplication() {
  if (
    !application?.pid ||
    application.exitCode !== null ||
    application.signalCode !== null
  )
    return;
  const stopped = once(application, "exit").catch(() => {});
  if (process.platform === "win32") {
    // Kill only this child and its own Next dev descendants, never user servers.
    try {
      execFileSync("taskkill", ["/PID", String(application.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    } catch {
      if (application.exitCode === null) application.kill("SIGKILL");
    }
  } else {
    try {
      process.kill(-application.pid, "SIGTERM");
    } catch {
      application.kill("SIGTERM");
    }
  }
  await Promise.race([
    stopped,
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5_000);
      timer.unref();
    }),
  ]);
}

before(async () => {
  assert.equal(
    (
      await administrator.query<{ name: string }>(
        "SELECT current_database() AS name",
      )
    ).rows[0].name,
    target.database,
  );
  // The generated password is hex only; identifiers are validated above.
  await administrator.query(
    `CREATE ROLE ${identifier} LOGIN PASSWORD '${loginSecret}'`,
  );
  createdRole = true;
  await administrator.query(
    `CREATE SCHEMA ${identifier} AUTHORIZATION ${identifier}`,
  );
  createdSchema = true;
  await administrator.query(
    `ALTER ROLE ${identifier} IN DATABASE "${target.database}" SET search_path TO ${identifier}`,
  );
  const identity = (
    await fixturePool.query<{ name: string; role: string }>(
      "SELECT current_schema() AS name,current_user AS role",
    )
  ).rows[0];
  assert.deepEqual(identity, { name: ownedName, role: ownedName });
  const db = databaseFromPool(fixturePool);
  await migrate(db);
  await db.query(
    "INSERT INTO poker_branches(id,name,timezone) VALUES('http-venue','HTTP Sample Venue','Asia/Kuala_Lumpur')",
  );
  await importStore(db, "http-venue", emptyStore());
  await db.query(
    "INSERT INTO poker_users(id,username,password_hash) VALUES('http-owner','http.admin',$1)",
    [await hashPassword(password)],
  );
  await db.query(
    "INSERT INTO poker_memberships(user_id,branch_id,role) VALUES('http-owner','http-venue','ADMIN')",
  );
  await mkdir(workDirectory, { recursive: true });
  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  serverLog = createWriteStream(path.join(workDirectory, "server.log"));
  application = spawn(
    process.execPath,
    [
      "node_modules/next/dist/bin/next",
      "dev",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    {
      cwd: process.cwd(),
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        NODE_ENV: "development",
        DATABASE_URL: applicationUrl.href,
        PGOPTIONS: "",
        APP_ORIGIN: origin,
        POKER_PROTOTYPE_MODE: "0",
        NEXT_PUBLIC_POKER_PROTOTYPE: "0",
        NEXT_TELEMETRY_DISABLED: "1",
        NEXT_DIST_DIR: `.local/operations-http-next-${suffix}`,
      },
    },
  );
  application.stdout!.pipe(serverLog);
  application.stderr!.pipe(serverLog);
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    assert.equal(
      application.exitCode,
      null,
      "The isolated Next server exited before readiness.",
    );
    try {
      const response = await fetch(`${origin}/api/health`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (response.status === 200) {
        assert.deepEqual(await response.json(), {
          status: "ok",
          mode: "operations",
        });
        return;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.fail(
    `Isolated Next readiness timed out; inspect ${path.join(workDirectory, "server.log")}.`,
  );
});

after(async () => {
  try {
    await stopApplication();
    serverLog?.end();
    await fixturePool.end();
    if (createdSchema)
      await administrator.query(`DROP SCHEMA ${identifier} CASCADE`);
    if (createdRole) await administrator.query(`DROP ROLE ${identifier}`);
  } finally {
    await administrator.end();
  }
});

type JsonObject = Record<string, unknown>;
async function waitForHealth(status: number, headers?: Record<string, string>) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const response = await fetch(origin + "/api/health", {
      signal: AbortSignal.timeout(4000),
      headers,
    });
    if (response.status === status) return response;
    await response.arrayBuffer();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(
    "Readiness did not reach the expected state within its bounded cache window.",
  );
}
class StaffBrowser {
  private cookie = "";

  async response(
    route: string,
    method = "GET",
    value?: unknown,
    extraHeaders?: Record<string, string>,
  ) {
    const response = await fetch(origin + route, {
      method,
      headers: {
        ...(this.cookie ? { Cookie: this.cookie } : {}),
        ...(method !== "GET"
          ? { Origin: origin, "Content-Type": "application/json" }
          : {}),
        ...extraHeaders,
      },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    });
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.ok(
      response.headers.get("x-request-id"),
      "Every staff response needs a request ID.",
    );
    const cookies = response.headers.getSetCookie();
    for (const cookie of cookies) {
      if (cookie.startsWith("poker_session=")) {
        this.cookie = cookie.split(";")[0];
        if (method === "POST" && route === "/api/auth") {
          assert.match(cookie, /HttpOnly/i);
          assert.match(cookie, /SameSite=strict/i);
        }
      }
    }
    return { response, data: (await response.json()) as JsonObject };
  }

  async json<T>(route: string, method = "GET", value?: unknown, status = 200) {
    const { response, data } = await this.response(route, method, value);
    assert.equal(
      response.status,
      status,
      typeof data.error === "string" ? data.error : route,
    );
    return data as T;
  }

  async signIn(username: string) {
    await this.json("/api/auth", "POST", { username, password });
    return this.json<{
      user: Snapshot["user"];
      branches: Snapshot["branch"][];
    }>("/api/auth");
  }

  snapshot() {
    return this.json<Snapshot>("/api/state");
  }

  document(route: string) {
    return fetch(origin + route, {
      headers: this.cookie ? { Cookie: this.cookie } : {},
      redirect: "manual",
      signal: AbortSignal.timeout(20000),
    });
  }

  partialUpload(route: string, fragment: string) {
    const started = performance.now();
    let close!: () => void;
    let drip!: () => void;
    let finish!: () => void;
    const result = new Promise<{
      status: number;
      headers: IncomingHttpHeaders;
      data: JsonObject;
      elapsedMs: number;
    }>((resolve, reject) => {
      const client = httpRequest(origin + route, {
        method: "POST",
        headers: {
          ...(this.cookie ? { Cookie: this.cookie } : {}),
          Origin: origin,
          "Content-Type": "application/json",
          "Transfer-Encoding": "chunked",
        },
      });
      const watchdog = setTimeout(() => {
        client.destroy(
          new Error("The stalled-upload test exceeded its budget."),
        );
      }, 18_000);
      close = () => {
        clearTimeout(watchdog);
        client.destroy();
      };
      drip = () => client.write(" ");
      finish = () => client.end();
      client.once("error", (error) => {
        clearTimeout(watchdog);
        reject(error);
      });
      client.once("response", (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          text += chunk;
        });
        response.once("error", reject);
        response.once("end", () => {
          clearTimeout(watchdog);
          try {
            resolve({
              status: response.statusCode!,
              headers: response.headers,
              data: JSON.parse(text) as JsonObject,
              elapsedMs: performance.now() - started,
            });
          } catch (error) {
            reject(error);
          }
        });
      });
      client.write(fragment);
    });
    // Preserve the rejection for the test while a concurrent normal request runs.
    void result.catch(() => {});
    return { result, drip, finish, close };
  }

  csvResponse(
    route: string,
    access: ExportAccess,
    signal = AbortSignal.timeout(30_000),
  ) {
    return fetch(origin + route, {
      headers: {
        Cookie: this.cookie,
        [EXPORT_ACCESS_HEADER]: encodeExportAccess(access),
      },
      signal,
      redirect: "error",
    });
  }

  async csv(route: string, access: ExportAccess) {
    const response = await this.csvResponse(route, access);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(response.headers.get("content-type") ?? "", /^text\/csv/);
    assert.ok(response.headers.get("x-request-id"));
    assert.deepEqual(
      decodeExportAccess(response.headers.get(EXPORT_ACCESS_HEADER)),
      access,
    );
    return response.text();
  }

  async execute(
    command: Command | StaffCommand | LocationCommand,
    endpoint = "/api/state",
    status = 200,
  ) {
    const before = await this.snapshot();
    return this.json<Snapshot>(
      endpoint,
      "POST",
      {
        branchId: before.branch.id,
        actorId: before.user.id,
        revision: before.revision,
        operationId: randomUUID(),
        command,
      },
      status,
    );
  }
}

test(
  "staff use real HTTP routes and isolated PostgreSQL for a complete operational day",
  { timeout: 240_000 },
  async (t) => {
    const admin = new StaffBrowser();
    const manager = new StaffBrowser();
    const cashier = new StaffBrowser();
    const dealer = new StaffBrowser();
    let mainTable = "";
    let reserveTable = "";
    let cashPlayer = "";
    let creditPlayer = "";
    let rejectedId = "";
    let originalRakeId = "";
    let finalSnapshot: Snapshot;

    async function request(
      type: EntryType,
      amount: number,
      playerId?: string,
      submitter = cashier,
    ) {
      const result = await submitter.execute({
        kind: "REQUEST",
        type,
        amount,
        playerId,
        tableId: [
          "Rake",
          "Tips",
          "Insurance Premium",
          "Insurance Payout",
          "Jackpot Contribution",
          "Jackpot Payout",
        ].includes(type)
          ? mainTable
          : undefined,
        note: `Fictional HTTP ${type}`,
      });
      return result.store.approvals[0].id;
    }
    async function approve(id: string, reviewer = manager) {
      return reviewer.execute({
        kind: "DECIDE",
        approvalId: id,
        decision: "APPROVED",
      });
    }

    await t.test(
      "login cookies, origin validation and permission failures are wired through HTTP",
      async () => {
        await new StaffBrowser().json("/api/state", "GET", undefined, 401);
        const badOrigin = await admin.response(
          "/api/auth",
          "POST",
          { username: "http.admin", password },
          { Origin: "https://unrelated.invalid" },
        );
        assert.equal(badOrigin.response.status, 403);
        const wrongMedia = await admin.response(
          "/api/auth",
          "POST",
          { username: "http.admin", password },
          { "Content-Type": "text/plain" },
        );
        assert.equal(wrongMedia.response.status, 415);
        const signedIn = await admin.signIn("http.admin");
        assert.equal(signedIn.user.role, "ADMIN");
        assert.equal(signedIn.branches.length, 1);
      },
    );

    await t.test(
      "staff, venue rules, flexible tables and location settings persist through their real routes",
      async () => {
        for (const [username, role] of [
          ["http.cashier", "CASHIER"],
          ["http.manager", "MANAGER"],
          ["http.dealer", "DEALER"],
        ] as const) {
          await admin.execute(
            {
              kind: "STAFF_CREATE",
              username,
              password,
              role,
              reason: "Fictional HTTP test staffing",
            },
            "/api/staff",
          );
        }
        const accounts = await admin.json<{ accounts: StaffAccount[] }>(
          "/api/staff",
        );
        assert.equal(accounts.accounts.length, 4);
        await cashier.signIn("http.cashier");
        await manager.signIn("http.manager");
        await dealer.signIn("http.dealer");
        await cashier.json("/api/staff", "GET", undefined, 403);
        const { setupCompleted: _, ...settings } = defaultSettings();
        void _;
        await admin.execute({
          kind: "UPDATE_SETTINGS",
          settings: {
            ...settings,
            venueName: "HTTP Sample Venue",
            smallBlind: 500,
            bigBlind: 1000,
            minBuyIn: 20_000,
            maxBuyIn: 500_000,
            buyInStep: 5_000,
          },
          reason: "Fictional HTTP venue rules",
        });
        mainTable = (
          await admin.execute({
            kind: "TABLE",
            name: "Main 5/10",
            dealer: "",
            status: "OPEN",
          })
        ).store.tables[0].id;
        reserveTable = (
          await admin.execute({
            kind: "TABLE",
            name: "Reserve 10/25",
            dealer: "",
            status: "OPEN",
            smallBlind: 1000,
            bigBlind: 2500,
            minBuyIn: 50_000,
            maxBuyIn: 1_000_000,
            buyInStep: 5_000,
          })
        ).store.tables.find((table) => table.name === "Reserve 10/25")!.id;
        await admin.execute(
          {
            kind: "CREATE_LOCATION",
            id: "http-other",
            name: "HTTP Other Venue",
            timezone: "Asia/Kuala_Lumpur",
          },
          "/api/locations",
        );
        assert.equal(
          (await admin.json<{ branches: unknown[] }>("/api/locations")).branches
            .length,
          2,
        );
        await admin.execute({ kind: "COMPLETE_SETUP" });
        const opened = await manager.execute({
          kind: "OPEN_DAY",
          date: "2026-10-28",
          openingCash: 1_000_000,
        });
        assert.equal(currentDay(opened.store)?.status, "OPEN");
        assert.equal(
          (await cashier.snapshot()).store.settings?.smallBlind,
          500,
        );
      },
    );

    await t.test(
      "cash/credit check-in, duplicate identity, occupied seats, moves and swaps stay consistent across sessions",
      async () => {
        const cashCheckIn: Command = {
          kind: "CHECK_IN",
          name: "HTTP Cash Player",
          phone: "+12025550111",
          type: "CASH",
          creditLimit: 0,
          tags: [],
          tableId: mainTable,
          seat: 1,
        };
        const cash = await cashier.execute(cashCheckIn);
        cashPlayer = cash.store.profiles.find(
          (player) => player.name === "HTTP Cash Player",
        )!.id;
        await cashier.execute(
          {
            ...cashCheckIn,
            name: "Wrong duplicate",
            phone: "+1 (202) 555-0111",
            seat: 3,
          },
          "/api/state",
          400,
        );
        await cashier.execute(
          { ...cashCheckIn, name: "Occupied Seat", phone: "+12025550112" },
          "/api/state",
          400,
        );
        const credit = await manager.execute({
          ...cashCheckIn,
          name: "HTTP Credit Player",
          phone: "+12025550113",
          type: "CREDIT",
          creditLimit: 100_000,
          seat: 2,
        });
        creditPlayer = credit.store.profiles.find(
          (player) => player.name === "HTTP Credit Player",
        )!.id;
        const moved = await cashier.execute({
          kind: "MOVE",
          playerId: cashPlayer,
          tableId: reserveTable,
          seat: 3,
        });
        const participant = (playerId: string) => {
          const visit = moved.store.sessions.find(
            (session) =>
              session.playerId === playerId && session.status === "ACTIVE",
          )!;
          return {
            playerId,
            sessionId: visit.id,
            tableId: visit.tableId,
            seat: visit.seat,
          };
        };
        await cashier.execute({
          kind: "SWAP_SEATS",
          first: participant(cashPlayer),
          second: participant(creditPlayer),
        });
        const anotherStaff = await manager.snapshot();
        assert.equal(anotherStaff.store.profiles.length, 2);
        assert.equal(
          anotherStaff.store.sessions.find(
            (session) => session.playerId === creditPlayer,
          )?.tableId,
          reserveTable,
        );
        assert.equal(
          anotherStaff.store.sessions.find(
            (session) => session.playerId === cashPlayer,
          )?.seat,
          2,
        );
        await manager.execute({
          kind: "UPDATE_PROFILE",
          playerId: cashPlayer,
          name: "HTTP Cash Player Updated",
          tags: ["VIP"],
          creditLimit: 0,
          reason: "Fictional profile update",
        });
        assert.equal(
          (await cashier.snapshot()).store.profiles.find(
            (player) => player.id === cashPlayer,
          )?.name,
          "HTTP Cash Player Updated",
        );
      },
    );

    await t.test(
      "buy-ins require independent approval and identical operation retries post once",
      async () => {
        const before = await cashier.snapshot();
        const payload = {
          branchId: before.branch.id,
          revision: before.revision,
          operationId: randomUUID(),
          command: {
            kind: "REQUEST",
            type: "Buy-in",
            amount: 50_000,
            playerId: cashPlayer,
            note: "Fictional idempotent cash buy-in",
          },
        };
        const first = await cashier.json<Snapshot>(
          "/api/state",
          "POST",
          payload,
        );
        const retry = await cashier.json<Snapshot>(
          "/api/state",
          "POST",
          payload,
        );
        assert.equal(retry.revision, first.revision);
        assert.equal(
          retry.store.approvals.filter(
            (item) => item.note === payload.command.note,
          ).length,
          1,
        );
        assert.equal(retry.store.transactions.length, 0);
        await cashier.execute(
          {
            kind: "DECIDE",
            approvalId: first.store.approvals[0].id,
            decision: "APPROVED",
          },
          "/api/state",
          403,
        );
        await approve(first.store.approvals[0].id);
        const posted = await approve(
          await request("Buy-in", 50_000, creditPlayer),
        );
        assert.equal(debt(posted.store, creditPlayer), 50_000);
        assert.equal(totalsForDay(posted.store).cashReceived, 50_000);
        await manager.execute(
          { kind: "CLOSE_DAY", countedCash: 1_050_000, reason: "" },
          "/api/state",
          400,
        );
      },
    );

    await t.test(
      "unrelated edits merge and same-table stale edits return a recoverable conflict",
      async () => {
        const before = await admin.snapshot();
        const command: Command = {
          kind: "TABLE",
          tableId: mainTable,
          name: "Main 5/10 Updated",
          dealer: "",
          status: "OPEN",
        };
        const payload = {
          branchId: before.branch.id,
          revision: before.revision,
          operationId: randomUUID(),
          command,
        };
        await manager.execute({
          kind: "UPDATE_PROFILE",
          playerId: cashPlayer,
          name: "HTTP Cash Player Updated",
          tags: ["VIP", "Risk"],
          creditLimit: 0,
          reason: "Fictional concurrent staff update",
        });
        const saved = await admin.json<Snapshot>("/api/state", "POST", payload);
        assert.equal(
          saved.store.tables.find((table) => table.id === mainTable)?.name,
          command.name,
        );
        assert.deepEqual(
          saved.store.profiles.find((profile) => profile.id === cashPlayer)
            ?.tags,
          ["VIP", "Risk"],
        );
        const conflicting = {
          ...payload,
          operationId: randomUUID(),
          revision: saved.revision,
          command: { ...command, name: "Conflicting name" },
        };
        await manager.execute({
          ...command,
          name: "Most recent reviewed name",
        });
        await admin.json("/api/state", "POST", conflicting, 409);
        assert.equal(
          (await admin.snapshot()).store.tables.find(
            (table) => table.id === mainTable,
          )?.name,
          "Most recent reviewed name",
        );
      },
    );

    await t.test(
      "rejections, corrections and reversal approvals preserve the original ledger",
      async () => {
        rejectedId = await request("Buy-in", 50_000, cashPlayer);
        await manager.execute({
          kind: "DECIDE",
          approvalId: rejectedId,
          decision: "REJECTED",
          reason: "Duplicate fictional slip",
        });
        const rake = await approve(
          await request("Rake", 5_000, undefined, dealer),
        );
        const original = rake.store.transactions.find(
          (entry) => entry.type === "Rake",
        )!;
        originalRakeId = original.id;
        const correction = await cashier.execute({
          kind: "CORRECT",
          transactionId: original.id,
          reason: "Wrong fictional rake amount",
        });
        await manager.execute(
          {
            kind: "DECIDE",
            approvalId: correction.store.approvals[0].id,
            decision: "APPROVED",
          },
          "/api/state",
          403,
        );
        const reversed = await approve(correction.store.approvals[0].id, admin);
        assert.deepEqual(
          reversed.store.transactions.find((entry) => entry.id === original.id),
          original,
        );
        assert.equal(
          reversed.store.transactions.find(
            (entry) => entry.reversesId === original.id,
          )?.cashReceived,
          -5_000,
        );
        await cashier.execute(
          {
            kind: "CORRECT",
            transactionId: original.id,
            reason: "Duplicate fictional reversal",
          },
          "/api/state",
          400,
        );
        await approve(await request("Rake", 3_000, undefined, dealer));
        for (const [type, amount] of [
          ["Tips", 1000],
          ["Insurance Premium", 2000],
          ["Insurance Payout", 500],
          ["Jackpot Contribution", 1500],
          ["Jackpot Payout", 1000],
          ["Cash Received", 10_000],
          ["Cash Payout", 2000],
        ] as const) {
          await approve(
            await request(type, amount),
            type.endsWith("Payout") ? admin : manager,
          );
        }
        const summary = totalsForDay((await admin.snapshot()).store);
        assert.equal(summary.rake, 3_000);
        assert.equal(summary.tips, 1000);
        assert.equal(summary.insurance, 1500);
        assert.equal(summary.jackpot, 500);
      },
    );

    await t.test(
      "repayment and cash-out settle debt and post the reviewed cash payout once",
      async () => {
        const repaid = await approve(
          await request("Credit Repayment", 20_000, creditPlayer),
        );
        assert.equal(debt(repaid.store, creditPlayer), 30_000);
        await approve(await request("Cash-out", 70_000, cashPlayer), admin);
        const creditOutId = await request("Cash-out", 80_000, creditPlayer);
        await approve(creditOutId, admin);
        const posted = await cashier.snapshot();
        assert.equal(debt(posted.store, creditPlayer), 0);
        assert.equal(
          posted.store.transactions.find(
            (entry) => entry.approvalId === creditOutId,
          )?.cashPayout,
          50_000,
        );
        assert.equal(
          posted.store.transactions.find(
            (entry) => entry.approvalId === creditOutId,
          )?.creditDelta,
          -30_000,
        );
        assert.equal(
          posted.store.sessions.filter((session) => session.status === "ACTIVE")
            .length,
          0,
        );
        await approve(creditOutId, admin).then(
          () => assert.fail("A second decision must not post again."),
          (error: unknown) =>
            assert.match(String(error), /Independent authorized review/),
        );
        assert.equal(
          (await cashier.snapshot()).store.transactions.filter(
            (entry) => entry.approvalId === creditOutId,
          ).length,
          1,
        );
      },
    );

    await t.test(
      "closing variance, reopening, new login and database persistence agree",
      async () => {
        const before = await admin.snapshot();
        assert.equal(
          before.store.approvals.some((entry) => entry.status === "PENDING"),
          false,
        );
        const expected = totalsForDay(before.store).expectedCash;
        assert.equal(expected, 964_000);
        await manager.execute(
          {
            kind: "CLOSE_DAY",
            dayId: currentDay(before.store)!.id,
            countedCash: expected - 1000,
            reason: "",
          },
          "/api/state",
          400,
        );
        const closed = await manager.execute({
          kind: "CLOSE_DAY",
          dayId: currentDay(before.store)!.id,
          countedCash: expected - 1000,
          reason: "Fictional RM10 count difference",
        });
        assert.equal(currentDay(closed.store)?.closes.at(-1)?.variance, -1000);
        await dealer.execute(
          {
            kind: "REQUEST",
            type: "Tips",
            amount: 100,
            tableId: mainTable,
            note: "Closed day request",
          },
          "/api/state",
          400,
        );
        await manager.execute(
          { kind: "REOPEN_DAY", reason: "Fictional manager reopening" },
          "/api/state",
          403,
        );
        await admin.execute({
          kind: "REOPEN_DAY",
          reason: "Fictional admin recount",
        });
        finalSnapshot = await manager.execute({
          kind: "CLOSE_DAY",
          countedCash: expected,
          reason: "",
        });
        assert.equal(currentDay(finalSnapshot.store)?.closes.length, 2);
        assert.equal(totalsForDay(finalSnapshot.store).variance, 0);
        const freshBrowser = new StaffBrowser();
        await freshBrowser.signIn("http.manager");
        assert.deepEqual(await freshBrowser.snapshot(), finalSnapshot);
        const stored = {
          revision: (
            await fixturePool.query<{ revision: number }>(
              "SELECT revision FROM poker_branch_state WHERE branch_id='http-venue'",
            )
          ).rows[0].revision,
          data: await readStore(databaseFromPool(fixturePool), "http-venue"),
        };
        assert.equal(stored.revision, finalSnapshot.revision);
        // Compact receipts deliberately omit audit history and may omit records
        // from other pages. Compare authoritative totals/day/balances, then
        // inspect the full indexed ledger below for retained historical records.
        assert.deepEqual(
          totalsForDay(stored.data),
          totalsForDay(finalSnapshot.store),
        );
        assert.deepEqual(stored.data.days, finalSnapshot.store.days);
        for (const profile of stored.data.profiles)
          assert.equal(
            debt(stored.data, profile.id),
            debt(finalSnapshot.store, profile.id),
          );
        assert.equal(
          stored.data.approvals.find((entry) => entry.id === rejectedId)
            ?.rejectionReason,
          "Duplicate fictional slip",
        );
        assert.equal(
          stored.data.transactions.filter(
            (entry) => entry.reversesId === originalRakeId,
          ).length,
          1,
        );
        assert.ok(
          stored.data.auditLogs.some((entry) => entry.action === "Closed day"),
        );
      },
    );

    await t.test(
      "venue switching isolates records, rejects stale tabs and logout revokes the session",
      async () => {
        await cashier.json(
          "/api/branch",
          "POST",
          { branchId: "http-other" },
          403,
        );
        const before = await admin.snapshot();
        await admin.json("/api/branch", "POST", { branchId: "http-other" });
        const other = await admin.snapshot();
        assert.equal(other.branch.id, "http-other");
        assert.equal(other.store.transactions.length, 0);
        assert.equal(other.store.profiles.length, 0);
        await admin.json(
          "/api/state",
          "POST",
          {
            branchId: before.branch.id,
            revision: before.revision,
            operationId: randomUUID(),
            command: {
              kind: "TABLE",
              name: "Stale venue table",
              dealer: "",
              status: "OPEN",
            },
          },
          409,
        );
        await admin.json("/api/branch", "POST", { branchId: "http-venue" });
        assert.deepEqual((await admin.snapshot()).store, finalSnapshot.store);
        await cashier.json("/api/auth", "DELETE", {});
        await cashier.json("/api/auth", "GET", undefined, 401);
        await cashier.json("/api/state", "GET", undefined, 401);
      },
    );

    await t.test(
      "authenticated server pagination, search, page caps and complete CSV stay venue scoped",
      async () => {
        const before = await admin.snapshot();
        const accounts = await admin.json<{ accounts: StaffAccount[] }>(
          "/api/staff",
        );
        const requester = accounts.accounts.find(
          (account) => account.username === "http.cashier",
        )!;
        assert.ok(requester);
        await admin.execute(
          {
            kind: "CREATE_LOCATION",
            id: "http-pages",
            name: "HTTP Pagination Venue",
            timezone: "Asia/Kuala_Lumpur",
          },
          "/api/locations",
        );
        const fixture: Store = {
          ...emptyStore(),
          settings: {
            ...defaultSettings(),
            setupCompleted: true,
            venueName: "HTTP Pagination Venue",
          },
          currentDayId: "page-day",
          days: [
            {
              id: "page-day",
              date: "2026-10-28",
              status: "OPEN",
              openedAt: "2026-10-28T00:00:00.000Z",
              openingCash: 1_000_000,
              closes: [],
            },
          ],
          tables: [
            {
              id: "page-table",
              name: "Pagination table",
              dealer: "",
              status: "OPEN",
            },
          ],
        };
        for (let index = 0; index < 45; index++) {
          const time = new Date(
            Date.parse("2026-10-28T01:00:00.000Z") + index * 60_000,
          ).toISOString();
          fixture.profiles.push({
            id: "page-player-" + index,
            name: "Pagination player " + index,
            phone: "+6013" + String(index).padStart(7, "0"),
            type: "CASH",
            creditLimit: 0,
            tags: [],
          });
          fixture.sessions.push({
            id: "page-visit-" + index,
            playerId: "page-player-" + index,
            dayId: "page-day",
            tableId: "page-table",
            seat: (index % 9) + 1,
            status: "OUT",
            sessionStart: time,
            sessionEnd: time,
          });
          fixture.approvals.push({
            id: "page-approval-" + index,
            dayId: "page-day",
            tableId: "page-table",
            type: "Rake",
            amount: 100,
            staff: requester.username,
            note: "Fictional pagination fixture",
            status: "APPROVED",
            approvalLevel: "MANAGER",
            riskReason: "Independent review",
            requestedBy: requester.username,
            requestedById: requester.id,
            createdAt: time,
            decidedBy: before.user.username,
            decidedAt: time,
            votes: [
              {
                staffId: before.user.id,
                username: before.user.username,
                role: "ADMIN",
                time,
              },
            ],
          });
          fixture.transactions.push({
            id: "page-transaction-" + index,
            dayId: "page-day",
            tableId: "page-table",
            type: "Rake",
            amount: 100,
            staff: requester.username,
            staffId: requester.id,
            cashReceived: 100,
            cashPayout: 0,
            creditDelta: 0,
            time,
            note: "Fictional pagination fixture",
            approvalId: "page-approval-" + index,
          });
          fixture.auditLogs.push({
            id: "page-audit-" + index,
            time,
            actor: before.user.username,
            actorId: before.user.id,
            action: "Pagination fixture",
            entity: "page-approval-" + index,
            reason: "Isolated HTTP verification",
          });
        }
        await importStore(databaseFromPool(fixturePool), "http-pages", fixture);
        await admin.json("/api/branch", "POST", { branchId: "http-pages" });
        const first = await admin.json<ReadPage<Player>>(
          "/api/read?resource=players&page=0&pageSize=20",
        );
        const second = await admin.json<ReadPage<Player>>(
          "/api/read?resource=players&page=1&pageSize=20",
        );
        const third = await admin.json<ReadPage<Player>>(
          "/api/read?resource=players&page=2&pageSize=20",
        );
        assert.equal(first.branchId, "http-pages");
        assert.equal(first.total, 45);
        assert.equal(first.items.length, 20);
        assert.equal(second.items.length, 20);
        assert.equal(third.items.length, 5);
        assert.equal(
          new Set(
            [...first.items, ...second.items, ...third.items].map(
              (item) => item.id,
            ),
          ).size,
          45,
        );
        const found = await admin.json<ReadPage<Player>>(
          "/api/read?resource=players&query=" +
            encodeURIComponent("Pagination player 42"),
        );
        assert.equal(found.total, 1);
        assert.equal(found.items[0].id, "page-player-42");
        const transactions = await admin.json<ReadPage<Transaction>>(
          "/api/read?resource=transactions&page=0&pageSize=20&type=Rake",
        );
        const moreTransactions = await admin.json<ReadPage<Transaction>>(
          "/api/read?resource=transactions&page=1&pageSize=20&type=Rake",
        );
        assert.equal(transactions.total, 45);
        assert.equal(transactions.items.length, 20);
        assert.equal(moreTransactions.items.length, 20);
        assert.equal(
          new Set(
            [...transactions.items, ...moreTransactions.items].map(
              (item) => item.id,
            ),
          ).size,
          40,
        );
        const audit = await admin.json<ReadPage<AuditLog>>(
          "/api/read?resource=audit&page=1&pageSize=20",
        );
        assert.equal(audit.total, 45);
        assert.equal(audit.items.length, 20);
        await admin.json(
          "/api/read?resource=players&pageSize=51",
          "GET",
          undefined,
          400,
        );
        const report = await admin.json<ReadPage>(
          "/api/read?resource=report&dayId=page-day&pageSize=20",
        );
        assert.equal(report.total, 45);
        assert.equal(report.items.length, 20);
        assert.equal(report.totals?.cashReceived, 4500);
        assert.equal(report.totals?.expectedCash, 1_004_500);
        const exported = await admin.csv(
          "/api/read?resource=report&dayId=page-day&format=csv&pageSize=1&query=no-visible-matches",
          {
            actorId: report.context.user.id,
            branchId: report.context.branch.id,
            role: report.context.user.role,
          },
        );
        assert.ok(exported.includes('"Cash received","45"'));
        for (let index = 0; index < 45; index++)
          assert.ok(
            exported.includes('"Pagination player ' + index + '"'),
            "CSV must contain every selected-day participant",
          );
        const fresh = new StaffBrowser();
        await fresh.json("/api/read?resource=players", "GET", undefined, 401);
        await fresh.signIn("http.cashier");
        await fresh.json("/api/read?resource=audit", "GET", undefined, 403);
        await fresh.json(
          "/api/read?resource=player&id=page-player-42",
          "GET",
          undefined,
          404,
        );
        await fresh.json(
          "/api/branch",
          "POST",
          { branchId: "http-pages" },
          403,
        );
        await admin.json("/api/branch", "POST", { branchId: "http-venue" });
        assert.equal(
          totalsForDay((await admin.snapshot()).store).expectedCash,
          964_000,
        );
      },
    );

    await t.test(
      "CSV exports require the reviewed staff, role and venue and never silently follow a shared-cookie change",
      async () => {
        const reviewed = await admin.snapshot();
        const access: ExportAccess = {
          actorId: reviewed.user.id,
          branchId: reviewed.branch.id,
          role: reviewed.user.role,
        };
        const date = reviewed.store.days.find(
          (entry) => entry.id === reviewed.store.currentDayId,
        )!.date;
        const daily =
          "/api/read?resource=report&format=csv&dayId=" +
          reviewed.store.currentDayId;
        const period =
          "/api/read?resource=range&format=csv&from=" + date + "&to=" + date;
        const headers = { [EXPORT_ACCESS_HEADER]: encodeExportAccess(access) };
        for (const route of [daily, period]) {
          for (const header of [undefined, "bad%escape", "%7B%7D"]) {
            const { response } = await admin.response(
              route,
              "GET",
              undefined,
              header ? { [EXPORT_ACCESS_HEADER]: header } : undefined,
            );
            assert.equal(response.status, 400);
            assert.equal(response.headers.has(EXPORT_ACCESS_HEADER), false);
            assert.equal(response.headers.has("content-disposition"), false);
          }
          for (const incorrect of [
            { ...access, actorId: "different-staff" },
            { ...access, role: "CASHIER" as const },
            { ...access, branchId: "http-other" },
          ]) {
            const { response, data } = await admin.response(
              route,
              "GET",
              undefined,
              { [EXPORT_ACCESS_HEADER]: encodeExportAccess(incorrect) },
            );
            assert.equal(response.status, 409);
            assert.equal(
              data.error,
              "Staff access or venue changed. Refresh the report before exporting.",
            );
            assert.equal(response.headers.has(EXPORT_ACCESS_HEADER), false);
            assert.equal(response.headers.has("content-disposition"), false);
          }
          assert.ok(
            (await admin.csv(route, access)).includes(
              '"Branch","HTTP Sample Venue"',
            ),
          );
          assert.equal(
            (
              await new StaffBrowser().response(
                route,
                "GET",
                undefined,
                headers,
              )
            ).response.status,
            401,
          );
        }
        await admin.json("/api/branch", "POST", { branchId: "http-other" });
        assert.equal(
          (await admin.response(period, "GET", undefined, headers)).response
            .status,
          409,
        );
        const other = await admin.snapshot();
        assert.ok(
          (
            await admin.csv(period, {
              actorId: other.user.id,
              branchId: other.branch.id,
              role: other.user.role,
            })
          ).includes('"Branch","HTTP Other Venue"'),
        );
        await admin.json("/api/branch", "POST", { branchId: "http-venue" });
        await admin.signIn("http.manager");
        assert.equal(
          (await admin.response(period, "GET", undefined, headers)).response
            .status,
          409,
        );
        await admin.signIn("http.admin");
        await admin.json("/api/branch", "POST", { branchId: "http-venue" });
        try {
          await fixturePool.query(
            "UPDATE poker_memberships SET role='MANAGER' WHERE user_id=$1 AND branch_id=$2",
            [access.actorId, access.branchId],
          );
          assert.equal(
            (await admin.response(period, "GET", undefined, headers)).response
              .status,
            409,
          );
        } finally {
          await fixturePool.query(
            "UPDATE poker_memberships SET role='ADMIN' WHERE user_id=$1 AND branch_id=$2",
            [access.actorId, access.branchId],
          );
        }
        const after = await admin.snapshot();
        assert.equal(after.revision, reviewed.revision);
        assert.deepEqual(after.store, reviewed.store);
      },
    );

    await t.test(
      "CSV bursts refuse extra daily and period work while an aborted database export drains",
      async () => {
        const before = await admin.snapshot();
        const access: ExportAccess = {
          actorId: before.user.id,
          branchId: before.branch.id,
          role: before.user.role,
        };
        const day = before.store.days.find(
          (entry) => entry.id === before.store.currentDayId,
        )!;
        const daily = "/api/read?resource=report&format=csv&dayId=" + day.id;
        const period =
          "/api/read?resource=range&format=csv&from=" +
          day.date +
          "&to=" +
          day.date;
        const headers = { [EXPORT_ACCESS_HEADER]: encodeExportAccess(access) };
        // Compile/warm both paths before holding a real database lock.
        await admin.csv(daily, access);
        await admin.csv(period, access);
        const controller = new AbortController();
        const holder = await fixturePool.connect();
        let holding = false;
        let first: Promise<Response> | undefined;
        const waiting = async () =>
          (
            await administrator.query<{ total: number }>(
              "SELECT count(*)::int AS total FROM pg_stat_activity WHERE usename=$1 AND wait_event_type='Lock' AND query ILIKE '%poker_profiles%' AND pid<>pg_backend_pid()",
              [ownedName],
            )
          ).rows[0].total;
        const busy = async (route: string) => {
          const { response, data } = await admin.response(
            route,
            "GET",
            undefined,
            headers,
          );
          assert.equal(response.status, 503);
          assert.equal(response.headers.get("retry-after"), "1");
          assert.equal(response.headers.has(EXPORT_ACCESS_HEADER), false);
          assert.equal(response.headers.has("content-disposition"), false);
          assert.match(
            response.headers.get("content-type") ?? "",
            /^application\/json/,
          );
          assert.deepEqual(data, {
            error:
              "Another report is being exported. Please try again shortly.",
          });
          return response.headers.get("x-request-id");
        };
        try {
          await holder.query("BEGIN");
          holding = true;
          await holder.query(
            "LOCK TABLE poker_profiles IN ACCESS EXCLUSIVE MODE",
          );
          first = admin.csvResponse(daily, access, controller.signal);
          void first.catch(() => {});
          const deadline = performance.now() + 2000;
          while ((await waiting()) === 0 && performance.now() < deadline)
            await new Promise((resolve) => setTimeout(resolve, 10));
          assert.equal(
            await waiting(),
            1,
            "First export must actually be waiting in PostgreSQL",
          );
          const started = performance.now();
          const references = await Promise.all(
            Array.from({ length: 12 }, (_, index) =>
              busy(index % 2 ? daily : period),
            ),
          );
          assert.ok(
            performance.now() - started < 2000,
            "Extra exports must refuse without waiting for the database lock",
          );
          assert.equal(new Set(references).size, 12);
          assert.equal(
            await waiting(),
            1,
            "Extra exports must not add database lock waiters",
          );
          await admin.json("/api/auth");
          const health = await fetch(origin + "/api/health", {
            signal: AbortSignal.timeout(2000),
          });
          assert.equal(health.status, 200);
          await health.arrayBuffer();
          controller.abort();
          await assert.rejects(first);
          await busy(daily);
          await busy(period);
          assert.equal(
            await waiting(),
            1,
            "A disconnected client cannot release an active SQL export",
          );
        } finally {
          controller.abort();
          if (holding) await holder.query("ROLLBACK");
          holder.release();
          await first?.then(
            (response) => response.arrayBuffer(),
            () => {},
          );
        }
        // No automatic replay: a fresh explicit export succeeds after cleanup.
        const deadline = performance.now() + 5000;
        let recovered = false;
        while (performance.now() < deadline) {
          const response = await admin.csvResponse(
            period,
            access,
            AbortSignal.timeout(3000),
          );
          if (response.status === 200) {
            assert.deepEqual(
              decodeExportAccess(response.headers.get(EXPORT_ACCESS_HEADER)),
              access,
            );
            assert.ok(
              (await response.text()).includes('"Branch","HTTP Sample Venue"'),
            );
            recovered = true;
            break;
          }
          assert.equal(response.status, 503);
          await response.arrayBuffer();
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.equal(recovered, true);
        const after = await admin.snapshot();
        assert.equal(after.revision, before.revision);
        assert.deepEqual(after.store, before.store);
      },
    );

    await t.test(
      "metadata-only recovery confirms saved requests and cancels delayed writes through authenticated HTTP",
      async () => {
        const route = "/api/operations/recover";
        const before = await admin.snapshot();
        const reference = () => ({
          branchId: before.branch.id,
          actorId: before.user.id,
          operationId: randomUUID(),
        });
        type RecoveryReceipt = {
          status: "saved" | "cancelled";
          branchId: string;
          actorId: string;
          operationId: string;
          snapshot: Snapshot;
        };
        await new StaffBrowser().json(route, "POST", reference(), 401);
        assert.equal(
          (
            await admin.response(route, "POST", reference(), {
              Origin: "https://unrelated.invalid",
            })
          ).response.status,
          403,
        );
        assert.equal(
          (
            await admin.response(route, "POST", reference(), {
              "Content-Type": "text/plain",
            })
          ).response.status,
          415,
        );
        await admin.json(
          route,
          "POST",
          { ...reference(), command: { password } },
          400,
        );
        await admin.json(
          route,
          "POST",
          { ...reference(), actorId: "different-staff" },
          409,
        );
        await admin.json(
          route,
          "POST",
          { ...reference(), branchId: "http-other" },
          409,
        );
        for (const [endpoint, command] of [
          [
            "/api/state",
            {
              kind: "TABLE",
              name: "Cancelled HTTP table",
              dealer: "",
              status: "OPEN",
            },
          ],
          [
            "/api/staff",
            {
              kind: "STAFF_CREATE",
              username: "http.cancelled",
              password,
              role: "CASHIER",
              reason: "Fictional delayed HTTP save",
            },
          ],
          [
            "/api/locations",
            {
              kind: "CREATE_LOCATION",
              id: "http-cancelled",
              name: "Cancelled HTTP Venue",
              timezone: "Asia/Kuala_Lumpur",
            },
          ],
        ] as const) {
          const checkpoint = reference();
          const result = await admin.json<RecoveryReceipt>(
            route,
            "POST",
            checkpoint,
          );
          assert.equal(result.status, "cancelled");
          assert.equal(result.operationId, checkpoint.operationId);
          assert.equal(result.actorId, checkpoint.actorId);
          assert.equal(result.branchId, checkpoint.branchId);
          assert.deepEqual(result.snapshot, before);
          assert.deepEqual(await admin.json(route, "POST", checkpoint), result);
          const delayed = await admin.json<{ error: string }>(
            endpoint,
            "POST",
            {
              ...checkpoint,
              revision: before.revision,
              command,
            },
            409,
          );
          assert.match(delayed.error, /cancelled during recovery/);
          assert.deepEqual(await admin.snapshot(), before);
        }
        const checkpoint = reference();
        const saved = await admin.json<Snapshot>("/api/state", "POST", {
          ...checkpoint,
          revision: before.revision,
          command: {
            kind: "TABLE",
            name: "Recovered HTTP table",
            dealer: "",
            status: "OPEN",
          },
        });
        const confirmed = await admin.json<RecoveryReceipt>(
          route,
          "POST",
          checkpoint,
        );
        assert.equal(confirmed.status, "saved");
        assert.deepEqual(confirmed.snapshot, saved);
        assert.deepEqual(
          await admin.json(route, "POST", checkpoint),
          confirmed,
        );
        assert.equal(JSON.stringify(confirmed).includes(password), false);
        assert.equal(
          JSON.stringify(confirmed).includes("password_hash"),
          false,
        );
        const reviewer = await manager.json<{ user: Snapshot["user"] }>(
          "/api/auth",
        );
        await manager.json(
          route,
          "POST",
          { ...checkpoint, actorId: reviewer.user.id },
          403,
        );
        const revoked = new StaffBrowser();
        const identity = await revoked.signIn("http.manager");
        await revoked.json("/api/auth", "DELETE", {});
        const expiredReference = { ...reference(), actorId: identity.user.id };
        await revoked.json(route, "POST", expiredReference, 401);
        assert.equal(
          (
            await fixturePool.query(
              "SELECT operation_id FROM poker_operations WHERE operation_id=$1",
              [expiredReference.operationId],
            )
          ).rows.length,
          0,
        );
        assert.equal(
          (
            await fixturePool.query(
              "SELECT id FROM poker_users WHERE username='http.cancelled'",
            )
          ).rows.length,
          0,
        );
        assert.equal(
          (
            await fixturePool.query(
              "SELECT id FROM poker_branches WHERE id='http-cancelled'",
            )
          ).rows.length,
          0,
        );
      },
    );

    await t.test(
      "operational auth and readiness events correlate server-generated references without sensitive input",
      async () => {
        const visitor = new StaffBrowser();
        const forged = randomUUID();
        const signedIn = await visitor.response(
          "/api/auth",
          "POST",
          { username: "http.admin", password },
          {
            "X-Request-ID": forged,
            "X-Forwarded-For": "private-source-marker",
          },
        );
        assert.equal(signedIn.response.status, 200);
        assert.notEqual(signedIn.response.headers.get("x-request-id"), forged);
        const rejected = await Promise.all(
          ["http.admin", "private-missing-user-marker"].map((username) =>
            visitor.response(
              "/api/auth?private-query-marker=private-value-marker",
              "POST",
              { username, password: "private-password-marker" },
              { "X-Request-ID": forged },
            ),
          ),
        );
        for (const result of rejected)
          assert.equal(result.response.status, 401);
        const signedOut = await visitor.response("/api/auth", "DELETE", {});
        assert.equal(signedOut.response.status, 200);
        let unhealthy: Response;
        await fixturePool.query(
          "ALTER TABLE poker_login_budget RENAME COLUMN attempts TO missing_attempts",
        );
        try {
          unhealthy = await waitForHealth(503, { "X-Request-ID": forged });
          assert.equal(unhealthy.status, 503);
          assert.notEqual(unhealthy.headers.get("x-request-id"), forged);
          assert.deepEqual(await unhealthy.json(), {
            status: "unavailable",
            mode: "operations",
          });
        } finally {
          await fixturePool.query(
            "ALTER TABLE poker_login_budget RENAME COLUMN missing_attempts TO attempts",
          );
        }
        const references = [
          signedIn.response,
          ...rejected.map((result) => result.response),
          signedOut.response,
          unhealthy!,
        ].map((response) => response.headers.get("x-request-id"));
        assert.equal(new Set(references).size, 5);
        const deadline = Date.now() + 5000;
        let events: Record<string, unknown>[] = [];
        while (Date.now() < deadline) {
          events = (
            await readFile(path.join(workDirectory, "server.log"), "utf8")
          )
            .split(/\r?\n/)
            .filter((line) => line.startsWith("{"))
            .flatMap((line) => {
              try {
                return [JSON.parse(line) as Record<string, unknown>];
              } catch {
                return [];
              }
            })
            .filter((event) => references.includes(event.requestId as string));
          if (events.length === 5) break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.equal(events.length, 5);
        for (const response of [signedIn, ...rejected, signedOut]) {
          const event = events.find(
            (entry) =>
              entry.requestId === response.response.headers.get("x-request-id"),
          )!;
          assert.equal(event.event, "auth_request");
          assert.equal(event.route, "/api/auth");
          assert.equal(event.status, response.response.status);
          assert.ok(
            typeof event.durationMs === "number" && event.durationMs >= 0,
          );
          assert.equal(
            new Date(event.timestamp as string).toISOString(),
            event.timestamp,
          );
        }
        const failures = rejected.map((result) =>
          events.find(
            (event) =>
              event.requestId === result.response.headers.get("x-request-id"),
          )!,
        );
        assert.equal(failures[0].outcome, failures[1].outcome);
        const readiness = events.find(
          (event) => event.requestId === unhealthy!.headers.get("x-request-id"),
        )!;
        assert.equal(readiness.event, "readiness_failed");
        assert.equal(readiness.route, "/api/health");
        assert.equal(readiness.reason, "SCHEMA");
        const serialized = JSON.stringify(events);
        for (const privateValue of [
          forged,
          "http.admin",
          "http-owner",
          "http-venue",
          password,
          "private-source-marker",
          "private-query-marker",
          "private-value-marker",
          "private-password-marker",
          "private-missing-user-marker",
          ownedName,
          loginSecret,
        ])
          assert.equal(
            serialized.includes(privateValue),
            false,
            "Operational events must omit private values",
          );
        assert.equal((await waitForHealth(200)).status, 200);
      },
    );

    await t.test(
      "health bursts time out one blocked schema probe while staff continue saving",
      async () => {
        const holder = await fixturePool.connect();
        let holding = false;
        try {
          await holder.query("BEGIN");
          holding = true;
          await holder.query(
            "LOCK TABLE poker_schema_migrations IN ACCESS EXCLUSIVE MODE",
          );
          // Expire the short cached success before exercising the blocked probe.
          await new Promise((resolve) => setTimeout(resolve, 1100));
          const started = performance.now();
          const burst = await Promise.all(
            Array.from({ length: 30 }, () =>
              fetch(origin + "/api/health", {
                signal: AbortSignal.timeout(6000),
              }),
            ),
          );
          const elapsed = performance.now() - started;
          assert.ok(
            elapsed < 5000,
            "HTTP readiness must return before the SQL lock timeout",
          );
          assert.equal(
            new Set(
              burst.map((response) => response.headers.get("x-request-id")),
            ).size,
            30,
          );
          for (const response of burst) {
            assert.equal(response.status, 503);
            assert.deepEqual(await response.json(), {
              status: "unavailable",
              mode: "operations",
            });
          }
          const waiting = await administrator.query<{ total: number }>(
            "SELECT count(*)::int AS total FROM pg_stat_activity WHERE usename=$1 AND wait_event_type='Lock' AND query ILIKE '%poker_schema_migrations%' AND pid<>pg_backend_pid()",
            [ownedName],
          );
          assert.equal(
            waiting.rows[0].total,
            1,
            "Only one readiness query may keep waiting after the HTTP deadline",
          );
          // Even after the failed-result TTL expires, unfinished SQL keeps its slot.
          await new Promise((resolve) => setTimeout(resolve, 1100));
          const fast = performance.now();
          const repeated = await Promise.all(
            Array.from({ length: 10 }, () =>
              fetch(origin + "/api/health", {
                signal: AbortSignal.timeout(2000),
              }),
            ),
          );
          assert.ok(
            performance.now() - fast < 1500,
            "Later callers must fail fast while the first probe drains",
          );
          for (const response of repeated) {
            assert.equal(response.status, 503);
            await response.arrayBuffer();
          }
          assert.equal(
            (
              await administrator.query<{ total: number }>(
                "SELECT count(*)::int AS total FROM pg_stat_activity WHERE usename=$1 AND wait_event_type='Lock' AND query ILIKE '%poker_schema_migrations%' AND pid<>pg_backend_pid()",
                [ownedName],
              )
            ).rows[0].total,
            1,
          );
          const saved = await admin.execute({
            kind: "TABLE",
            name: "Readiness concurrency fixture",
            dealer: "",
            status: "OPEN",
          });
          assert.equal(
            saved.store.tables.filter(
              (table) => table.name === "Readiness concurrency fixture",
            ).length,
            1,
          );
        } finally {
          if (holding) await holder.query("ROLLBACK");
          holder.release();
        }
        await (await waitForHealth(200)).arrayBuffer();
        const state = await admin.snapshot();
        assert.equal(
          state.store.tables.filter(
            (table) => table.name === "Readiness concurrency fixture",
          ).length,
          1,
        );
      },
    );

    await t.test(
      "a temporary server-layout outage preserves the session for a read-only recovery",
      async () => {
        const before = await admin.json<{ user: Snapshot["user"] }>(
          "/api/auth",
        );
        const holder = await fixturePool.connect();
        let locked = false;
        try {
          await holder.query("BEGIN");
          locked = true;
          await holder.query("LOCK TABLE poker_users IN ACCESS EXCLUSIVE MODE");
          const unavailable = await admin.document("/en/tables");
          assert.equal(unavailable.status, 307);
          const target = new URL(unavailable.headers.get("location")!, origin);
          assert.equal(target.pathname, "/en/login");
          assert.equal(target.searchParams.get("unavailable"), "1");
          assert.equal(
            unavailable.headers
              .getSetCookie()
              .some((cookie) => cookie.startsWith("poker_session=")),
            false,
          );
          await unavailable.arrayBuffer();
        } finally {
          if (locked) await holder.query("ROLLBACK");
          holder.release();
        }
        const after = await admin.json<{ user: Snapshot["user"] }>("/api/auth");
        assert.deepEqual(after.user, before.user);
        const loginPage = await admin.document("/en/login?unavailable=1");
        assert.equal(loginPage.status, 200);
        assert.equal(
          loginPage.headers
            .getSetCookie()
            .some((cookie) => cookie.startsWith("poker_session=")),
          false,
        );
        await loginPage.arrayBuffer();
      },
    );

    await t.test(
      "stalled and dripping uploads time out before writes or login work while other staff continue",
      async () => {
        const before = await admin.snapshot();
        const operationId = randomUUID();
        const payload = JSON.stringify({
          actorId: before.user.id,
          branchId: before.branch.id,
          revision: before.revision,
          operationId,
          command: {
            kind: "TABLE",
            name: "Never saved stalled upload",
            dealer: "",
            status: "OPEN",
          },
        });
        const authState = async () => ({
          sessions: (
            await fixturePool.query<{ count: string }>(
              "SELECT count(*) FROM poker_sessions",
            )
          ).rows[0].count,
          budget: (
            await fixturePool.query(
              "SELECT attempts,window_start FROM poker_login_budget WHERE id=1",
            )
          ).rows,
          attempts: (
            await fixturePool.query(
              "SELECT username,attempts,window_start FROM poker_login_attempts ORDER BY username",
            )
          ).rows,
        });
        const previousAuth = await authState();
        const stateUpload = admin.partialUpload("/api/state", payload);
        const authUpload = new StaffBrowser().partialUpload(
          "/api/auth",
          JSON.stringify({ username: "http.admin", password }),
        );
        // Continue sending bytes so an idle-per-chunk timer cannot pass this test.
        const dripping = setInterval(() => stateUpload.drip(), 2000);
        try {
          const normal = await admin.execute({
            kind: "TABLE",
            name: "Available during slow uploads",
            dealer: "",
            status: "OPEN",
          });
          assert.ok(
            normal.store.tables.some(
              (table) => table.name === "Available during slow uploads",
            ),
          );
          const health = await fetch(origin + "/api/health");
          assert.equal(health.status, 200);
          await health.arrayBuffer();
          const responses = await Promise.all([
            stateUpload.result,
            authUpload.result,
          ]);
          for (const response of responses) {
            assert.equal(response.status, 408);
            assert.deepEqual(response.data, {
              error: "Request upload timed out. Please try again.",
            });
            assert.equal(response.headers["cache-control"], "no-store");
            assert.match(
              String(response.headers["x-request-id"]),
              /^[a-f0-9-]{36}$/,
            );
            assert.ok(response.elapsedMs >= 9000);
            assert.ok(response.elapsedMs < 18_000);
          }
          clearInterval(dripping);
          // A late EOF must not resume the rejected command or credential work.
          stateUpload.finish();
          authUpload.finish();
          await new Promise((resolve) => setTimeout(resolve, 100));
          const after = await admin.snapshot();
          assert.equal(after.revision, normal.revision);
          assert.deepEqual(after.store.transactions, before.store.transactions);
          assert.deepEqual(after.store.approvals, before.store.approvals);
          assert.equal(
            after.store.tables.some(
              (table) => table.name === "Never saved stalled upload",
            ),
            false,
          );
          assert.equal(
            (
              await fixturePool.query<{ count: string }>(
                "SELECT count(*) FROM poker_operations WHERE operation_id=$1",
                [operationId],
              )
            ).rows[0].count,
            "0",
          );
          assert.deepEqual(await authState(), previousAuth);
        } finally {
          clearInterval(dripping);
          stateUpload.close();
          authUpload.close();
        }
      },
    );

    await t.test(
      "login throttling hides unknown names, ignores forged source headers and creates no sessions",
      async () => {
        const visitor = new StaffBrowser();
        const sessionsBefore = (
          await fixturePool.query<{ total: string }>(
            "SELECT count(*)::text AS total FROM poker_sessions",
          )
        ).rows[0].total;
        await fixturePool.query(
          "INSERT INTO poker_login_budget(id,attempts,window_start) VALUES(1,0,now()) ON CONFLICT(id) DO UPDATE SET attempts=0,window_start=now()",
        );
        await fixturePool.query(
          "INSERT INTO poker_login_attempts(username,attempts,window_start) VALUES('http.cashier',9,now()) ON CONFLICT(username) DO UPDATE SET attempts=9,window_start=now()",
        );
        const incorrect = {
          username: "http.cashier",
          password: "fictional-incorrect-password",
        };
        assert.equal(
          (await visitor.response("/api/auth", "POST", incorrect)).response
            .status,
          401,
        );
        const knownDenied = await visitor.response(
          "/api/auth",
          "POST",
          incorrect,
        );
        assert.equal(knownDenied.response.status, 429);
        const missing = "fictional-unknown-http-security-account";
        for (let index = 0; index < 10; index++)
          assert.equal(
            (
              await visitor.response("/api/auth", "POST", {
                username: missing,
                password: incorrect.password,
              })
            ).response.status,
            401,
          );
        const unknownDenied = await visitor.response("/api/auth", "POST", {
          username: missing,
          password: incorrect.password,
        });
        assert.equal(unknownDenied.response.status, 429);
        assert.deepEqual(unknownDenied.data, knownDenied.data);
        for (const result of [knownDenied, unknownDenied]) {
          assert.match(
            result.response.headers.get("retry-after") ?? "",
            /^[0-9]+$/,
          );
          const seconds = Number(result.response.headers.get("retry-after"));
          assert.ok(seconds >= 1 && seconds <= 900);
          assert.equal(result.response.headers.getSetCookie().length, 0);
        }
        assert.equal(
          (
            await fixturePool.query(
              "SELECT username FROM poker_login_attempts WHERE username=$1",
              [missing],
            )
          ).rows.length,
          0,
        );

        await fixturePool.query(
          "UPDATE poker_login_budget SET attempts=119,window_start=now() WHERE id=1",
        );
        const rotated = await Promise.all(
          [0, 1].map((index) =>
            visitor.response(
              "/api/auth",
              "POST",
              {
                username: `fictional-http-source-${index}`,
                password: incorrect.password,
              },
              {
                "X-Forwarded-For": `192.0.2.${index + 1}`,
                Forwarded: `for=192.0.2.${index + 1}`,
                "X-Real-IP": `198.51.100.${index + 1}`,
              },
            ),
          ),
        );
        assert.deepEqual(
          rotated.map((result) => result.response.status).sort(),
          [401, 429],
        );
        const denied = rotated.find(
          (result) => result.response.status === 429,
        )!;
        assert.ok(Number(denied.response.headers.get("retry-after")) >= 1);
        assert.ok(Number(denied.response.headers.get("retry-after")) <= 60);
        assert.equal(denied.response.headers.getSetCookie().length, 0);
        assert.equal(
          (
            await fixturePool.query<{ attempts: number }>(
              "SELECT attempts FROM poker_login_budget WHERE id=1",
            )
          ).rows[0].attempts,
          121,
        );
        assert.equal(
          (
            await fixturePool.query<{ total: string }>(
              "SELECT count(*)::text AS total FROM poker_sessions",
            )
          ).rows[0].total,
          sessionsBefore,
        );
        // Login pressure must not sign out already authenticated staff.
        assert.equal(
          (await admin.json<{ user: Snapshot["user"] }>("/api/auth")).user
            .username,
          "http.admin",
        );
      },
    );
  },
);
