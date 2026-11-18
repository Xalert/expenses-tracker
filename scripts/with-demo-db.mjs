#!/usr/bin/env node
// `npm run dev:demo` / `npm run demo:reset`: run a command with DATABASE_URL pointing at the demo database, on any
// shell (Windows `cmd` included, where `DATABASE_URL=… next dev` is not valid syntax).
// Usage: node scripts/with-demo-db.mjs <command> [args...]
//
// The demo database can never be the real one: an inherited DATABASE_URL is ignored (replaced), and the only
// override, DEMO_DATABASE_URL (another host or port), is refused unless its database is `expenses_demo`.
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

export const DEMO_DATABASE = "expenses_demo";
export const DEFAULT_DEMO_DATABASE_URL = `postgres://expenses:expenses@localhost:5433/${DEMO_DATABASE}`;

/**
 * The demo DATABASE_URL for `env`; throws when DEMO_DATABASE_URL names any other database.
 * @param {Record<string, string | undefined>} env
 */
export function demoDatabaseUrl(env = process.env) {
  const url = env.DEMO_DATABASE_URL?.trim() || DEFAULT_DEMO_DATABASE_URL;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`DEMO_DATABASE_URL is not a URL: ${url}`);
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error(`DEMO_DATABASE_URL must be a postgres:// URL, got ${parsed.protocol}`);
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (database !== DEMO_DATABASE) {
    throw new Error(`Refusing: the demo scripts only run on the database "${DEMO_DATABASE}", not "${database || "(none)"}".`);
  }
  return url;
}

function main(argv) {
  if (argv.length === 0) {
    console.error("Usage: node scripts/with-demo-db.mjs <command> [args...]");
    process.exit(1);
  }
  let url;
  try {
    url = demoDatabaseUrl();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
  const [command, ...args] = argv;
  // A shell on Windows so `npm`, `next` and `tsx` resolve to their .cmd shims.
  const child = spawn(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, DATABASE_URL: url },
  });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
  child.on("error", (err) => {
    console.error(`Could not run ${command}: ${err.message}`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
