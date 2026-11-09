import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { PGlite } from "@electric-sql/pglite";
import { resolveMigrationsDir, type DB } from "./index";
import * as schema from "./schema";

// Tests only (a devDependency): kept out of src/db/index.ts so the app bundle never references PGlite.

/** An in-memory PGlite database (real Postgres, in process) with the migrations applied. */
export async function createTestDatabase(): Promise<DB> {
  const db = drizzle({ client: new PGlite(), schema });
  await migrate(db, { migrationsFolder: resolveMigrationsDir() });
  return db as unknown as DB;
}
