import { expect, hydrated, test } from "./support/fixtures";
import { seedEntry, seedWallet } from "./support/seed";

const expenseList = (page: import("@playwright/test").Page) => page.getByRole("region", { name: /^Expense · / });
const incomeList = (page: import("@playwright/test").Page) => page.getByRole("region", { name: /^Income · / });

test("an unused category changes kind; its row moves to the other card and keeps the focus @phone", async ({ signedIn: page }) => {
  await page.goto("/categories");
  await hydrated(page);
  await expenseList(page).getByRole("button", { name: /^Transport\b/ }).click();
  await page.getByRole("button", { name: "Make it an income category" }).click();
  await expect(page.getByRole("region", { name: "Expense · 4 categories" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Income · 4 categories" })).toBeVisible();
  const moved = incomeList(page).getByRole("button", { name: /^Transport\b/ });
  await expect(moved).toBeVisible();
  await expect(moved).toBeFocused();
});

test("a used category cannot change kind; archiving hides it from the entry form but not from its entry", async ({ signedIn: page, user }) => {
  const bank = await seedWallet(user.id, { name: "Bank", currency: "EUR", initialBalanceMinor: 10_000 });
  await seedEntry(user.id, { walletId: bank.id, kind: "expense", category: "Food", amountMinor: 450, note: "lunch" });
  await page.goto("/categories");
  await hydrated(page);
  await expenseList(page).getByRole("button", { name: /^Food\b/ }).click();
  await expect(page.getByText(/Used by 1 (entry|transaction), so it stays an expense category/)).toBeVisible();
  await page.getByRole("button", { name: "Archive", exact: true }).click();
  const archived = expenseList(page).getByRole("list", { name: "Archived · 1 category" });
  await expect(archived.getByRole("button", { name: /^Food/ })).toBeVisible();

  await page.goto("/transactions/new");
  await expect(page.getByRole("radio", { name: "Groceries" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "Food" })).toHaveCount(0);

  // The entry that uses it still shows it, marked archived, in its inline editor.
  await page.goto("/transactions");
  await hydrated(page);
  await page.getByRole("button", { name: /^Food lunch/ }).click();
  await expect(page.getByRole("radio", { name: "Food (archived)" })).toBeChecked();
  await page.keyboard.press("Escape");

  await page.goto("/categories");
  await hydrated(page);
  await archived.getByRole("button", { name: /^Food/ }).click();
  await page.getByRole("button", { name: "Unarchive" }).click();
  await expect(archived).toHaveCount(0);
  await expect(expenseList(page).getByRole("button", { name: /^Food/ })).toBeVisible();
});

test("setting a budget shows its progress on /categories and the Overview; a refused amount is kept @phone", async ({ signedIn: page, user }) => {
  const bank = await seedWallet(user.id, { name: "Bank", currency: "EUR", initialBalanceMinor: 100_000 });
  await seedEntry(user.id, { walletId: bank.id, kind: "expense", category: "Food", amountMinor: 1_200, note: "lunch" });
  await page.goto("/categories");
  await hydrated(page);
  await expenseList(page).getByRole("button", { name: /^Food\b/ }).click();
  const amount = page.getByLabel("Monthly budget for “Food”");
  await amount.fill("12.345");
  await page.getByRole("button", { name: "Set budget" }).click();
  // Refused: the error is on the field and the typed amount is still there.
  await expect(amount).toHaveAttribute("aria-invalid", "true");
  await expect(amount).toHaveValue("12.345");
  await expect(page.getByText("Enter a valid amount in EUR (up to 2 decimals).")).toBeVisible();

  await amount.fill("40");
  await page.getByRole("button", { name: "Set budget" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Budget for “Food”: €40.00 a month." })).toBeVisible();
  const food = expenseList(page).getByRole("button", { name: /^Food\b/ });
  await expect(food).toContainText("€12.00 of €40.00");
  await expect(food).toContainText("€28.00 left");
  await expect(food).toContainText(/30% spent · day \d+ of \d+/);

  // The overall budget, from its own row.
  await expenseList(page).getByRole("button", { name: /^Overall budget/ }).click();
  await page.getByLabel("Monthly budget for all spending").fill("10");
  await page.getByRole("button", { name: "Set budget" }).click();
  const overall = expenseList(page).getByRole("button", { name: /^Overall budget/ });
  await expect(overall).toContainText("€10.00 a month");
  await expect(overall).toContainText("€2.00 over");

  await page.goto("/");
  const card = page.getByRole("region", { name: "Budgets" });
  await expect(card).toContainText("All spending");
  await expect(card).toContainText("€12.00 of €10.00");
  await expect(card).toContainText("Food");
  await card.getByRole("link", { name: "Manage budgets" }).click();
  await expect(page).toHaveURL(/\/categories$/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    await page.evaluate(() => window.innerWidth),
  );

  // Removed again from the row's editor.
  await hydrated(page);
  await expenseList(page).getByRole("button", { name: /^Food\b/ }).click();
  await page.getByRole("button", { name: "Remove the budget for Food" }).click();
  await expect(expenseList(page).getByRole("button", { name: /^Food\b/ })).not.toContainText("of €40.00");
});

test("picking a colour shows a dot next to the category on /categories and in the entry form", async ({ signedIn: page, user }) => {
  await seedWallet(user.id, { name: "Bank", currency: "EUR" });
  await page.goto("/categories");
  await hydrated(page);
  await expenseList(page).getByRole("button", { name: /^Groceries\b/ }).click();
  const colours = page.getByRole("group", { name: "Colour" });
  await expect(colours.getByRole("radio", { name: "No colour" })).toBeChecked();
  // Keyboard: the radios move with the arrow keys.
  await colours.getByRole("radio", { name: "No colour" }).focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(colours.getByRole("radio", { name: "Amber" })).toBeChecked();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved “Groceries”." })).toBeVisible();
  const row = expenseList(page).getByRole("button", { name: /^Groceries\b/ });
  await expect(row.locator('[data-group-color="amber"]')).toHaveCount(1);

  await page.goto("/transactions/new");
  const pill = page.locator("label").filter({ has: page.getByRole("radio", { name: "Groceries" }) });
  await expect(pill.locator('[data-group-color="amber"]')).toHaveCount(1);
  await expect(page.locator("label").filter({ has: page.getByRole("radio", { name: "Food" }) }).locator("[data-group-color]")).toHaveCount(0);
});

test("removing a used category into a new one: a refused name keeps the choice, then the entries move", async ({ signedIn: page, user }) => {
  const bank = await seedWallet(user.id, { name: "Bank", currency: "EUR", initialBalanceMinor: 10_000 });
  await seedEntry(user.id, { walletId: bank.id, kind: "expense", category: "Groceries", amountMinor: 1_999, note: "market" });
  await page.goto("/categories");
  await hydrated(page);
  await expenseList(page).getByRole("button", { name: /^Groceries\b/ }).click();
  const target = page.getByLabel(/^Remove, moving its 1 \w+ to$/);
  await target.selectOption({ label: "A new expense category…" });
  const name = page.getByLabel("Name of the new expense category");
  await name.fill("food");
  await page.getByRole("button", { name: "Remove Groceries" }).click();
  // Refused (the name is taken): the select still says "A new … category" and the typed name is back.
  await expect(name).toHaveAttribute("aria-invalid", "true");
  await expect(target.locator("option:checked")).toHaveText("A new expense category…");
  await expect(name).toHaveValue("food");

  await name.fill("Supermarket");
  await page.getByRole("button", { name: "Remove Groceries" }).click();
  await expect(expenseList(page).getByRole("button", { name: /^Groceries\b/ })).toHaveCount(0);
  await expect(expenseList(page).getByRole("button", { name: /^Supermarket\b.*1 this month/ })).toBeVisible();
  await page.goto("/transactions");
  await expect(page.getByRole("button", { name: /^Supermarket market/ })).toBeVisible();
});
