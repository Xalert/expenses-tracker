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
