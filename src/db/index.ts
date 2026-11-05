import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema";

export type DB = BetterSQLite3Database<typeof schema>;
/** A DB handle or the `tx` handed to a `db.transaction(...)` callback. */
export type DBOrTx = DB | Parameters<Parameters<DB["transaction"]>[0]>[0];

const DEFAULT_DB_FILE = path.join(process.cwd(), "data", "app.db");
/** Migrations folder: `MIGRATIONS_DIR` or `<cwd>/drizzle` (also correct for the standalone server). */
export function resolveMigrationsDir(): string {
  const dir = process.env.MIGRATIONS_DIR;
  if (dir) return path.isAbsolute(dir) ? dir : path.join(/*turbopackIgnore: true*/ process.cwd(), dir);
  return path.join(process.cwd(), "drizzle");
}

/**
 * Resolve the SQLite file path from a URL-ish string.
 * Accepts `:memory:`, `file:./relative.db`, `file:/abs.db` or a plain path.
 */
export function resolveDatabasePath(url = process.env.DATABASE_URL): string {
  if (!url) return DEFAULT_DB_FILE;
  if (url === ":memory:" || url === "file::memory:") return ":memory:";
  const raw = url.startsWith("file:") ? url.slice("file:".length) : url;
  return path.isAbsolute(raw) ? raw : path.join(/*turbopackIgnore: true*/ process.cwd(), raw);
}

/** Open a connection, enable foreign keys and apply pending migrations. */
export function createDatabase(url?: string): DB {
  const file = resolveDatabasePath(url);
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });

  const sqlite = new Database(file);
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  if (file !== ":memory:") sqlite.pragma("journal_mode = WAL");

  const db = drizzle({ client: sqlite, schema });
  migrate(db, { migrationsFolder: resolveMigrationsDir() });
  return db;
}

// Survives Next.js dev hot reloads, so we keep a single connection per process.
const globalForDb = globalThis as unknown as { __expensesDb?: DB };

/** The process-wide connection, created (and migrated) on first access. */
export function getDb(): DB {
  if (!globalForDb.__expensesDb) globalForDb.__expensesDb = createDatabase();
  return globalForDb.__expensesDb;
}

/** Replace the process-wide connection (tests use this with `createDatabase(":memory:")`). */
export function setDb(db: DB | undefined): void {
  globalForDb.__expensesDb = db;
}

export { schema };
