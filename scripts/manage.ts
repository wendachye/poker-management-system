import { loadEnvConfig } from "@next/env";
import { parseArgs } from "node:util";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { database, closeDatabase } from "../src/server/database";
import { migrate } from "../src/server/schema";
import { hashPassword } from "../src/server/auth";
import { emptyStore } from "../src/domain/selectors";
import type { Role } from "../src/domain/model";
import { replaceStore } from "../src/server/storage";
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
  const username = values.username?.trim().toLowerCase();
  if (!username || !/^[-a-z0-9_.@]{3,100}$/.test(username))
    throw new Error("Provide --username (3–100 letters, digits, or -_.@).");
  if (positionals[0] === "disable") {
    await db.transaction(async (connection) => {
      await connection.query(
        "UPDATE poker_users SET active=false WHERE username=$1",
        [username],
      );
      await connection.query(
        "DELETE FROM poker_sessions WHERE user_id IN (SELECT id FROM poker_users WHERE username=$1)",
        [username],
      );
    });
    console.log("Account disabled and sessions revoked.");
    return;
  }
  if (positionals[0] === "password") {
    const hash = await hashPassword(await password());
    await db.transaction(async (connection) => {
      const result = await connection.query(
        "UPDATE poker_users SET password_hash=$1 WHERE username=$2 RETURNING id",
        [hash, username],
      );
      if (!result.rows.length) throw new Error("Account not found.");
      await connection.query(
        "DELETE FROM poker_sessions WHERE user_id IN (SELECT id FROM poker_users WHERE username=$1)",
        [username],
      );
    });
    console.log("Password updated and sessions revoked.");
    return;
  }
  if (positionals[0] !== "staff")
    throw new Error("Use migrate, branch, staff, password, or disable.");
  const role = values.role as Role;
  if (
    !values.branch ||
    !["DEALER", "CASHIER", "MANAGER", "ADMIN"].includes(role)
  )
    throw new Error("Provide --branch and --role.");
  const existing = (
    await db.query<{ id: string }>(
      "SELECT id FROM poker_users WHERE username=$1",
      [username],
    )
  ).rows[0];
  if (existing && !values["grant-existing"])
    throw new Error(
      "Account exists. Use --grant-existing to explicitly grant or update branch access.",
    );
  const hash = existing ? null : await hashPassword(await password());
  await db.transaction(async (connection) => {
    const id = existing?.id ?? crypto.randomUUID();
    if (!existing)
      await connection.query(
        "INSERT INTO poker_users(id,username,password_hash) VALUES($1,$2,$3)",
        [id, username, hash],
      );
    await connection.query(
      "INSERT INTO poker_memberships(user_id,branch_id,role) VALUES($1,$2,$3) ON CONFLICT(user_id,branch_id) DO UPDATE SET role=EXCLUDED.role",
      [id, values.branch, role],
    );
  });
  console.log("Staff branch access saved.");
}
main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : "Setup failed.");
    process.exitCode = 1;
  })
  .finally(closeDatabase);
