// Isolated UI verification: no connection to the persistent local database.
// Accounts and operational records exist only in memory until this process exits.
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { schema } from "../src/server/schema";
import { changeBranch, hashPassword, login, logout } from "../src/server/auth";
import { emptyStore } from "../src/domain/selectors";
import { defaultSettings } from "../src/domain/settings";
import { mutate } from "../src/server/repository";
import type { Database, SqlConnection } from "../src/server/database";
import type { Command } from "../src/domain/commands";
import { tableLayoutFixture } from "./helpers/table-layout-fixture";
import { financeLayoutFixture } from "./helpers/finance-layout-fixture";

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
  const db = await PGlite.create();
  await db.exec(schema);
  for (const branch of ["qa", "qa-other"]) {
    await db.query(
      "INSERT INTO poker_branches(id,name,timezone) VALUES($1,$2,$3)",
      [
        branch,
        branch === "qa" ? "UI Test Venue" : "Other Test Venue",
        "Asia/Kuala_Lumpur",
      ],
    );
    await db.query(
      "INSERT INTO poker_branch_state(branch_id,data) VALUES($1,$2)",
      [branch, JSON.stringify(emptyStore())],
    );
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
  if (process.argv.includes("--table-layout")) {
    await adapt(db).query(
      "UPDATE poker_branch_state SET data=$1, revision=revision+1 WHERE branch_id=$2",
      [JSON.stringify(tableLayoutFixture()), "qa"],
    );
  }
  if (process.argv.includes("--finance-layout")) {
    await adapt(db).query(
      "UPDATE poker_branch_state SET data=$1, revision=revision+1 WHERE branch_id=$2",
      [JSON.stringify(financeLayoutFixture()), "qa"],
    );
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
  const socket = new PGLiteSocketServer({
    db,
    host: "127.0.0.1",
    port: 55434,
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
      "3001",
    ],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:55434/postgres",
        APP_ORIGIN: "http://127.0.0.1:3001",
        NEXT_DIST_DIR: ".local/ui-next",
        NEXT_TELEMETRY_DISABLED: "1",
      },
      windowsHide: true,
    },
  );
  app.on("exit", async () => {
    await socket.stop();
    await db.close();
    process.exit(0);
  });
  process.on("SIGINT", () => app.kill());
}
void main();
