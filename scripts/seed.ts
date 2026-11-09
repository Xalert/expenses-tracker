/**
 * Demo data for local development: `npm run db:seed`.
 * Idempotent: if the demo user already exists nothing is written.
 * Uses the same database as the app (DATABASE_URL, or the dev default in .env.example). To start over,
 * `npm run db:reset -- --demo`.
 */
import { describeDatabase, getDb } from "@/db";
import { demoLoginLine } from "@/lib/demo";
import { findDemoUser, seedDemoData } from "@/server/maintenance";

async function main() {
  console.log(`Database: ${describeDatabase()}`);
  const db = await getDb(); // connects and applies pending migrations

  const existing = await findDemoUser(db);
  if (existing) {
    console.log("Demo user already exists — nothing to do.");
    console.log(demoLoginLine(existing.username));
    return;
  }

  const seeded = await seedDemoData();
  console.log(`Seeded demo user with 5 wallets and sample data for ${seeded.months[0]} and ${seeded.months[1]}.`);
  console.log(demoLoginLine(seeded.username));
}

main()
  .then(() => process.exit(0)) // the connection pool would keep the process alive
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
