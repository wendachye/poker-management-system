import { loadEnvConfig } from "@next/env";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { database, closeDatabase } from "../src/server/database";
import { seedLocalSamples } from "./sample-data";

loadEnvConfig(process.cwd(), true);
async function main() {
  if (
    process.env.NODE_ENV === "production" ||
    process.env.DATABASE_URL !==
      "postgresql://postgres:postgres@127.0.0.1:55432/postgres"
  )
    throw new Error(
      "Sample loading is only available for the persistent local development database.",
    );
  const now = new Date();
  let backupPath: string | undefined;
  const result = await seedLocalSamples(database(), now, async (row) => {
    const directory = resolve(process.cwd(), ".local", "backups");
    await mkdir(directory, { recursive: true });
    backupPath = resolve(
      directory,
      "before-samples-" + now.toISOString().replace(/[:.]/g, "-") + ".json",
    );
    await writeFile(
      backupPath,
      JSON.stringify(
        { branchId: "local", savedAt: now.toISOString(), ...row },
        null,
        2,
      ) + "\n",
      { flag: "wx", mode: 0o600 },
    );
  });
  console.log(
    result.added
      ? "Sample data added to Local Venue."
      : "Samples were already loaded. No records were changed.",
  );
  console.log(JSON.stringify(result, null, 2));
  if (backupPath) console.log("Previous branch state saved to " + backupPath);
}
main()
  .catch((error) => {
    console.error(
      error instanceof Error ? error.message : "Sample loading failed.",
    );
    process.exitCode = 1;
  })
  .finally(closeDatabase);
