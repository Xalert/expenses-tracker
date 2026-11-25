#!/usr/bin/env node
// `npm run test:e2e` / `make test-e2e`: the end-to-end browser tests (e2e/, Playwright) against a production build on
// a fresh, throwaway database. Steps:
//   1. a Postgres: E2E_DATABASE_URL when set (CI's service container), otherwise compose.e2e.yaml (tmpfs, port 5434);
//   2. `npm run build` (skipped with E2E_SKIP_BUILD=1) and the standalone copy steps of the Dockerfile;
//   3. `playwright test` with any extra arguments, e.g. `--project=desktop-webkit` for one browser (its webServer starts
//      .next/standalone/server.js on that database);
//   4. compose down -v, also when a step fails or the run is interrupted.
// The database name must contain "e2e": the suite wipes it at the start (e2e/global-setup.ts).
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, rmSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const compose = ["compose", "-f", path.join(root, "compose.e2e.yaml"), "-p", "expenses-tracker-e2e"];
const ownDatabase = !process.env.E2E_DATABASE_URL;
const databaseUrl = process.env.E2E_DATABASE_URL ?? "postgres://expenses:expenses@127.0.0.1:5434/expenses_e2e";

function run(cmd, args, env = process.env) {
  const result = spawnSync(cmd, args, { cwd: root, stdio: "inherit", env, shell: process.platform === "win32" });
  return result.status ?? 1;
}

function teardown() {
  if (ownDatabase) run("docker", [...compose, "down", "-v", "--remove-orphans"]);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    teardown();
    process.exit(130);
  });
}

let code = 0;
try {
  if (ownDatabase) {
    // A run that was killed may have left the container (and its data) behind: start from nothing.
    teardown();
    code = run("docker", [...compose, "up", "-d", "--wait"]);
    if (code !== 0) throw new Error("Could not start the e2e Postgres (compose.e2e.yaml).");
  }
  if (process.env.E2E_SKIP_BUILD !== "1") {
    code = run("npm", ["run", "build"]);
    if (code !== 0) throw new Error("npm run build failed.");
  }
  // Next's standalone step (as in the Dockerfile): static assets and public/ are not part of the traced output.
  const standalone = path.join(root, ".next", "standalone");
  if (!existsSync(path.join(standalone, "server.js"))) throw new Error("No .next/standalone/server.js: build first.");
  rmSync(path.join(standalone, ".next", "static"), { recursive: true, force: true });
  cpSync(path.join(root, ".next", "static"), path.join(standalone, ".next", "static"), { recursive: true });
  rmSync(path.join(standalone, "public"), { recursive: true, force: true });
  cpSync(path.join(root, "public"), path.join(standalone, "public"), { recursive: true });

  code = run("npx", ["playwright", "test", ...process.argv.slice(2)], { ...process.env, E2E_DATABASE_URL: databaseUrl });
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  if (code === 0) code = 1;
} finally {
  teardown();
}
process.exit(code);
