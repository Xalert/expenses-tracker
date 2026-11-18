#!/usr/bin/env node
// `npm run build` / `npm start`: run `next <command>` with NODE_ENV=production, on any shell (Windows `cmd`
// included, where `NODE_ENV=production next build` is not valid syntax). Forcing it matters: a globally exported
// NODE_ENV=development breaks `next build`. Usage: node scripts/next-production.mjs build|start [next args...]
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const nextBin = require.resolve("next/dist/bin/next");

const child = spawn(process.execPath, [nextBin, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, NODE_ENV: "production" },
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
