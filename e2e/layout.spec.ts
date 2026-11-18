import { expect, expectNoHorizontalOverflow, hydrated, test } from "./support/fixtures";
import { seedEntry, seedGroup, seedTransfer, seedWallet } from "./support/seed";

// Every main page, with enough data to fill its cards, at 375px in both colour schemes: nothing scrolls sideways and
// nothing logs a console error (the fixture checks that after each test).
const PAGES = ["/", "/transactions", "/transactions/new", "/wallets", "/wallets/new", "/categories", "/data", "/account", "/rates"];

for (const colorScheme of ["light", "dark"] as const) {
  test.describe(`${colorScheme} scheme`, () => {
    test.use({ colorScheme });

    test(`no horizontal overflow at 375px on the main pages @phone-only`, async ({ signedIn: page, user }) => {
      const work = await seedGroup(user.id, "A rather long group name for work");
      const bank = await seedWallet(user.id, { name: "Everyday bank account with a long name", currency: "EUR", initialBalanceMinor: 1_234_567 });
      const usd = await seedWallet(user.id, { name: "Dollars", currency: "USD", initialBalanceMinor: 20_000, groupId: work.id });
      const jpy = await seedWallet(user.id, { name: "Yen", currency: "JPY", initialBalanceMinor: 50_000 });
      await seedEntry(user.id, { walletId: bank.id, kind: "expense", category: "Groceries", amountMinor: 123_456, note: "a fairly long note that should wrap or truncate rather than push the page wider" });
      await seedEntry(user.id, { walletId: bank.id, kind: "income", category: "Salary", amountMinor: 9_876_543 });
      await seedEntry(user.id, { walletId: jpy.id, kind: "expense", category: "Food", amountMinor: 1_200 });
      await seedTransfer(user.id, { fromWalletId: bank.id, toWalletId: usd.id, amountMinor: 10_000, receivedAmountMinor: 10_800 });
      const pages = [...PAGES, `/wallets/${bank.id}`, `/wallets/${bank.id}/edit`];
      for (const path of pages) {
        await page.goto(path);
        await hydrated(page);
        await expect(page.locator("main")).toBeVisible();
        await expectNoHorizontalOverflow(page);
      }
      // Theme check: the body background follows the scheme.
      const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      const [r, g, b] = bg.match(/\d+(\.\d+)?/g)!.map(Number);
      const light = (r + g + b) / 3 > 128;
      expect(light).toBe(colorScheme === "light");
    });
  });
}

test("no horizontal overflow at 375px on the sign-in and register pages @phone-only", async ({ page }) => {
  for (const path of ["/login", "/register", "/login?deleted=1"]) {
    await page.goto(path);
    await hydrated(page);
    await expectNoHorizontalOverflow(page);
  }
});

test("the main pages render without console errors at 1280px", async ({ signedIn: page, user }) => {
  const bank = await seedWallet(user.id, { name: "Bank", currency: "EUR", initialBalanceMinor: 1_000 });
  await seedEntry(user.id, { walletId: bank.id, kind: "expense", category: "Food", amountMinor: 100 });
  for (const path of [...PAGES, `/wallets/${bank.id}`]) {
    await page.goto(path);
    await hydrated(page);
    await expect(page.locator("main")).toBeVisible();
    await expectNoHorizontalOverflow(page);
  }
});
