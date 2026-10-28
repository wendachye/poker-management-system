import { validateProductionConfig } from "../src/server/production-config";

export type StagingInput = {
  databaseUrl: string | undefined;
  expectedHost: string | undefined;
  expectedDatabase: string | undefined;
  schema: string | undefined;
  confirmation: string | undefined;
};

export class StagingSetupError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "StagingSetupError";
  }
}

/** No .env, DATABASE_URL fallback, inferred host or automatic confirmation. */
export function stagingTarget(
  input: StagingInput,
  environment: Readonly<Record<string, string | undefined>> = {},
) {
  if (!input.databaseUrl)
    throw new StagingSetupError(
      "TARGET_REQUIRED",
      "Supply STAGING_DATABASE_URL explicitly.",
    );
  try {
    validateProductionConfig({
      ...environment,
      DATABASE_URL: input.databaseUrl,
      APP_ORIGIN: "https://staging-setup.invalid",
    });
  } catch {
    throw new StagingSetupError(
      "UNSAFE_TARGET",
      "Use a remote verify-full PostgreSQL target with dedicated credentials, no startup overrides and both prototype flags disabled.",
    );
  }
  const url = new URL(input.databaseUrl);
  const database = decodeURIComponent(url.pathname.slice(1));
  if (
    !input.expectedHost ||
    input.expectedHost !== url.hostname ||
    !input.expectedDatabase ||
    input.expectedDatabase !== database ||
    !/^[a-zA-Z_][a-zA-Z0-9_-]{0,62}$/.test(database)
  )
    throw new StagingSetupError(
      "TARGET_MISMATCH",
      "The separately supplied expected host and database must match the exact staging connection.",
    );
  if (
    !input.schema ||
    !/^poker_staging(?:_[a-z0-9_]{1,24})?$/.test(input.schema)
  )
    throw new StagingSetupError(
      "INVALID_SCHEMA",
      "Use poker_staging or a short poker_staging_<lowercase_suffix> schema.",
    );
  const confirmation = `${input.expectedHost}/${database}/${input.schema}`;
  if (input.confirmation !== confirmation)
    throw new StagingSetupError(
      "CONFIRMATION_REQUIRED",
      "Confirm the exact staging host/database/schema before initialization.",
    );
  return {
    connectionString: url.href,
    host: url.hostname,
    database,
    schema: input.schema,
    owner: `${input.schema}_owner`,
    app: `${input.schema}_app`,
  };
}

export type StagingTarget = ReturnType<typeof stagingTarget>;
