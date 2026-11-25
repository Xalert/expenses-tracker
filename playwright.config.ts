import path from "node:path";
import { defineConfig } from "@playwright/test";

/**
 * End-to-end browser tests (e2e/). Run them with `npm run test:e2e` (scripts/e2e.mjs), which starts a throwaway
 * Postgres, builds, and calls `playwright test`; running `npx playwright test` directly needs E2E_DATABASE_URL and a
 * finished build. See docs/DEVELOPMENT.md "End-to-end tests".
 *
 * Projects: `desktop` (Chromium, 1280px) runs every test except those tagged `@phone-only`; `phone` (Chromium, 375px,
 * touch) runs the tests tagged `@phone` or `@phone-only`. `desktop-firefox` and `desktop-webkit` run the desktop tests
 * in Firefox and WebKit; `phone-webkit` runs the phone tests in WebKit (the nearest to iOS Safari Playwright has;
 * Firefox has no `isMobile`, so there is no Firefox phone project). `--project=desktop` etc. picks one.
 */
const desktop = { viewport: { width: 1280, height: 800 } };
const phone = { viewport: { width: 375, height: 740 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const databaseUrl = process.env.E2E_DATABASE_URL ?? "";
// The suite wipes this database (e2e/global-setup.ts): never let it point at the development data.
if (!databaseUrl) throw new Error("E2E_DATABASE_URL is not set. Run the suite with `npm run test:e2e`.");
const dbName = new URL(databaseUrl).pathname.slice(1);
if (!dbName.includes("e2e") || new URL(databaseUrl).port === "5433") {
  throw new Error(`Refusing E2E_DATABASE_URL ${dbName}: the e2e database name must contain "e2e" (and not be on 5433).`);
}
// The seeding helpers (e2e/support/seed.ts) call the app's services in this process.
process.env.DATABASE_URL = databaseUrl;

const port = Number(process.env.E2E_PORT ?? 3100);
export const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "e2e",
  // `server-only` stubbed and `@/` mapped for the seeding helpers (they import src/server/*).
  tsconfig: "./e2e/tsconfig.json",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : 4,
  timeout: 45_000,
  expect: { timeout: 7_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    locale: "en-GB",
    timezoneId: "Europe/Berlin",
  },
  projects: [
    { name: "desktop", grepInvert: /@phone-only/, use: { browserName: "chromium", ...desktop } },
    { name: "phone", grep: /@phone/, use: { browserName: "chromium", ...phone } },
    { name: "desktop-firefox", grepInvert: /@phone-only/, use: { browserName: "firefox", ...desktop } },
    { name: "desktop-webkit", grepInvert: /@phone-only/, use: { browserName: "webkit", ...desktop } },
    { name: "phone-webkit", grep: /@phone/, use: { browserName: "webkit", ...phone } },
  ],
  webServer: {
    command: "node .next/standalone/server.js",
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      NODE_ENV: "production",
      PORT: String(port),
      HOSTNAME: "127.0.0.1",
      DATABASE_URL: databaseUrl,
      // No network: the "All in" views run on manual rates only.
      EXCHANGE_RATES: "false",
      MIGRATIONS_DIR: path.resolve("drizzle"),
      NEXT_TELEMETRY_DISABLED: "1",
    },
  },
});
