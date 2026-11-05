import { createDatabase, setDb, type DB } from "@/db";
import { users } from "@/db/schema";
import { listCategories, seedDefaultCategories } from "@/server/categories";

/** Fresh in-memory DB (migrated) installed as the process-wide connection. Call in beforeEach. */
export function useFreshDb(): DB {
  const db = createDatabase(":memory:");
  setDb(db);
  return db;
}

/** Insert a user directly (skips scrypt for speed) and seed default categories. */
export function makeUser(db: DB, email: string) {
  const user = db
    .insert(users)
    .values({ email, name: email.split("@")[0], passwordHash: "x" })
    .returning()
    .get();
  seedDefaultCategories(user.id);
  const cats = listCategories(user.id);
  const cat = (name: string) => {
    const c = cats.find((x) => x.name === name);
    if (!c) throw new Error(`no category ${name}`);
    return c.id;
  };
  return { id: user.id, cat };
}
