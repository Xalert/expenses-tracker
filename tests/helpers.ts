import { createDatabase, setDb, type DB } from "@/db";
import { users } from "@/db/schema";
import { listCategories, seedDefaultCategories } from "@/server/categories";
import { seedDefaultGroup } from "@/server/wallet-groups";

/** Fresh in-memory DB (migrated) installed as the process-wide connection. Call in beforeEach. */
export function useFreshDb(): DB {
  const db = createDatabase(":memory:");
  setDb(db);
  return db;
}

/**
 * Insert a user directly (skips scrypt for speed) and seed default categories and the default group. The user ID is the email with
 * `@` (and anything else not allowed) turned into `-`, so distinct emails give distinct user IDs.
 */
export function makeUser(db: DB, email: string) {
  const username = email.toLowerCase().replace(/[^a-z0-9._-]/g, "-");
  const user = db
    .insert(users)
    .values({ username, email, firstName: email.split("@")[0], passwordHash: "x" })
    .returning()
    .get();
  seedDefaultCategories(user.id);
  seedDefaultGroup(user.id);
  const cats = listCategories(user.id);
  const cat = (name: string) => {
    const c = cats.find((x) => x.name === name);
    if (!c) throw new Error(`no category ${name}`);
    return c.id;
  };
  return { id: user.id, cat };
}
