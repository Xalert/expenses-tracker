import { sql } from "drizzle-orm";
import { setDb, type DB } from "@/db";
import { createTestDatabase } from "@/db/test";
import { users } from "@/db/schema";
import { listCategories, seedDefaultCategories } from "@/server/categories";
import { seedDefaultGroup } from "@/server/wallet-groups";

// One in-process Postgres (PGlite) per test file: created and migrated once, lazily, then emptied before each test.
let shared: Promise<DB> | undefined;

const APP_TABLES = ["categories", "sessions", "transactions", "transfers", "users", "wallet_groups", "wallets"];

/**
 * The file's PGlite database, emptied (every app table truncated, ids restarting at 1) and installed as the
 * process-wide connection. Call `db = await useFreshDb()` in beforeEach.
 */
export async function useFreshDb(): Promise<DB> {
  shared ??= createTestDatabase();
  const db = await shared;
  await db.execute(sql.raw(`truncate table ${APP_TABLES.map((t) => `"${t}"`).join(", ")} restart identity cascade`));
  setDb(db);
  return db;
}

/**
 * Insert a user directly (skips scrypt for speed) and seed default categories and the default group. The user ID is the email with
 * `@` (and anything else not allowed) turned into `-`, so distinct emails give distinct user IDs.
 */
export async function makeUser(db: DB, email: string) {
  const username = email.toLowerCase().replace(/[^a-z0-9._-]/g, "-");
  const [user] = await db
    .insert(users)
    .values({ username, email, firstName: email.split("@")[0], passwordHash: "x" })
    .returning();
  await seedDefaultCategories(user.id);
  await seedDefaultGroup(user.id);
  const cats = await listCategories(user.id);
  const cat = (name: string) => {
    const c = cats.find((x) => x.name === name);
    if (!c) throw new Error(`no category ${name}`);
    return c.id;
  };
  return { id: user.id, cat };
}
