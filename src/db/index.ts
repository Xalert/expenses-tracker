import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema";

export type DB = BetterSQLite3Database<typeof schema> & { $client: Database.Database };
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

/** Open a connection, apply pending migrations safely (see `migrateDatabase`) and enable foreign keys. */
export function createDatabase(url?: string): DB {
  const file = resolveDatabasePath(url);
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });

  const sqlite = new Database(file);
  try {
    sqlite.pragma("busy_timeout = 5000");
    if (file !== ":memory:") sqlite.pragma("journal_mode = WAL");
    const db = drizzle({ client: sqlite, schema });
    migrateDatabase(db, { file });
    return db;
  } catch (err) {
    sqlite.close();
    throw err;
  }
}

type JournalEntry = { idx: number; when: number; tag: string };
const MIGRATIONS_TABLE = "__drizzle_migrations";

/** Tags of the migrations in `folder` that `db` has not applied yet (drizzle's own rule: newer than the last applied). */
export function pendingMigrations(db: DB, folder = resolveMigrationsDir()): string[] {
  const journal = JSON.parse(fs.readFileSync(path.join(folder, "meta", "_journal.json"), "utf8")) as {
    entries: JournalEntry[];
  };
  const client = db.$client;
  const hasTable = client
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(MIGRATIONS_TABLE);
  const last = hasTable
    ? (client.prepare(`SELECT created_at FROM "${MIGRATIONS_TABLE}" ORDER BY created_at DESC LIMIT 1`).get() as
        | { created_at: number | string }
        | undefined)
    : undefined;
  const lastMillis = last ? Number(last.created_at) : undefined;
  return journal.entries.filter((e) => lastMillis === undefined || lastMillis < e.when).map((e) => e.tag);
}

/** `<file>.before-migration-<tag>.bak`, or with a timestamp when that name is already taken. */
function backupPathFor(file: string, tag: string): string {
  const plain = `${file}.before-migration-${tag}.bak`;
  if (!fs.existsSync(plain)) return plain;
  return `${file}.before-migration-${tag}.${new Date().toISOString().replace(/[:.]/g, "-")}.bak`;
}

/**
 * Apply pending migrations without letting SQLite's table rebuilds cascade-delete data, then enable foreign keys.
 *
 * 1. `PRAGMA foreign_keys = OFF` — before the migrator opens its transaction (the pragma is a no-op inside one).
 *    Rebuilding a table means `DROP TABLE` on the old one, which with foreign keys ON is an implicit `DELETE` that
 *    fires every `ON DELETE CASCADE` pointing at it.
 * 2. If migrations are pending and `file` is an existing database that already has tables, write a consistent copy
 *    next to it with `VACUUM INTO` (`<file>.before-migration-<first pending tag>.bak`). Not for `:memory:`.
 * 3. Run drizzle's migrator (all pending migrations in one transaction; rolled back as a whole on error).
 * 4. `PRAGMA foreign_keys = ON`, then `PRAGMA foreign_key_check` must return nothing, or this throws.
 *
 * Returns the applied tags and the backup path (null when none was written).
 */
export function migrateDatabase(
  db: DB,
  opts: { file: string; migrationsFolder?: string },
): { applied: string[]; backupPath: string | null } {
  const client = db.$client;
  const migrationsFolder = opts.migrationsFolder ?? resolveMigrationsDir();
  if (client.inTransaction) throw new Error("migrateDatabase must not be called inside a transaction.");

  client.pragma("foreign_keys = OFF");
  const pending = pendingMigrations(db, migrationsFolder);

  let backupPath: string | null = null;
  if (pending.length > 0 && opts.file !== ":memory:") {
    const hasTables = client
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1")
      .get();
    if (hasTables) {
      backupPath = backupPathFor(opts.file, pending[0]);
      client.prepare("VACUUM INTO ?").run(backupPath);
      console.info(`[db] Pending migrations ${pending.join(", ")}: copied the database to ${backupPath} first.`);
    }
  }

  try {
    if (pending.length > 0) migrate(db, { migrationsFolder });
  } catch (err) {
    const hint = backupPath ? ` Nothing was changed (the migration was rolled back); a copy is at ${backupPath}.` : "";
    const cause = (err as Error).cause instanceof Error ? ` (${((err as Error).cause as Error).message})` : "";
    throw new Error(`Database migration failed: ${(err as Error).message.replace(/\s+/g, " ").trim()}${cause}.${hint}`, { cause: err });
  } finally {
    client.pragma("foreign_keys = ON");
  }

  const violations = client.pragma("foreign_key_check") as { table: string; rowid: number; parent: string }[];
  if (violations.length > 0) {
    const sample = violations
      .slice(0, 5)
      .map((v) => `${v.table} row ${v.rowid} → missing ${v.parent}`)
      .join("; ");
    const restore = backupPath ? ` The database as it was before migrating is at ${backupPath}.` : "";
    throw new Error(
      `Database integrity check failed: ${violations.length} row(s) reference rows that do not exist (${sample}). ` +
        `Refusing to start.${restore}`,
    );
  }
  if (pending.length > 0 && backupPath) console.info(`[db] Applied migrations ${pending.join(", ")}.`);
  return { applied: pending, backupPath };
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
