import { loadEnvConfig } from "@next/env";
import { validateProductionConfig } from "../src/server/production-config";

loadEnvConfig(process.cwd());

try {
  validateProductionConfig();
  console.log(
    "Production configuration validated. No database connection was opened and no records were changed.",
  );
  console.log(
    "This checks configuration only. Database readiness, backups and a restore drill must be verified separately.",
  );
} catch (error) {
  console.error(
    "Production configuration check failed: " +
      (error instanceof Error ? error.message : "Invalid configuration."),
  );
  process.exitCode = 1;
}
