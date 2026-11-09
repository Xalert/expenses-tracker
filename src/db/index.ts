import path from "node:path";
import { eq } from "drizzle-orm";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { Pool } from "pg";
import { demoLoginLine, DEMO_USER } from "@/lib/demo";
import * as schema from "./schema";

/** Any Drizzle Postgres database over `schema`: node-postgres at runtime, PGlite in tests. */
export type DB = PgDatabase<PgQueryResultHKT, typeof schema>;
/** A DB handle or the `tx` handed to a `db.transaction(async (tx) => ...)` callback. */
export type DBOrTx = DB | Parameters<Parameters<DB["transaction"]>[0]>[0];

/** What `npm run dev` connects to when DATABASE_URL is unset outside production (the owner's real dev data). */
export const DEFAULT_DEV_DATABASE_URL = "postgres://expenses:expenses@localhost:5432/expenses";

/** Migrations folder: `MIGRATIONS_DIR` or `<cwd>/drizzle` (also correct for the standalone server). */
export function resolveMigrationsDir(): string {
  const dir = process.env.MIGRATIONS_DIR;
  if (dir) return path.isAbsolute(dir) ? dir : path.join(/*turbopackIgnore: true*/ process.cwd(), dir);
  return path.join(process.cwd(), "drizzle");
}

/** The configured database URL; throws in production when unset, falls back to the dev default otherwise. */
export function resolveDatabaseUrl(url = process.env.DATABASE_URL): string {
  if (url) return url;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "DATABASE_URL is not set. Set it to a PostgreSQL connection URL, e.g. postgres://user:password@host:5432/dbname.",
    );
  }
  return DEFAULT_DEV_DATABASE_URL;
}

/** The URL with the password masked, for "Database: ..." lines. */
export function describeDatabase(url = process.env.DATABASE_URL || DEFAULT_DEV_DATABASE_URL): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}

/** Open a pooled connection and apply pending migrations (one transaction; rolled back as a whole on error). */
export async function createDatabase(url?: string): Promise<DB> {
  const pool = new Pool({ connectionString: resolveDatabaseUrl(url), max: 10 });
  // An idle client dropping (server restart) must not crash the process; the pool replaces it.
  pool.on("error", (err) => console.error("[db] idle client error:", err.message));
  const db = drizzlePg({ client: pool, schema });
  try {
    await migrate(db, { migrationsFolder: resolveMigrationsDir() });
  } catch (err) {
    await pool.end().catch(() => {});
    const e = err as Error;
    const cause = e.cause instanceof Error ? ` (${e.cause.message})` : "";
    throw new Error(`Database migration failed: ${e.message.replace(/\s+/g, " ").trim()}${cause}`, { cause: err });
  }
  return db;
}

// Survives Next.js dev hot reloads, so we keep a single pool per process.
const globalForDb = globalThis as unknown as { __expensesDb?: Promise<DB>; __expensesDemoLineLogged?: boolean };

/** The process-wide database, connected and migrated on first use. Concurrent first calls share one attempt. */
export function getDb(): Promise<DB> {
  if (!globalForDb.__expensesDb) {
    const attempt = createDatabase().then(async (db) => {
      // Only inside the Next.js server: the seed and reset scripts print the line themselves, at the right moment.
      if (process.env.NEXT_RUNTIME) await logDemoLogin(db);
      return db;
    });
    globalForDb.__expensesDb = attempt;
    attempt.catch(() => {
      if (globalForDb.__expensesDb === attempt) globalForDb.__expensesDb = undefined;
    });
  }
  return globalForDb.__expensesDb;
}

/**
 * Outside production, once per process: if a user with user ID `demo` exists, print how to sign in as it
 * (`demoLoginLine`). Never throws: it is a hint, not part of opening the database.
 */
export async function logDemoLogin(db: DB, nodeEnv: string | undefined = process.env.NODE_ENV): Promise<boolean> {
  if (nodeEnv === "production" || globalForDb.__expensesDemoLineLogged) return false;
  try {
    const [demo] = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.username, DEMO_USER.username))
      .limit(1);
    if (!demo) return false;
    globalForDb.__expensesDemoLineLogged = true;
    console.log(demoLoginLine());
    return true;
  } catch {
    return false;
  }
}

/** Replace the process-wide database (tests use this with `createTestDatabase()`). */
export function setDb(db: DB | undefined): void {
  globalForDb.__expensesDb = db ? Promise.resolve(db) : undefined;
}

export { schema };
