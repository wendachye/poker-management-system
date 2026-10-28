// Isolated UI verification: no connection to the persistent local database.
// Accounts and operational records exist only in memory until this process exits.
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { migrate } from "../src/server/schema";
import { changeBranch, hashPassword, login, logout } from "../src/server/auth";
import { emptyStore } from "../src/domain/selectors";
import { defaultSettings } from "../src/domain/settings";
import { mutate } from "../src/server/repository";
import type { Database, SqlConnection } from "../src/server/database";
import type { Command } from "../src/domain/commands";
import { tableLayoutFixture } from "./helpers/table-layout-fixture";
import { financeLayoutFixture } from "./helpers/finance-layout-fixture";
import { operatorFlowFixture } from "./helpers/operator-flow-fixture";
import { localOperationsEnvironment } from "../scripts/local-environment";
import { importStore, readStore } from "../src/server/storage";

function testPort(name: string, fallback: number) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < 1024 || Number(raw) > 65535)
    throw new Error(`${name} must be an integer between 1024 and 65535.`);
  return Number(raw);
}

function adapt(engine: PGlite): Database {
  const connection = (client: Pick<PGlite, "query">): SqlConnection => ({
    async query<T>(sql: string, values?: unknown[]) {
      return { rows: (await client.query<T>(sql, values)).rows };
    },
  });
  return {
    ...connection(engine),
    transaction: (work) =>
      engine.transaction((tx) => work(connection(tx as unknown as PGlite))),
  };
}

async function configureSampleVenues(db: Database) {
  const token = await login(db, "qa.admin", "ui-test-password");
  try {
    for (const branchId of ["qa", "qa-other"]) {
      await changeBranch(db, token, branchId);
      const { setupCompleted: _, ...settings } = defaultSettings();
      void _;
      const commands: Command[] = [
        {
          kind: "UPDATE_SETTINGS",
          settings: {
            ...settings,
            venueName: branchId === "qa" ? "UI Test Venue" : "Other Test Venue",
            smallBlind: 500,
            bigBlind: 1000,
            minBuyIn: 20000,
            maxBuyIn: 500000,
            buyInStep: 5000,
            rakePercent: 5,
            rakeCap: 5000,
            tipsPolicy: "Voluntary tips are recorded separately from rake.",
            houseRules:
              "Flexible table stakes; obtain independent approval for player cash movements.",
          },
          reason: "Disposable browser test venue setup",
        },
        { kind: "TABLE", name: "Main floor", dealer: "", status: "OPEN" },
        {
          kind: "TABLE",
          name: "Reserve",
          dealer: "",
          status: "OPEN",
          smallBlind: 1000,
          bigBlind: 2500,
          minBuyIn: 50000,
          maxBuyIn: 1000000,
          buyInStep: 5000,
        },
        { kind: "COMPLETE_SETUP" },
      ];
      let revision = 0;
      for (const command of commands) {
        const snapshot = await mutate(db, token, {
          branchId,
          operationId: randomUUID(),
          revision,
          command,
        });
        revision = snapshot.revision;
      }
    }
  } finally {
    await logout(db, token);
  }
}

