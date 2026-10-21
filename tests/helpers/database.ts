import { PGlite } from "@electric-sql/pglite";
import type { Database, SqlConnection } from "../../src/server/database";
import { migrate } from "../../src/server/schema";
import { emptyStore } from "../../src/domain/selectors";

export async function testDatabase() {
  const engine = await PGlite.create();
  const connection = (client: Pick<PGlite, "query">): SqlConnection => ({
    async query<T>(sql: string, values?: unknown[]) {
      return { rows: (await client.query<T>(sql, values)).rows };
    },
  });
  const db: Database = {
    ...connection(engine),
    transaction: (work) =>
      engine.transaction((tx) => work(connection(tx as unknown as PGlite))),
  };
  await migrate(db);
  for (const branch of ["local", "other"]) {
    await db.query("INSERT INTO poker_branches(id,name) VALUES($1,$1)", [
      branch,
    ]);
    await db.query(
      "INSERT INTO poker_branch_state(branch_id,data) VALUES($1,$2)",
      [branch, JSON.stringify(emptyStore())],
    );
  }
  return { db, engine };
}
