/**
 * Reset the database for local development: `npm run db:reset -- --demo | --clean [--yes] [--no-backup]`.
 *
 *   --demo        delete every row, then seed the demo user and sample data (as `db:seed`)
 *   --clean       delete every row and leave an empty, migrated database
 *   --yes         do not ask before deleting data — honoured only when DATABASE_URL is set explicitly on the
 *                 command (scratch databases). The default data/app.db always asks, and the answer must be the
 *                 word "reset": a `--yes` that reaches the default file by accident must not wipe it.
 *   --no-backup   do not write `<file>.before-reset-<YYYYMMDD-HHMMSS>.bak` first
 *
 * Uses the same DB as the app (data/app.db, or DATABASE_URL). The file is kept, so a running dev server keeps
 * working on it. Refuses when NODE_ENV is "production". See docs/SPEC.md → "Development helpers".
 */
import readline from "node:readline/promises";
import { getDb, resolveDatabasePath } from "@/db";
import { demoLoginLine } from "@/lib/demo";
import { assertNotProduction, backupBeforeReset, countRows, seedDemoData, wipeAllData } from "@/server/maintenance";

const USAGE = `Usage: npm run db:reset -- --demo | --clean [--yes] [--no-backup]

  --demo        delete every row, then seed the demo user and sample data
  --clean       delete every row and leave an empty database
  --yes         do not ask for confirmation (only together with an explicit DATABASE_URL;
                the default data/app.db always asks)
  --no-backup   do not copy the database to <file>.before-reset-<timestamp>.bak first

The database is DATABASE_URL, or data/app.db.`;

function usage(problem?: string): never {
  if (problem) console.error(`${problem}\n`);
  console.error(USAGE);
  process.exit(1);
}

function parseArgs(argv: string[]) {
  const opts = { mode: undefined as "demo" | "clean" | undefined, yes: false, backup: true };
  for (const arg of argv) {
    if (arg === "--demo" || arg === "--clean") {
      const mode = arg === "--demo" ? "demo" : "clean";
      if (opts.mode && opts.mode !== mode) usage("Choose one of --demo or --clean.");
      opts.mode = mode;
    } else if (arg === "--yes" || arg === "-y") opts.yes = true;
    else if (arg === "--no-backup") opts.backup = false;
    else if (arg === "--help" || arg === "-h") usage();
    else usage(`Unknown option: ${arg}`);
  }
  if (!opts.mode) usage();
  return opts as { mode: "demo" | "clean"; yes: boolean; backup: boolean };
}

async function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  try {
    assertNotProduction(process.env.NODE_ENV);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }

  const file = resolveDatabasePath();
  console.log(`Database: ${file}`);
  const db = getDb(); // creates the file and applies pending migrations

  const before = countRows(db);
  const total = before.reduce((sum, t) => sum + t.rows, 0);
  // `--yes` is only for scratch databases named explicitly with DATABASE_URL. The default file may hold real
  // data, so it always asks, and the answer has to be the word "reset" (a stray "y" is not enough).
  // "Explicit" means DATABASE_URL names a file other than the default one: `DATABASE_URL=data/app.db … --yes`,
  // or a DATABASE_URL exported in a shell profile that points at it, still has to ask.
  const explicitDb = Boolean(process.env.DATABASE_URL) && file !== resolveDatabasePath("");
  if (total > 0 && !(opts.yes && explicitDb)) {
    if (opts.yes && !explicitDb) {
      console.log("--yes is ignored for the default database; set DATABASE_URL to use it on a scratch database.");
    }
    if (!process.stdin.isTTY) {
      console.error(
        `The database ${file} has ${total} row(s). Not a terminal, so not asking. ` +
          "To reset a scratch database without a prompt, pass DATABASE_URL on the same command together with --yes.",
      );
      process.exit(1);
    }
    const what = opts.mode === "demo" ? "and seed the demo data" : "and leave it empty";
    const answer = await ask(`Delete all ${total} row(s) in ${file} ${what}? Type "reset" to continue: `);
    if (answer !== "reset") {
      console.log("Nothing changed.");
      process.exit(1);
    }
  }

  if (total > 0 && opts.backup && file !== ":memory:") {
    console.log(`Copied the database to ${backupBeforeReset(db, file)}`);
  }

  const removed = wipeAllData(db);
  const summary = removed.filter((t) => t.rows > 0).map((t) => `${t.table} ${t.rows}`);
  console.log(summary.length > 0 ? `Deleted: ${summary.join(", ")}.` : "The database was already empty.");

  if (opts.mode === "clean") {
    console.log("The database is empty. Register a new account, or run `npm run db:reset -- --demo`.");
    return;
  }

  const seeded = await seedDemoData();
  const after = countRows(db).filter((t) => t.rows > 0).map((t) => `${t.table} ${t.rows}`);
  console.log(`Seeded the demo data for ${seeded.months[0]} and ${seeded.months[1]}: ${after.join(", ")}.`);
  console.log(demoLoginLine(seeded.username));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
