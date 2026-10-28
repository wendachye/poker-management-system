export type ProductionConfig = {
  origin: string;
  databaseUrl: string;
};

type Environment = Readonly<Record<string, string | undefined>>;

function remoteHost(hostname: string) {
  let host: string;
  try {
    host = new URL(`http://${hostname}`).hostname
      .toLowerCase()
      .replace(/\.$/, "");
  } catch {
    return false;
  }
  return (
    !!host &&
    !/[%,\\\s]/.test(host) &&
    host !== "localhost" &&
    !host.endsWith(".localhost") &&
    !host.endsWith(".local") &&
    !/^127\./.test(host) &&
    !/^0\./.test(host) &&
    !["[::]", "[::1]"].includes(host) &&
    !/^\[::ffff:(?:7f[0-9a-f]{2}|[0-9a-f]{1,2}):[0-9a-f]{1,4}\]$/.test(host)
  );
}

function parse(value: string | undefined, message: string) {
  try {
    if (!value?.trim()) throw new Error();
    return new URL(value.trim());
  } catch {
    throw new Error(message);
  }
}

/** Validate hosted operations settings without opening a database or reading files. */
export function validateProductionConfig(
  env: Environment = process.env,
): ProductionConfig {
  if (
    [env.NEXT_PUBLIC_POKER_PROTOTYPE, env.POKER_PROTOTYPE_MODE].some(
      (flag) => flag !== undefined && flag !== "" && flag !== "0",
    )
  )
    throw new Error(
      "Prototype flags must be disabled for production operations.",
    );
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === "0")
    throw new Error("TLS certificate verification must remain enabled.");
  if (env.PGOPTIONS?.trim())
    throw new Error("PGOPTIONS must be unset for production operations.");

  const originError =
    "APP_ORIGIN must be an exact remote HTTPS origin without credentials, path, query or fragment.";
  const origin = parse(env.APP_ORIGIN, originError);
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.origin !== env.APP_ORIGIN?.trim() ||
    !remoteHost(origin.hostname)
  )
    throw new Error(originError);

  const databaseError =
    "DATABASE_URL must be a remote PostgreSQL URL with a database and dedicated credentials.";
  const databaseUrl = env.DATABASE_URL?.trim();
  const connection = parse(databaseUrl, databaseError);
  let username: string, password: string, name: string;
  try {
    username = decodeURIComponent(connection.username);
    password = decodeURIComponent(connection.password);
    name = decodeURIComponent(connection.pathname.slice(1));
  } catch {
    throw new Error(databaseError);
  }
  if (
    !["postgresql:", "postgres:"].includes(connection.protocol) ||
    !remoteHost(connection.hostname) ||
    !username ||
    !password ||
    !name ||
    connection.port === "0" ||
    /[\/\s]/.test(name) ||
    connection.hash ||
    ["postgres", "poker_local_only", "admin", "password"].includes(
      password.toLowerCase(),
    ) ||
    password.toLowerCase() === username.toLowerCase()
  )
    throw new Error(databaseError);

  // pg parses query values as connection overrides. Keep the supported contract
  // explicit so host, local certificate paths and timeout options cannot override it.
  const seen = new Set<string>();
  for (const [key] of connection.searchParams) {
    if (seen.has(key) || !["sslmode", "application_name"].includes(key))
      throw new Error(
        "DATABASE_URL supports only unique sslmode and application_name query parameters.",
      );
    seen.add(key);
  }
  if (connection.searchParams.get("sslmode") !== "verify-full")
    throw new Error("DATABASE_URL must explicitly use sslmode=verify-full.");
  if (env.PGSSLMODE && env.PGSSLMODE !== "verify-full")
    throw new Error("PGSSLMODE must be unset or verify-full.");

  databasePoolOptions(env);

  return { origin: origin.origin, databaseUrl: databaseUrl! };
}
import { databasePoolOptions } from "./database-options";
