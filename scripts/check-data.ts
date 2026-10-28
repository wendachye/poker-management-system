import { loadEnvConfig } from "@next/env";
import { database, closeDatabase } from "../src/server/database";
import {
  verifyDatabaseIntegrity,
  DatabaseIntegrityError,
} from "../src/server/integrity";
import { FinancialIntegrityError } from "../src/domain/store-integrity";

loadEnvConfig(process.cwd());
async function main() {
  if (process.argv.length > 2)
    throw new Error(
      "db:verify does not accept arguments. Select its database through the configured environment.",
    );
  console.log(
    JSON.stringify(await verifyDatabaseIntegrity(database()), null, 2),
  );
}
main()
  .catch((error: unknown) => {
    console.error(
      JSON.stringify({
        status: "failed",
        code:
          error instanceof DatabaseIntegrityError ||
          error instanceof FinancialIntegrityError
            ? error.code
            : "DATA_VERIFICATION_FAILED",
        message:
          error instanceof DatabaseIntegrityError ||
          error instanceof FinancialIntegrityError
            ? error.message
            : "Stored records could not be verified. Check schema readiness, database access and the controlled recovery process.",
      }),
    );
    process.exitCode = 1;
  })
  .finally(closeDatabase);
