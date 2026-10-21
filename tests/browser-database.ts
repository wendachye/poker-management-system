// Disposable loopback-only PostgreSQL-compatible database for browser smoke tests.
// Never used by the application runtime or for persistent branch records.
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

async function main() {
  const db = await PGlite.create();
  const server = new PGLiteSocketServer({
    db,
    host: "127.0.0.1",
    port: 55432,
    maxConnections: 10,
  });
  await server.start();
  console.log(
    "Disposable test database listening on 127.0.0.1:55432. All data is lost on exit.",
  );
  process.on("SIGINT", async () => {
    await server.stop();
    await db.close();
    process.exit(0);
  });
}
void main();
