import { expect, hydrated, test } from "./support/fixtures";
import { seedEntry, seedWallet } from "./support/seed";

async function threeEntries(userId: number) {
  const bank = await seedWallet(userId, { name: "Bank", currency: "EUR", initialBalanceMinor: 100_000 });
  await seedEntry(userId, { walletId: bank.id, kind: "expense", category: "Food", amountMinor: 100, note: "first" });
  await seedEntry(userId, { walletId: bank.id, kind: "expense", category: "Food", amountMinor: 200, note: "second" });
  await seedEntry(userId, { walletId: bank.id, kind: "expense", category: "Food", amountMinor: 300, note: "third" });
  return bank;
}

const row = (name: RegExp) => ({ name });

test.describe("/transactions rows", () => {
  test("opening a row moves focus into its form; Escape returns it to the row", async ({ signedIn: page, user }) => {
    await threeEntries(user.id);
    await page.goto("/transactions");
    await hydrated(page);
    const second = page.getByRole("button", row(/^Food second/));
    await second.click();
    // The first field of the row's form: the checked Type radio.
    await expect(page.getByRole("radio", { name: "Expense" })).toBeFocused();
    await expect(page.getByRole("textbox", { name: "Amount" })).toHaveValue("2.00");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("textbox", { name: "Amount" })).toHaveCount(0);
    await expect(second).toBeFocused();
  });

  test("after a Delete focus lands on the next row, and on the heading when the list is empty", async ({ signedIn: page, user }) => {
    await threeEntries(user.id);
    await page.goto("/transactions");
    await hydrated(page);
    page.on("dialog", (d) => d.accept());

    // Newest first: third, second, first. Delete the middle one: focus moves to the next row ("first").
    await page.getByRole("button", row(/^Food second/)).click();
    await page.getByRole("button", { name: "Delete" }).click();
    await expect(page.getByRole("button", row(/^Food second/))).toHaveCount(0);
    await expect(page.getByRole("button", row(/^Food first/))).toBeFocused();

    // The last row: focus goes to the previous one.
    await page.getByRole("button", row(/^Food first/)).click();
    await page.getByRole("button", { name: "Delete" }).click();
    await expect(page.getByRole("button", row(/^Food first/))).toHaveCount(0);
    await expect(page.getByRole("button", row(/^Food third/))).toBeFocused();

    // The only row: focus goes to the list heading.
    await page.getByRole("button", row(/^Food third/)).click();
    await page.getByRole("button", { name: "Delete" }).click();
    await expect(page.getByRole("button", row(/^Food third/))).toHaveCount(0);
    const focused = page.locator(":focus");
    await expect(focused).toHaveCount(1);
    expect(await focused.evaluate((el) => el.tagName)).toMatch(/^H[1-3]$/);
  });

  test("a save that moves the entry to another month hands focus to a neighbour", async ({ signedIn: page, user }) => {
    await threeEntries(user.id);
    await page.goto("/transactions");
    await hydrated(page);
    await page.getByRole("button", row(/^Food second/)).click();
    await page.getByRole("combobox", { name: "Choose another date" }).click();
    const picker = page.getByRole("dialog", { name: "Choose a date" });
    await picker.getByRole("button", { name: /^Previous month, / }).click();
    await picker.getByRole("gridcell").filter({ hasText: /^1$/ }).first().click();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("button", row(/^Food second/))).toHaveCount(0);
    await expect(page.getByRole("button", row(/^Food first/))).toBeFocused();
  });

  test("an empty search keeps the URL clean; a search adds q", async ({ signedIn: page, user }) => {
    await threeEntries(user.id);
    await page.goto("/transactions");
    await hydrated(page);
    const search = page.getByRole("searchbox", { name: "Search notes" });
    await search.fill("SECOND");
    await search.press("Enter");
    await expect(page).toHaveURL(/\/transactions\?q=SECOND$/);
    await expect(page.getByRole("button", row(/^Food/))).toHaveCount(1);
    await search.fill("   ");
    await search.press("Enter");
    await expect(page).toHaveURL(/\/transactions$/);
    await expect(page.getByRole("button", row(/^Food/))).toHaveCount(3);
    // A URL with empty fields (what a no-JS form sends) redirects to the clean one.
    await page.goto("/transactions?q=&wallet=&kind=");
    await expect(page).toHaveURL(/\/transactions$/);
  });
});

test.describe("/transactions without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("the noscript filter form filters by type and the popover chips are hidden", async ({ signedIn: page, user }) => {
    await threeEntries(user.id);
    const bank = await seedWallet(user.id, { name: "Spare", currency: "EUR" });
    await seedEntry(user.id, { walletId: bank.id, kind: "income", category: "Salary", amountMinor: 5000, note: "pay" });
    await page.goto("/transactions");
    const filters = page.getByRole("form", { name: "Filters" });
    await expect(filters).toBeVisible();
    // The JS chips ("Wallet", "Type", "Category" buttons) are hidden by the <style> inside <noscript>.
    await expect(page.getByRole("button", { name: "Type", exact: true })).toBeHidden();
    await filters.getByLabel("Type").selectOption({ label: "Income" });
    await filters.getByRole("button").click();
    // Empty selects ("All wallets") are dropped by the redirect.
    await expect(page).toHaveURL(/\/transactions\?kind=income$/);
    await expect(page.getByText("pay")).toBeVisible();
    await expect(page.getByText("second")).toHaveCount(0);
    // A search submitted without JS leaves `q=` out once empty.
    await page.getByRole("searchbox", { name: "Search notes" }).fill("");
    await page.getByRole("searchbox", { name: "Search notes" }).press("Enter");
    await expect(page).toHaveURL(/\/transactions\?kind=income$/);
  });
});

test("the phone's Pick a day calendar lists one day @phone-only", async ({ signedIn: page, user }) => {
  await threeEntries(user.id);
  await page.goto("/transactions");
  await page.getByText("Pick a day").click();
  const days = page.getByRole("table", { name: /^Days of / });
  await expect(days).toBeVisible();
  const box = (await days.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(375);
  // Every day link is a 44px target.
  const first = days.getByRole("link").first();
  const target = (await first.boundingBox())!;
  expect(target.height).toBeGreaterThanOrEqual(44);
  const today = new Date();
  const label = `${today.getDate()} ${today.toLocaleString("en-GB", { month: "long" })}`;
  await days.getByRole("link", { name: new RegExp(`^${label}:`) }).click();
  await expect(page).toHaveURL(/from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}/);
  await expect(page.getByRole("button", row(/^Food/))).toHaveCount(3);
});
