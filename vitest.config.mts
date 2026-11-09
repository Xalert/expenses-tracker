import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      // `server-only` throws outside the react-server condition; services are plain modules in tests.
      "server-only": path.resolve(import.meta.dirname, "tests/stubs/server-only.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.{ts,tsx}"],
    // Tests run on PGlite (`useFreshDb()`); a test that reaches `getDb()` without it must fail, never fall back to
    // the default dev database (the owner's real data) — `.invalid` cannot resolve.
    env: { DATABASE_URL: "postgres://tests-must-use-pglite@db.invalid:1/none" },
  },
});
