/**
 * The demo account that `npm run db:seed` / `npm run db:reset -- --demo` create for local development, and the one
 * line every place that mentions it prints (the seed and reset scripts, and the dev server on startup).
 * No `server-only`: `src/db/index.ts` imports it.
 */
export const DEMO_USER = {
  username: "demo",
  email: "demo@example.com",
  firstName: "Demo",
  lastName: "User",
  password: "demo-password",
} as const;

/** `[demo] Sign in with user ID demo / password demo-password (if unchanged)`. */
export function demoLoginLine(username: string = DEMO_USER.username): string {
  return `[demo] Sign in with user ID ${username} / password ${DEMO_USER.password} (if unchanged)`;
}
