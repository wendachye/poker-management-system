import { randomBytes } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify, parseArgs } from "node:util";
import { createServer } from "node:net";
import { mkdir, open, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";
import { databaseFromPool } from "../src/server/database";
import { databasePoolOptions } from "../src/server/database-options";
import { localOperationsEnvironment } from "./local-environment";
import { backupNativeSamples } from "./local-postgres-backup";
import {
  maintenancePoolOptions,
  nativeMaintenanceMessage,
} from "./local-postgres-maintenance";
import {
  assertNativeResource,
  assertNativeSecrets,
  initializeNativeSamples,
  nativeLocalIdentity,
  verifyNativeSamples,
  LOCAL_RUNTIME_LABEL,
  LOCAL_SAMPLE_PASSWORD,
  NATIVE_APP,
  NATIVE_BOOTSTRAP,
  NATIVE_DATABASE,
  type NativeLocalSecrets,
} from "./local-postgres-setup";

const execute = promisify(execFile);
const root = process.cwd();
const identity = nativeLocalIdentity(root);
let web: ChildProcess | undefined;
let stopping = false;
let startupMaintenance = false;

function port(raw: string | undefined, fallback: number) {
  const value = raw ?? String(fallback);
  if (!/^\d+$/.test(value) || Number(value) < 1024 || Number(value) > 65535)
    throw new Error("Local ports must be integers between 1024 and 65535.");
  return Number(value);
}

async function freePort(value: number) {
  const probe = createServer();
  await new Promise<void>((done, fail) => {
    probe.once("error", () =>
      fail(
        new Error(
          `Local port ${value} is already in use. Existing services were preserved; choose another port.`,
        ),
      ),
    );
    probe.listen(value, "127.0.0.1", () =>
      probe.close((error) => (error ? fail(error) : done())),
    );
  });
}

async function docker(
  args: string[],
  environment: NodeJS.ProcessEnv = process.env,
) {
  return (
    await execute("docker", args, {
      env: environment,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      timeout: 180_000,
    })
  ).stdout.trim();
}

async function inspect(kind: "container" | "volume", name: string) {
  try {
    return JSON.parse(await docker([kind, "inspect", name]))[0];
  } catch (error) {
    const stderr =
      error && typeof error === "object" && "stderr" in error
        ? String(error.stderr)
        : "";
    if (/No such (?:object|container|volume)/i.test(stderr)) return undefined;
    throw new Error(
      "Docker could not inspect the local sample resource. Start Docker Desktop and retry; no existing resources were removed.",
    );
  }
}

async function configuration(
  volumeExists: boolean,
  requireExisting = false,
): Promise<NativeLocalSecrets> {
  const directory = resolve(root, ".local", "native-postgres");
  if (!requireExisting)
    await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = resolve(directory, "credentials.json");
  try {
    const stored: unknown = JSON.parse(await readFile(path, "utf8"));
    assertNativeSecrets(stored, identity.workspace);
    return stored;
  } catch (error) {
    if (!(
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ))
      throw error;
    if (volumeExists || requireExisting)
      throw new Error(
        "The local PostgreSQL volume exists but its private configuration is missing. Preserve the volume and recover credentials; the launcher will not reset it.",
      );
  }
  const secrets: NativeLocalSecrets = {
    version: 1,
    workspace: identity.workspace,
    bootstrapPassword: randomBytes(32).toString("hex"),
    ownerPassword: randomBytes(32).toString("hex"),
    appPassword: randomBytes(32).toString("hex"),
  };
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(secrets, null, 2) + "\n");
    await file.sync();
  } finally {
    await file.close();
  }
  return secrets;
}

function databaseUrl(username: string, password: string, databasePort: number) {
  const url = new URL(
    `postgresql://127.0.0.1:${databasePort}/${NATIVE_DATABASE}`,
  );
  url.username = username;
  url.password = password;
  return url.href;
}

async function stop(code: number) {
  if (stopping) return;
  stopping = true;
  if (web?.pid && web.exitCode === null && web.signalCode === null) {
    const exited = new Promise<void>((done) => web!.once("exit", () => done()));
    if (process.platform === "win32") {
      try {
        await execute("taskkill", ["/PID", String(web.pid), "/T", "/F"], {
          windowsHide: true,
        });
      } catch {
        web.kill("SIGTERM");
      }
    } else web.kill("SIGTERM");
    await exited;
  }
  console.log(
    web
      ? `Local app stopped. Sample database remains in Docker container ${identity.container}; records are preserved.`
      : "Local launcher stopped. Existing PostgreSQL resources were preserved.",
  );
  process.exitCode = code;
}

