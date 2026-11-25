import { expect, expectNoHorizontalOverflow, hydrated, test } from "./support/fixtures";
import { categoryByName, currentMonth, seedEntry, seedTransfer, seedWallet } from "./support/seed";

// /reports: the year view. Entries go into the previous year (a whole year in the past, whatever today is), plus one
// in the current month so the current year is not empty.
const thisYear = Number(currentMonth().slice(0, 4));
const lastYear = String(thisYear - 1);

async function seedYear(userId: number) {
  const bank = await seedWallet(userId, { name: "Bank", currency: "EUR", initialBalanceMinor: 100_000 });
  const savings = await seedWallet(userId, { name: "Savings", currency: "EUR" });
  await seedEntry(userId, { walletId: bank.id, kind: "expense", category: "Food", amountMinor: 1_000, date: `${lastYear}-01-10`, note: "january food" });
  await seedEntry(userId, { walletId: bank.id, kind: "expense", category: "Food", amountMinor: 2_000, date: `${lastYear}-03-05`, note: "march food" });
  await seedEntry(userId, { walletId: bank.id, kind: "expense", category: "Bills", amountMinor: 4_500, date: `${lastYear}-03-20`, note: "power" });
  await seedEntry(userId, { walletId: bank.id, kind: "income", category: "Salary", amountMinor: 100_000, date: `${lastYear}-03-31`, note: "pay" });
  await seedEntry(userId, { walletId: bank.id, kind: "expense", category: "Transport", amountMinor: 12_345, date: `${lastYear}-11-02` });
  // A transfer never counts.
  await seedTransfer(userId, { fromWalletId: bank.id, toWalletId: savings.id, amountMinor: 50_000, date: `${lastYear}-03-15` });
  await seedEntry(userId, { walletId: bank.id, kind: "expense", category: "Food", amountMinor: 700, note: "this year" });
  return bank;
}

test("Reports from the menu: last year's totals, and a cell opens the filtered list @phone", async ({ signedIn: page, user }) => {
  await seedYear(user.id);
  const food = await categoryByName(user.id, "Food");
  await page.goto("/");
  await hydrated(page);
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Reports" }).click();
  await expect(page).toHaveURL(/\/reports$/);
  await expect(page.getByRole("heading", { level: 1, name: "Reports" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Reports", exact: true })).toHaveAttribute("aria-current", "page");

  await page.getByRole("link", { name: `Previous year, ${lastYear}` }).click();
  await expect(page).toHaveURL(new RegExp(`/reports\\?year=${lastYear}$`));
  const totals = page.getByRole("region", { name: `The whole of ${lastYear}, against ${thisYear - 2}` });
  const card = (title: string) => totals.locator("section", { has: page.getByRole("heading", { name: title, exact: true }) });
  await expect(card("Income")).toContainText("€1,000.00");
  await expect(card("Expenses")).toContainText("€198.45");
  await expect(card("Net")).toContainText("+€801.55");
  await expect(page.getByRole("img", { name: new RegExp(`Income and expenses per month in EUR, ${lastYear}`) })).toBeVisible();

  const expenses = page.getByRole("region", { name: "Expenses by category" });
  // Largest first: Transport, Bills, Food.
  await expect(expenses.getByRole("rowheader")).toHaveText(["Transport", "Bills", "Food", "Total"]);
  const cell = expenses.getByRole("link", { name: `Food, March ${lastYear}: €20.00` });
  await expect(cell).toHaveText("20");
  await cell.click();
  await expect(page).toHaveURL(new RegExp(`/transactions\\?month=${lastYear}-03&category=${food.id}&currency=EUR$`));
  await hydrated(page);
  await expect(page.getByRole("button", { name: /^Food march food/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /january food/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /power/ })).toHaveCount(0);
});

for (const colorScheme of ["light", "dark"] as const) {
  test(`/reports at 375px in the ${colorScheme} scheme: the tables scroll inside their cards, the page does not @phone-only`, async ({ signedIn: page, user }) => {
    await page.emulateMedia({ colorScheme });
    await seedYear(user.id);
    for (const path of ["/reports", `/reports?year=${lastYear}`, `/reports?year=${thisYear - 5}`]) {
      await page.goto(path);
      await hydrated(page);
      await expectNoHorizontalOverflow(page);
    }
    await page.goto(`/reports?year=${lastYear}`);
    const scroller = page.getByRole("region", { name: "Expenses by category" }).locator("div.overflow-x-auto");
    const { scroll, client } = await scroller.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
    expect(scroll).toBeGreaterThan(client);
    // The category column stays in view when the table is scrolled to its end.
    await scroller.evaluate((el) => el.scrollTo({ left: el.scrollWidth }));
    await expect.poll(() => scroller.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
    const box = (await scroller.boundingBox())!;
    const header = (await page.getByRole("region", { name: "Expenses by category" }).getByRole("rowheader", { name: "Transport" }).boundingBox())!;
    expect(Math.abs(header.x - box.x)).toBeLessThanOrEqual(1);
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const [r, g, b] = bg.match(/\d+(\.\d+)?/g)!.map(Number);
    expect((r + g + b) / 3 > 128).toBe(colorScheme === "light");
  });
}

test("an empty year shows its empty state", async ({ signedIn: page, user }) => {
  await seedYear(user.id);
  await page.goto(`/reports?year=${thisYear - 5}`);
  await expect(page.getByRole("heading", { name: `No entries in ${thisYear - 5}` })).toBeVisible();
  await expect(page.getByRole("img")).toHaveCount(0);
});
