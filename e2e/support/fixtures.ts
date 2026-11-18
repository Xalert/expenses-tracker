import { test as base, expect, type BrowserContext, type Page } from "@playwright/test";
import { seedUser, SESSION_COOKIE, type SeededUser } from "./seed";

type Fixtures = {
  /** A fresh user with default categories and group (no wallets), not yet signed in. */
  user: SeededUser;
  /** `page`, signed in as `user`. */
  signedIn: Page;
  /** Console errors and uncaught page errors seen during the test; the test fails on any (see `allowConsoleErrors`). */
  consoleErrors: string[];
  /** Patterns of console errors a test expects (e.g. an intentionally refused upload). */
  allowConsoleErrors: RegExp[];
};

/** Set the session cookie of `user` on `context`. */
export async function signInContext(context: BrowserContext, token: string, baseURL: string) {
  await context.addCookies([{ name: SESSION_COOKIE, value: token, url: baseURL, httpOnly: true, sameSite: "Lax" }]);
}

export const test = base.extend<Fixtures>({
  allowConsoleErrors: [[], { option: true }],
  consoleErrors: [
    async ({ page, allowConsoleErrors }, use) => {
      const errors: string[] = [];
      page.on("console", (msg) => {
        if (msg.type() === "error") errors.push(msg.text());
      });
      page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
      await use(errors);
      const unexpected = errors.filter((e) => !allowConsoleErrors.some((re) => re.test(e)));
      expect(unexpected, "console errors").toEqual([]);
    },
    { auto: true },
  ],
  user: async ({}, use) => {
    await use(await seedUser());
  },
  signedIn: async ({ page, context, user, baseURL }, use) => {
    await signInContext(context, user.token, baseURL!);
    await use(page);
  },
});

export { expect };

/** Fail when the page scrolls sideways (the 375px rule): the document is wider than the viewport. */
export async function expectNoHorizontalOverflow(page: Page) {
  const { scroll, client } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(scroll, `${new URL(page.url()).pathname} is ${scroll}px wide in a ${client}px viewport`).toBeLessThanOrEqual(client);
}

/** Wait until client components have hydrated (the shell's N shortcut and dialogs need it). */
export async function hydrated(page: Page) {
  await page.waitForFunction(() => document.readyState === "complete");
  await page.waitForLoadState("networkidle");
}
