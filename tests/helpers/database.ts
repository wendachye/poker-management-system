import { PGlite } from "@electric-sql/pglite";
import type { Database, SqlConnection } from "../../src/server/database";
import { migrate } from "../../src/server/schema";
import { emptyStore } from "../../src/domain/selectors";
import { importStore } from "../../src/server/storage";

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
    await importStore(db, branch, emptyStore());
  }
  return { db, engine };
}
