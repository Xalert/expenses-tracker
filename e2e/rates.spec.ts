import { expect, hydrated, test } from "./support/fixtures";
import { seedEntry, seedWallet } from "./support/seed";

test("a manual rate on /rates feeds the All in views of Overview, Transactions and Categories (no provider) @phone", async ({ signedIn: page, user }) => {
  const bank = await seedWallet(user.id, { name: "Bank", currency: "EUR", initialBalanceMinor: 100_000 });
  const usd = await seedWallet(user.id, { name: "Dollars", currency: "USD", initialBalanceMinor: 20_000 });
  await seedEntry(user.id, { walletId: bank.id, kind: "expense", category: "Food", amountMinor: 1_000 });
  await seedEntry(user.id, { walletId: usd.id, kind: "expense", category: "Transport", amountMinor: 2_000 });

  // Without a rate the USD wallet is left out of the converted total.
  await page.goto("/?currency=EUR");
  const wallets = page.getByRole("region", { name: "Wallets" });
  await expect(wallets.getByText(/Not included: wallets in USD/)).toBeVisible();

  await page.goto("/rates");
  await hydrated(page);
  await expect(page.getByText(/EXCHANGE_RATES=false/)).toBeVisible();
  const form = page.getByRole("form", { name: "New rate for USD" });
  await form.getByLabel("1 USD =").fill("0,5");
  await form.getByRole("button", { name: "Save rate" }).click();
  await expect(page.getByText(/^Saved: from .*, 1 USD = 0\.5 EUR\.$/)).toBeVisible();

  // Overview, "All in EUR" (the default): the $180 balance counts as €90 in the total, the $20 expense as €10.
  await page.goto("/?currency=EUR");
  await expect(wallets.locator("p").filter({ hasText: /^Total in EUR/ })).toHaveText(/Total in EUR\s*≈ about €1,080\.00/);
  await expect(wallets.getByText(/Not included/)).toHaveCount(0);
  await expect(page.getByText("€20.00 spent so far")).toBeVisible();
  await page.getByRole("link", { name: "EUR only" }).click();
  await expect(page.getByText("€10.00 spent so far")).toBeVisible();

  await page.goto("/transactions?currency=EUR");
  await expect(page.getByRole("region", { name: "Spent per day · EUR" }).getByText(/^€20\.00 in /)).toBeVisible();

  await page.goto("/categories?currency=EUR");
  const split = page.getByRole("region", { name: "Spending split" });
  await expect(split.getByText(/^€20\.00 spent in /)).toBeVisible();
  await expect(split.getByRole("listitem").filter({ hasText: "Transport" })).toHaveText(/Transport\s*50%/);

  // Removing the rate takes USD out again.
  await page.goto("/rates");
  await hydrated(page);
  await page.getByRole("button", { name: /^Remove / }).click();
  await expect(page.getByText("No rate yet: wallets in USD are left out of the converted views.")).toBeVisible();
  await page.goto("/?currency=EUR");
  await expect(wallets.getByText(/Not included: wallets in USD/)).toBeVisible();
});
