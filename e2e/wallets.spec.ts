import { addDays } from "@/lib/dates";
import { expect, expectNoHorizontalOverflow, hydrated, test } from "./support/fixtures";
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

test.describe("reconcile balance", () => {
  test("reconcile from the ⋯ menu: the preview, the adjustment entry and the typed balance @phone", async ({ signedIn: page, user }) => {
    const today = todayISO();
    const bank = await seedWallet(user.id, { name: "Bank", currency: "EUR", initialBalanceMinor: 100_000 });
    await seedEntry(user.id, { walletId: bank.id, kind: "expense", category: "Food", amountMinor: 1_234, note: "lunch" });
    // A future-dated entry is "projected": the balance today, and so the reconciliation, leave it out.
    await seedEntry(user.id, { walletId: bank.id, kind: "expense", category: "Bills", amountMinor: 5_000, date: addDays(today, 3), note: "rent" });
    await page.goto(`/wallets/${bank.id}`);
    await hydrated(page);
    const balance = page.getByRole("region", { name: "Bank", exact: true }).getByRole("paragraph").first();
    await expect(balance).toHaveText("€987.66");
    await expect(page.getByText("€937.66 projected after the entries dated later")).toBeVisible();

    const trigger = page.getByRole("button", { name: "More actions for Bank" });
    await trigger.click();
    await page.getByRole("menuitem", { name: "Reconcile balance" }).click();
    const panel = page.getByRole("region", { name: "Reconcile balance" });
    const input = panel.getByLabel("Actual balance");
    await expect(input).toBeFocused();
    await expect(panel.getByText("Tracked balance at the end of today: €987.66.")).toBeVisible();
    await expectNoHorizontalOverflow(page);

    await input.fill("950");
    await expect(panel.getByText("This adds an expense of €37.66.")).toBeVisible();
    await panel.getByRole("button", { name: "Record adjustment" }).click();
    await expect(panel.getByRole("status")).toContainText("Added an expense of €37.66");
    await expect(balance).toHaveText("€950.00");
    await expect(panel.getByText("Tracked balance at the end of today: €950.00.")).toBeVisible();
    await expect(panel.getByLabel("Actual balance")).toHaveValue("");
    const entries = page.getByRole("region", { name: /^Entries in/ });
    await expect(entries.getByText("Balance adjustment").first()).toBeVisible();

    // A match records nothing.
    await panel.getByLabel("Actual balance").fill("950,00");
    await expect(panel.getByText("The balance already matches. Nothing will be added.")).toBeVisible();

    // Escape closes the panel and puts focus back on the ⋯ button.
    await panel.getByLabel("Actual balance").press("Escape");
    await expect(panel).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(page).toHaveURL(new RegExp(`/wallets/${bank.id}$`));
  });

  test.describe("without JavaScript", () => {
    test.use({ javaScriptEnabled: false });

    test("the reconcile form posts and the confirmation says what was recorded", async ({ signedIn: page, user }) => {
      const cash = await seedWallet(user.id, { name: "Cash", currency: "JPY", initialBalanceMinor: 5_000 });
      await page.goto(`/wallets/${cash.id}?reconcile=1`);
      const panel = page.getByRole("region", { name: "Reconcile balance" });
      await panel.getByLabel("Actual balance").fill("5 250");
      await panel.getByRole("button", { name: "Record adjustment" }).click();
      await expect(panel.getByRole("status")).toContainText("Added income of ¥250");
      await expect(page.getByRole("region", { name: "Cash", exact: true }).getByRole("paragraph").first()).toHaveText("¥5,250");
    });
  });
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
