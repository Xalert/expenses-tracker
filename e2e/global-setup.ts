import { createDatabase } from "@/db";
import { wipeAllData } from "@/server/maintenance";

/**
 * Start every run on an empty database (playwright.config.ts has already refused any database whose name lacks
 * "e2e"). The web server has migrated it by now: its readiness URL is /api/health, which opens the database.
 */
export default async function globalSetup() {
  const db = await createDatabase(process.env.E2E_DATABASE_URL);
  await wipeAllData(db);
  // The node-postgres pool behind this handle; ended so the setup process can exit.
  await (db as unknown as { $client: { end(): Promise<void> } }).$client.end();
}
