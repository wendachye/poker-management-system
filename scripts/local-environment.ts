/** Local operations and API verification must use the database-backed app. */
export function localOperationsEnvironment(
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return {
    ...env,
    NODE_ENV: "development",
    NEXT_PUBLIC_POKER_PROTOTYPE: "0",
    POKER_PROTOTYPE_MODE: "0",
    NEXT_TELEMETRY_DISABLED: "1",
  };
}
