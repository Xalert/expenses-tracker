/**
 * Demo data for local development: `npm run db:seed`.
 * Idempotent: if the demo user already exists nothing is written. A demo user seeded before user IDs existed
 * (found by its email; the 0001 migration derived the user ID `demo` for it) counts as existing.
 * Uses the same DB as the app (data/app.db, or DATABASE_URL). To start over, `npm run db:reset -- --demo`.
 */
import { getDb, resolveDatabasePath } from "@/db";
import { demoLoginLine } from "@/lib/demo";
import { findDemoUser, seedDemoData } from "@/server/maintenance";

async function main() {
  const db = getDb();
  console.log(`Database: ${resolveDatabasePath()}`);

  const existing = findDemoUser(db);
  if (existing) {
    console.log("Demo user already exists — nothing to do.");
    console.log(demoLoginLine(existing.username)); // a migrated demo user may have been given a suffixed user ID
    return;
  }

  const seeded = await seedDemoData();
  console.log(`Seeded demo user with 5 wallets and sample data for ${seeded.months[0]} and ${seeded.months[1]}.`);
  console.log(demoLoginLine(seeded.username));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
