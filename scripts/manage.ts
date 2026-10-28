import { loadEnvConfig } from "@next/env";
import { parseArgs } from "node:util";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { database, closeDatabase } from "../src/server/database";
import { migrate } from "../src/server/schema";
import { emptyStore } from "../src/domain/selectors";
import type { Role } from "../src/domain/model";
import { replaceStore } from "../src/server/storage";
import {
  manageOperatorAccount,
  type OperatorAccountCommand,
} from "../src/server/operator-accounts";
import { randomUUID } from "node:crypto";
loadEnvConfig(process.cwd());
async function password() {
  if (process.env.POKER_STAFF_PASSWORD) return process.env.POKER_STAFF_PASSWORD;
  if (!process.stdin.isTTY)
    throw new Error(
      "Run in an interactive terminal or supply POKER_STAFF_PASSWORD securely.",
    );
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, done) {
      if (!muted) process.stdout.write(chunk);
      done();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  const answer = await new Promise<string>((resolve) => {
    rl.question("Password (12–128 characters): ", resolve);
    muted = true;
  });
  rl.close();
  process.stdout.write("\n");
  return answer;
}
async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      id: { type: "string" },
      name: { type: "string" },
      timezone: { type: "string" },
      username: { type: "string" },
      branch: { type: "string" },
      role: { type: "string" },
      "grant-existing": { type: "boolean" },
      enable: { type: "boolean" },
      operator: { type: "string" },
      reason: { type: "string" },
      "operation-id": { type: "string" },
    },
  });
  const db = database();
  if (positionals[0] === "migrate") {
    await migrate(db);
    console.log("Database schema is ready.");
    return;
  }
  if (positionals[0] === "branch") {
    if (!values.id || !values.name || !/^[-a-z0-9]{1,50}$/.test(values.id))
      throw new Error("Provide --id (lowercase slug) and --name.");
    const timezone = values.timezone ?? "Asia/Kuala_Lumpur";
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
    await db.transaction(async (connection) => {
      await connection.query(
        "INSERT INTO poker_branches(id,name,timezone) VALUES($1,$2,$3)",
        [values.id, values.name, timezone],
      );
      await replaceStore(connection, values.id!, emptyStore());
    });
    console.log("Branch created.");
    return;
  }
  const action = positionals[0];
  if (!["staff", "password", "disable"].includes(action))
    throw new Error("Use migrate, branch, staff, password, or disable.");
  const username = values.username?.trim().toLowerCase();
  if (!username || !/^[-a-z0-9_.@]{3,100}$/.test(username))
    throw new Error("Provide --username (3–100 letters, digits, or -_.@).");
  if (!values.operator?.trim() || !values.reason?.trim())
    throw new Error("Account changes require --operator and --reason.");
  if (values.enable && action !== "password")
    throw new Error(
      "Use --enable only with the password command and a new password.",
    );
  if (values["grant-existing"] && action !== "staff")
    throw new Error("Use --grant-existing only with the staff command.");
  const operationId = values["operation-id"] ?? randomUUID();
  // Print before prompting or mutating, so an interrupted operator can retry
  // exactly this command with the same identifier instead of changing it twice.
  console.log("Operator operation ID: " + operationId);
  let command: OperatorAccountCommand;
  if (action === "staff") {
    const role = values.role as Role;
    if (
      !values.branch ||
      !["DEALER", "CASHIER", "MANAGER", "ADMIN"].includes(role)
    )
      throw new Error("Provide --branch and --role.");
    command = values["grant-existing"]
      ? { kind: "GRANT", username, branchId: values.branch, role }
      : {
          kind: "CREATE",
          username,
          branchId: values.branch,
          role,
          password: await password(),
        };
  } else if (action === "password") {
    command = {
      kind: "PASSWORD",
      username,
      password: await password(),
      enable: values.enable ?? false,
    };
  } else command = { kind: "DISABLE", username };
  const result = await manageOperatorAccount(db, {
    operationId,
    operator: values.operator,
    reason: values.reason,
    command,
  });
  console.log(
    result.replayed
      ? "This operation was already saved; no account changes were repeated."
      : "Staff account change saved and sessions revoked across affected venues.",
  );
}
main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : "Setup failed.");
    process.exitCode = 1;
  })
  .finally(closeDatabase);