async function main() {
  const appPort = testPort("UI_TEST_PORT", 3001);
  const databasePort = testPort("UI_TEST_DATABASE_PORT", 55434);
  if (appPort === databasePort)
    throw new Error("UI test app and database ports must be different.");
  const distDir = process.env.UI_TEST_DIST_DIR || ".local/ui-next";
  if (!/^\.local\/ui(?:-[a-z0-9]+)*-next$/.test(distDir))
    throw new Error(
      "UI_TEST_DIST_DIR must be a dedicated Next.js folder such as .local/ui-integration-next.",
    );
  const db = await PGlite.create();
  await migrate(adapt(db));
  for (const branch of ["qa", "qa-other"]) {
    await db.query(
      "INSERT INTO poker_branches(id,name,timezone) VALUES($1,$2,$3)",
      [
        branch,
        branch === "qa" ? "UI Test Venue" : "Other Test Venue",
        "Asia/Kuala_Lumpur",
      ],
    );
    await importStore(adapt(db), branch, emptyStore());
  }
  for (const role of ["ADMIN", "MANAGER", "CASHIER", "DEALER"]) {
    const username = "qa." + role.toLowerCase();
    await db.query(
      "INSERT INTO poker_users(id,username,password_hash) VALUES($1,$2,$3)",
      [username, username, await hashPassword("ui-test-password")],
    );
    for (const branch of ["qa", "qa-other"]) {
      await db.query(
        "INSERT INTO poker_memberships(user_id,branch_id,role) VALUES($1,$2,$3)",
        [username, branch, role],
      );
    }
  }
  await configureSampleVenues(adapt(db));
  // Opt-in visual fixture affects only the disposable qa venue in this process.
  if (process.argv.includes("--operator-flow")) {
    const configured = await readStore(adapt(db), "qa");
    await importStore(adapt(db), "qa", operatorFlowFixture(configured), 5);
  }
  if (process.argv.includes("--table-layout")) {
    await importStore(adapt(db), "qa", tableLayoutFixture(), 5);
  }
  if (process.argv.includes("--finance-layout")) {
    await importStore(adapt(db), "qa", financeLayoutFixture(), 5);
    // Extra presentation-only accounts exercise paging, long usernames and all
    // access states. The normal qa.* logins above and default mode stay intact.
    const staffPasswordHash = await hashPassword("ui-test-password");
    const staffRoles = ["ADMIN", "MANAGER", "CASHIER", "DEALER"] as const;
    for (let index = 0; index < 24; index++) {
      const username =
        index === 0
          ? "qa." + "a".repeat(61)
          : index === 1
            ? "qa.international.championship.operations.manager.night.shift"
            : "qa.staff." + String(index + 1).padStart(2, "0");
      const userId = "finance-layout-staff-" + index;
      const role = staffRoles[index % staffRoles.length];
      await db.query(
        "INSERT INTO poker_users(id,username,password_hash,active) VALUES($1,$2,$3,$4)",
        [userId, username, staffPasswordHash, index % 8 !== 7],
      );
      await db.query(
        "INSERT INTO poker_memberships(user_id,branch_id,role) VALUES($1,$2,$3)",
        [userId, "qa", role],
      );
      if (index === 1 || index === 4)
        await db.query(
          "INSERT INTO poker_memberships(user_id,branch_id,role) VALUES($1,$2,$3)",
          [userId, "qa-other", role],
        );
    }
  }
  if (process.argv.includes("--pagination")) {
    const store = await readStore(adapt(db), "qa");
    for (let index = 0; index < 45; index++)
      store.profiles.push({
        id: `pagination-player-${index}`,
        name: `Pagination Player ${String(index + 1).padStart(2, "0")}`,
        phone: `+1202558${String(index).padStart(4, "0")}`,
        type: "CASH",
        creditLimit: 0,
        tags: [],
      });
    await importStore(adapt(db), "qa", store, 6);
  }
  const socket = new PGLiteSocketServer({
    db,
    host: "127.0.0.1",
    port: databasePort,
    maxConnections: 10,
  });
  await socket.start();
  const app = spawn(
    process.execPath,
    [
      "node_modules/next/dist/bin/next",
      "dev",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(appPort),
    ],
    {
      stdio: "inherit",
      env: {
        ...localOperationsEnvironment(process.env),
        DATABASE_URL: `postgresql://postgres:postgres@127.0.0.1:${databasePort}/postgres`,
        APP_ORIGIN: `http://127.0.0.1:${appPort}`,
        NEXT_DIST_DIR: distDir,
      },
      windowsHide: true,
    },
  );
  app.on("exit", async (code) => {
    await socket.stop();
    await db.close();
    process.exit(code ?? 1);
  });
  process.on("SIGINT", () => app.kill());
}
void main();
