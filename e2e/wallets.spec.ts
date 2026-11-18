import { addDays } from "@/lib/dates";
import { expect, hydrated, test } from "./support/fixtures";
import { seedEntry, seedGroup, seedWallet, todayISO } from "./support/seed";

test("the wallet page shows the balance after each day, and a projected one for a future-dated entry", async ({ signedIn: page, user }) => {
  const today = todayISO();
  const tomorrow = addDays(today, 1);
  test.skip(tomorrow.slice(0, 7) !== today.slice(0, 7), "needs a day after today in this month");
  const bank = await seedWallet(user.id, { name: "Bank", currency: "EUR", initialBalanceMinor: 100_000 });
  await seedEntry(user.id, { walletId: bank.id, kind: "expense", category: "Food", amountMinor: 1_234, note: "today" });
  await seedEntry(user.id, { walletId: bank.id, kind: "expense", category: "Bills", amountMinor: 5_000, date: tomorrow, note: "rent" });
  await page.goto(`/wallets/${bank.id}`);
  await expect(page.getByText("Balance after €987.66", { exact: true })).toBeVisible();
  await expect(page.getByText("Balance after €937.66 · projected", { exact: true })).toBeVisible();
});

test.describe("wallet groups", () => {
  test("move, recolour, archive and unarchive a group @phone", async ({ signedIn: page, user }) => {
    await seedGroup(user.id, "Work");
    await seedGroup(user.id, "Travel");
    await page.goto("/wallets");
    await hydrated(page);
    const groups = page.getByRole("region", { name: /^Groups · 3 groups/ });
    const names = () => groups.getByRole("listitem").getByRole("button").filter({ hasText: /wallet/ }).allInnerTexts();
    expect((await names()).map((n) => n.split("\n")[0])).toEqual(["Personal", "Work", "Travel"]);

    // Move Travel up: a plain form post.
    await groups.getByRole("button", { name: "Move Travel up" }).click();
    await expect.poll(async () => (await names()).map((n) => n.split("\n")[0])).toEqual(["Personal", "Travel", "Work"]);
    await expect(groups.getByRole("button", { name: "Move Personal up" })).toBeDisabled();

    // Recolour Work teal.
    await groups.getByRole("button", { name: /^Work / }).click();
    const name = groups.getByLabel("Name of “Work”");
    await expect(name).toBeFocused();
    const form = groups.locator("form").filter({ has: page.getByLabel("Name of “Work”") });
    await form.getByTitle("Teal").click();
    await expect(form.getByRole("radio", { name: "Teal" })).toBeChecked();
    await form.getByRole("button", { name: "Save", exact: true }).click();
    await expect(groups.locator('[data-group-color="teal"]')).toHaveCount(1);

    // Archive Travel (it has no wallets): it moves to the closed "Archived groups" section.
    page.once("dialog", (d) => d.accept());
    await groups.getByRole("button", { name: /^Travel / }).click();
    await groups.getByRole("button", { name: "Archive Travel" }).click();
    await expect(page.getByRole("region", { name: /^Groups · 2 groups/ })).toBeVisible();
    const archived = page.getByText("Archived groups · 1");
    await expect(archived).toBeVisible();
    await archived.click();
    // Rename it in place without unarchiving.
    await page.getByRole("button", { name: "Rename or recolour Travel" }).click();
    await expect(page.getByLabel("Name of “Travel”")).toBeFocused();
    await page.getByLabel("Name of “Travel”").fill("Trips");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("button", { name: "Rename or recolour Trips" })).toBeFocused();
    await page.getByRole("button", { name: "Unarchive" }).click();
    await expect(page.getByRole("region", { name: /^Groups · 3 groups/ })).toBeVisible();
    await expect(page.getByText(/^Archived groups/)).toHaveCount(0);
  });

  test("with two groups the top bar switcher scopes the Overview", async ({ signedIn: page, user }) => {
    const work = await seedGroup(user.id, "Work");
    await seedWallet(user.id, { name: "Bank", currency: "EUR", initialBalanceMinor: 1_000 });
    await seedWallet(user.id, { name: "Company card", currency: "EUR", initialBalanceMinor: 2_000, groupId: work.id });
    await page.goto("/");
    await hydrated(page);
    const switcher = page.getByRole("banner").getByRole("combobox");
    await switcher.selectOption({ label: "Work" });
    await expect(page.getByRole("region", { name: "Wallets" }).getByRole("link", { name: /^Company card/ })).toBeVisible();
    await expect(page.getByRole("region", { name: "Wallets" }).getByRole("link", { name: /^Bank/ })).toHaveCount(0);
  });
});
