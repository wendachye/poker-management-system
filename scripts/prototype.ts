import { spawn } from "node:child_process";
import { resolve } from "node:path";

// Frontend stakeholder preview. Never starts a database or loads local accounts.
if (process.env.NODE_ENV === "production")
  throw new Error("The stakeholder prototype runs only in local development.");

const child = spawn(
  process.execPath,
  [
    resolve("node_modules/next/dist/bin/next"),
    "dev",
    "--hostname",
    "127.0.0.1",
    "--port",
    "3001",
  ],
  {
    cwd: process.cwd(),
    stdio: "inherit",
    windowsHide: true,
    env: {
      ...process.env,
      NODE_ENV: "development",
      NEXT_PUBLIC_POKER_PROTOTYPE: "1",
      POKER_PROTOTYPE_MODE: "1",
      DATABASE_URL: "",
      APP_ORIGIN: "http://127.0.0.1:3001",
      NEXT_DIST_DIR: ".local/prototype-next",
      NEXT_TELEMETRY_DISABLED: "1",
    },
  },
);

console.log("Stakeholder prototype: http://127.0.0.1:3001/en/dashboard");
console.log(
  "Fictional data in browser memory. Refresh or use Reset demo to start again.",
);
console.log("The local operations database is not connected to this preview.");

let stopping = false;
function stop() {
  if (stopping || !child.pid || child.exitCode !== null) return;
  stopping = true;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.once("error", () => child.kill("SIGTERM"));
  } else child.kill("SIGTERM");
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
child.once("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.once("exit", (code) => {
  process.exitCode = stopping ? 0 : (code ?? 1);
});
