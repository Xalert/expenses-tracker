/**
 * Reset the database for local development: `npm run db:reset -- --demo | --clean [--yes] [--no-backup]`.
 *
 *   --demo        delete every row, then seed the demo user and sample data (as `db:seed`)
 *   --clean       delete every row and leave an empty, migrated database
 *   --yes         do not ask before deleting data — honoured only when DATABASE_URL is set explicitly on the
 *                 command and names a database other than the dev default (scratch databases). The default
 *                 database always asks, and the answer must be the word "reset": a `--yes` that reaches it by
 *                 accident must not wipe it.
 *   --no-backup   accepted and ignored (there is no longer a file copy; take a backup with the app's JSON export
 *                 or `pg_dump` before resetting a database you care about)
 *
 * Uses the same database as the app (DATABASE_URL, or the dev default). The tables are truncated, not dropped, so a
 * running dev server keeps working on it. Refuses when NODE_ENV is "production". See docs/SPEC.md → "Development helpers".
 */
import readline from "node:readline/promises";
import { DEFAULT_DEV_DATABASE_URL, describeDatabase, getDb } from "@/db";
import { demoLoginLine } from "@/lib/demo";
import { assertNotProduction, countRows, seedDemoData, wipeAllData } from "@/server/maintenance";

const USAGE = `Usage: npm run db:reset -- --demo | --clean [--yes] [--no-backup]

  --demo        delete every row, then seed the demo user and sample data
  --clean       delete every row and leave an empty database
  --yes         do not ask for confirmation (only together with an explicit DATABASE_URL that is not
                the dev default; the default database always asks)
  --no-backup   accepted and ignored

The database is DATABASE_URL, or ${describeDatabase(DEFAULT_DEV_DATABASE_URL)}.`;

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

  const file = describeDatabase();
  console.log(`Database: ${file}`);
  const db = await getDb(); // connects and applies pending migrations

  const before = await countRows(db);
  const total = before.reduce((sum, t) => sum + t.rows, 0);
  // `--yes` is only for scratch databases named explicitly with DATABASE_URL. The default file may hold real
  // data, so it always asks, and the answer has to be the word "reset" (a stray "y" is not enough).
  // "Explicit" means DATABASE_URL names a database other than the default one: `DATABASE_URL=<the dev default> … --yes`,
  // or a DATABASE_URL exported in a shell profile that points at it, still has to ask.
  const explicitDb = Boolean(process.env.DATABASE_URL) && process.env.DATABASE_URL !== DEFAULT_DEV_DATABASE_URL;
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

  if (total > 0) {
    console.log("There is no automatic copy any more: a backup is the app's JSON export or `pg_dump`.");
  }

  const removed = await wipeAllData(db);
  const summary = removed.filter((t) => t.rows > 0).map((t) => `${t.table} ${t.rows}`);
  console.log(summary.length > 0 ? `Deleted: ${summary.join(", ")}.` : "The database was already empty.");

  if (opts.mode === "clean") {
    console.log("The database is empty. Register a new account, or run `npm run db:reset -- --demo`.");
    return;
  }

  const seeded = await seedDemoData();
  const after = (await countRows(db)).filter((t) => t.rows > 0).map((t) => `${t.table} ${t.rows}`);
  console.log(`Seeded the demo data for ${seeded.months[0]} and ${seeded.months[1]}: ${after.join(", ")}.`);
  console.log(demoLoginLine(seeded.username));
}

main()
  .then(() => process.exit(0)) // the connection pool would keep the process alive
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
