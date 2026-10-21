import { randomBytes, randomUUID } from "node:crypto";
import type { Database } from "../src/server/database";
import { hashPassword } from "../src/server/auth";
import { migrate } from "../src/server/schema";
import { emptyStore } from "../src/domain/selectors";
import type { Role } from "../src/domain/model";

/** Bootstrap local accounts once. Never reset passwords or existing branch data. */
export async function initializeLocal(db: Database) {
  await migrate(db);
  return db.transaction(async (connection) => {
    await connection.query(
      "INSERT INTO poker_branches(id,name,timezone) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING",
      ["local", "Local Venue", "Asia/Kuala_Lumpur"],
    );
    await connection.query(
      "INSERT INTO poker_branch_state(branch_id,data) VALUES($1,$2) ON CONFLICT(branch_id) DO NOTHING",
      ["local", JSON.stringify(emptyStore())],
    );
    const created: { username: string; password: string; role: Role }[] = [];
    for (const role of ["ADMIN", "MANAGER", "CASHIER"] as const) {
      const username = "local." + role.toLowerCase();
      const existing = (
        await connection.query<{ id: string }>(
          `SELECT u.id FROM poker_users u WHERE u.username=$1
           OR ($2='ADMIN' AND u.username='admin' AND EXISTS (
             SELECT 1 FROM poker_memberships m WHERE m.user_id=u.id AND m.branch_id='local' AND m.role='ADMIN'
           )) ORDER BY (u.username=$1) DESC LIMIT 1`,
          [username, role],
        )
      ).rows[0];
      const id = existing?.id ?? randomUUID();
      if (!existing) {
        const password = randomBytes(18).toString("base64url");
        await connection.query(
          "INSERT INTO poker_users(id,username,password_hash) VALUES($1,$2,$3)",
          [id, username, await hashPassword(password)],
        );
        created.push({ username, password, role });
      }
      await connection.query(
        "INSERT INTO poker_memberships(user_id,branch_id,role) VALUES($1,$2,$3) ON CONFLICT(user_id,branch_id) DO NOTHING",
        [id, "local", role],
      );
    }
    return created;
  });
}