async function main() {
  if (process.env.NODE_ENV === "production")
    throw new Error("Use this sample launcher only for local development.");
  const { values } = parseArgs({
    options: {
      port: { type: "string" },
      "database-port": { type: "string" },
      "database-only": { type: "boolean", default: false },
      backup: { type: "boolean", default: false },
    },
  });
  const appPort = port(values.port, 3000),
    databasePort = port(values["database-port"], 55440);
  if (values.backup && values["database-only"])
    throw new Error("Choose either --backup or --database-only.");
  if (!values.backup && appPort === databasePort)
    throw new Error("Application and database ports must differ.");
  if (!values["database-only"] && !values.backup) await freePort(appPort);
  try {
    await docker(["info", "--format", "{{.ServerVersion}}"]);
  } catch {
    throw new Error(
      "Docker Desktop must be running for native PostgreSQL. Existing local/cloud settings were preserved.",
    );
  }
  const volume = await inspect("volume", identity.volume);
  if (values.backup && !volume)
    throw new Error(
      "Native sample storage is not initialized. Start npm run local:postgres first; backup never creates a database or volume.",
    );
  if (volume) assertNativeResource(volume, identity.workspace, "data");
  const secrets = await configuration(Boolean(volume), values.backup);
  let container = await inspect("container", identity.container);
  if (container) {
    assertNativeResource(
      { Labels: container.Config?.Labels },
      identity.workspace,
      "container",
    );
    const bindings = container.HostConfig?.PortBindings?.["5432/tcp"];
    const mount = container.Mounts?.find(
      (item: { Destination: string }) =>
        item.Destination === "/var/lib/postgresql",
    );
    if (
      container.Config?.Image !== "postgres:18-alpine" ||
      bindings?.length !== 1 ||
      bindings[0].HostIp !== "127.0.0.1" ||
      bindings[0].HostPort !== String(databasePort) ||
      mount?.Type !== "volume" ||
      mount.Name !== identity.volume
    )
      throw new Error(
        "The existing local container does not match its expected image, loopback port or data volume. It was preserved.",
      );
    if (!volume)
      throw new Error(
        "The sample container's data volume is missing. No replacement was created.",
      );
    if (!container.State?.Running) {
      if (values.backup)
        throw new Error(
          "The owned local PostgreSQL container is stopped. Start the local launcher before backup; backup never starts or initializes it.",
        );
      await freePort(databasePort);
      await docker(["start", identity.container]);
    }
  } else {
    if (values.backup)
      throw new Error(
        "The owned local PostgreSQL container does not exist. Start npm run local:postgres first; backup never creates it.",
      );
    await freePort(databasePort);
    if (!volume)
      await docker([
        "volume",
        "create",
        "--label",
        `com.poker.local.runtime=${LOCAL_RUNTIME_LABEL}`,
        "--label",
        `com.poker.local.workspace=${identity.workspace}`,
        "--label",
        "com.poker.local.resource=data",
        identity.volume,
      ]);
    await docker(
      [
        "run",
        "--detach",
        "--name",
        identity.container,
        "--label",
        `com.poker.local.runtime=${LOCAL_RUNTIME_LABEL}`,
        "--label",
        `com.poker.local.workspace=${identity.workspace}`,
        "--label",
        "com.poker.local.resource=container",
        "--cpus=2",
        "--memory=1g",
        "--publish",
        `127.0.0.1:${databasePort}:5432`,
        "--mount",
        `type=volume,source=${identity.volume},target=/var/lib/postgresql`,
        "--env",
        `POSTGRES_USER=${NATIVE_BOOTSTRAP}`,
        "--env",
        `POSTGRES_DB=${NATIVE_DATABASE}`,
        "--env",
        "POSTGRES_PASSWORD",
        "postgres:18-alpine",
      ],
      { ...process.env, POSTGRES_PASSWORD: secrets.bootstrapPassword },
    );
  }
  container = await inspect("container", identity.container);
  if (!container?.State?.Running)
    throw new Error("The owned local PostgreSQL container did not start.");
  if (values.backup) {
    const backupUrl = databaseUrl(
      NATIVE_APP,
      secrets.appPassword,
      databasePort,
    );
    const runtime = new Pool({
      connectionString: backupUrl,
      ...databasePoolOptions({
        ...process.env,
        DATABASE_URL: backupUrl,
        DATABASE_POOL_MAX: "1",
      }),
    });
    runtime.on("error", () => {
      console.error("Native local backup connection failed.");
      process.exitCode = 1;
    });
    try {
      console.log(
        JSON.stringify(
          await backupNativeSamples(
            databaseFromPool(runtime),
            resolve(root, ".local", "native-postgres", "backups"),
            identity.workspace,
          ),
          null,
          2,
        ),
      );
      console.log(
        "This private file contains account password hashes and sample venue history. Keep it outside Git. The running database was only read; restore verification used a disposable database.",
      );
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? error.code
          : undefined;
      if (
        typeof code === "string" &&
        [
          "28P01",
          "28000",
          "3D000",
          "42501",
          "42P01",
          "ECONNREFUSED",
          "57P03",
        ].includes(code)
      )
        throw new Error(
          "Native local samples are not initialized or their restricted runtime connection is unavailable. Start npm run local:postgres and review its readiness before backup. No setup, migration or grants were run by backup.",
        );
      throw error;
    } finally {
      await runtime.end();
    }
    return;
  }
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      await docker([
        "exec",
        identity.container,
        "pg_isready",
        "-U",
        NATIVE_BOOTSTRAP,
        "-d",
        NATIVE_DATABASE,
      ]);
      break;
    } catch {
      if (attempt === 59)
        throw new Error(
          "Local PostgreSQL did not become ready. Inspect the owned container; no data was reset.",
        );
      await new Promise((done) => setTimeout(done, 500));
    }
  }
  startupMaintenance = true;
  const bootstrapUrl = databaseUrl(
    NATIVE_BOOTSTRAP,
    secrets.bootstrapPassword,
    databasePort,
  );
  let maintenanceConnectionFailure: string | undefined;
  const onMaintenanceError = (error: unknown) => {
    maintenanceConnectionFailure =
      nativeMaintenanceMessage(error) ??
      "The local PostgreSQL maintenance connection failed. Retry the launcher after checking the owned database.";
  };
  const bootstrap = new Pool({
    connectionString: bootstrapUrl,
    ...maintenancePoolOptions(bootstrapUrl),
  });
  bootstrap.on("error", onMaintenanceError);
  let initialized;
  try {
    initialized = await initializeNativeSamples(
      databaseFromPool(bootstrap),
      secrets,
    );
  } finally {
    await bootstrap.end();
  }
  if (maintenanceConnectionFailure)
    throw new Error(maintenanceConnectionFailure);
  const appUrl = databaseUrl(NATIVE_APP, secrets.appPassword, databasePort);
  const runtime = new Pool({
    connectionString: appUrl,
    ...maintenancePoolOptions(appUrl),
  });
  runtime.on("error", onMaintenanceError);
  let verified;
  try {
    verified = await verifyNativeSamples(databaseFromPool(runtime));
  } finally {
    await runtime.end();
  }
  if (maintenanceConnectionFailure)
    throw new Error(maintenanceConnectionFailure);
  console.log(
    JSON.stringify(
      {
        status: "database-ready",
        database: "PostgreSQL 18",
        container: identity.container,
        volume: identity.volume,
        databasePort,
        appUrl: `http://localhost:${appPort}/en/login`,
        sampleDataCreated: initialized.created,
        counts: verified.counts,
        accounts: initialized.users,
        ...(initialized.created
          ? { initialSamplePassword: LOCAL_SAMPLE_PASSWORD }
          : { passwordPreserved: true }),
        privateConfiguration: resolve(
          root,
          ".local",
          "native-postgres",
          "credentials.json",
        ),
      },
      null,
      2,
    ),
  );
  if (values["database-only"]) return;
  web = spawn(
    process.execPath,
    [
      resolve(root, "node_modules/next/dist/bin/next"),
      "dev",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(appPort),
    ],
    {
      cwd: root,
      stdio: "inherit",
      windowsHide: true,
      env: {
        ...localOperationsEnvironment(process.env),
        DATABASE_URL: appUrl,
        APP_ORIGIN: `http://localhost:${appPort}`,
        PGOPTIONS: "",
        NEXT_DIST_DIR: ".local/native-local-next",
      },
    },
  );
  web.once("error", () => {
    console.error("Local web server could not start.");
    void stop(1);
  });
  web.once("exit", (code) => {
    if (!stopping) void stop(code ?? 1);
  });
}

process.on("SIGINT", () => void stop(0));
process.on("SIGTERM", () => void stop(0));
main().catch((error) => {
  console.error(
    (startupMaintenance ? nativeMaintenanceMessage(error) : null) ??
      (error instanceof Error
        ? error.message
        : "Local PostgreSQL launcher failed."),
  );
  void stop(1);
});
