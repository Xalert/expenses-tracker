import { expect, expectNoHorizontalOverflow, hydrated, test } from "./support/fixtures";
import { currentMonth, seedEntry, seedTransfer, seedWallet } from "./support/seed";

// The richer filters, selection mode (bulk edit) and "Duplicate" on /transactions (SPEC /transactions; DECISIONS
// "Filters and bulk edit").

test.describe("filters", () => {
  test("filter by two categories and by an amount range @phone", async ({ signedIn: page, user }) => {
    const bank = await seedWallet(user.id, { name: "Bank", currency: "EUR", initialBalanceMinor: 100_000 });
    const yen = await seedWallet(user.id, { name: "Yen", currency: "JPY" });
    await seedEntry(user.id, { walletId: bank.id, kind: "expense", category: "Food", amountMinor: 500, note: "small food" });
    await seedEntry(user.id, { walletId: bank.id, kind: "expense", category: "Food", amountMinor: 4_000, note: "big food" });
    await seedEntry(user.id, { walletId: bank.id, kind: "expense", category: "Groceries", amountMinor: 2_500, note: "market" });
    await seedEntry(user.id, { walletId: bank.id, kind: "expense", category: "Bills", amountMinor: 3_000, note: "power" });
    await seedEntry(user.id, { walletId: yen.id, kind: "expense", category: "Food", amountMinor: 3_000, note: "ramen" });
    await page.goto("/transactions");
    await hydrated(page);

    // Two categories: the panel stays open while options toggle.
    await page.getByRole("button", { name: "Category", exact: true }).click();
    const panel = page.getByRole("listbox", { name: "Category" });
    await expect(panel).toHaveAttribute("aria-multiselectable", "true");
    await panel.getByRole("option", { name: "Food" }).click();
    await expect(page).toHaveURL(/[?&]category=\d+$/);
    await panel.getByRole("option", { name: "Groceries" }).click();
    await expect(page).toHaveURL(/[?&]category=\d+,\d+$/);
    await expect(panel.getByRole("option", { name: "Food" })).toHaveAttribute("aria-selected", "true");
    await expect(panel.getByRole("option", { name: "Groceries" })).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Category: Food +1" })).toBeVisible();
    await expect(page.getByText("4 match your filters")).toBeVisible();
    await expect(page.getByRole("button", { name: /power/ })).toHaveCount(0);

    // An amount range, compared in each entry's own currency (¥3,000 is above 1,000).
    await page.getByRole("button", { name: "Amount", exact: true }).click();
    const amount = page.getByRole("dialog", { name: "Choose an amount range" });
    await expect(amount.getByLabel("At least")).toBeFocused();
    await amount.getByLabel("At least").fill("10");
    await amount.getByLabel("At most").fill("1000");
    await amount.getByRole("button", { name: "Apply" }).click();
    await expect(page).toHaveURL(/min=10&max=1000/);
    await expect(page.getByText("2 match your filters")).toBeVisible();
    await expect(page.getByRole("button", { name: /big food/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /market/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /ramen|small food/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Amount: 10 – 1000" })).toBeVisible();
    await expectNoHorizontalOverflow(page);

    // A negative bound is said, not silently dropped.
    await page.goto("/transactions?min=-5");
    await expect(page.getByRole("alert").filter({ hasText: "Amount filter" })).toHaveText("Amount filter not applied: The minimum cannot be negative.");
  });
});

test.describe("bulk edit", () => {
  test("select several rows, set a category and read the result line @phone", async ({ signedIn: page, user }) => {
    const bank = await seedWallet(user.id, { name: "Bank", currency: "EUR", initialBalanceMinor: 100_000 });
    const cash = await seedWallet(user.id, { name: "Cash", currency: "EUR" });
    await seedEntry(user.id, { walletId: bank.id, kind: "expense", category: "Food", amountMinor: 100, note: "alpha" });
    await seedEntry(user.id, { walletId: bank.id, kind: "expense", category: "Food", amountMinor: 200, note: "beta" });
    await seedEntry(user.id, { walletId: bank.id, kind: "expense", category: "Food", amountMinor: 300, note: "gamma" });
    await seedTransfer(user.id, { fromWalletId: bank.id, toWalletId: cash.id, amountMinor: 1_000, note: "top up" });
    await page.goto("/transactions");
    await hydrated(page);

    await page.getByRole("link", { name: "Select", exact: true }).click();
    await expect(page).toHaveURL(/[?&]select=1/);
    const bar = page.getByRole("region", { name: /^Bulk edit/ });
    await expect(bar).toBeVisible();
    const alpha = page.getByRole("checkbox", { name: /^Food alpha/ });

    // The month shortcuts keep working with a row's box focused.
    await alpha.focus();
    await page.keyboard.press("]");
    await expect(page).toHaveURL(/month=\d{4}-\d{2}.*select=1/);
    await page.keyboard.press("t");
    await expect(page).not.toHaveURL(/month=/);
    await expect(page).toHaveURL(/select=1/);

    await alpha.check();
    await page.getByRole("checkbox", { name: /^Food beta/ }).check();
    // A transfer leg stands for its transfer: Set category skips it.
    await page.getByRole("checkbox", { name: /^Transfer/ }).first().check();
    await expect(bar).toContainText("3 of 5 shown selected");
    await expectNoHorizontalOverflow(page);
    await bar.getByLabel("Action", { exact: true }).selectOption("Set category");
    await bar.getByLabel("Category", { exact: true }).selectOption({ label: "Groceries" });
    await bar.getByRole("button", { name: "Apply" }).click();

    const result = page.getByRole("status").filter({ hasText: /^Moved/ });
    await expect(result).toHaveText("Moved 2 entries to Groceries; 1 transfer skipped.");
    await expect(result).toBeFocused();
    // Selection mode has ended; the rows are editors again.
    await expect(page).not.toHaveURL(/select=/);
    await expect(page.getByRole("button", { name: /^Groceries alpha/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Groceries beta/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Food gamma/ })).toBeVisible();
  });

  test("'Select all N matching' then Delete, with the server's counts in the confirmation", async ({ signedIn: page, user }) => {
    const bank = await seedWallet(user.id, { name: "Bank", currency: "EUR", initialBalanceMinor: 100_000 });
    const month = currentMonth();
    for (let i = 1; i <= 52; i++) {
      await seedEntry(user.id, { walletId: bank.id, kind: "expense", category: "Food", amountMinor: 100 + i, note: `n${i}`, date: `${month}-01` });
    }
    await page.goto("/transactions?select=1");
    await hydrated(page);
    const bar = page.getByRole("region", { name: /^Bulk edit/ });
    await bar.getByRole("checkbox", { name: /Select all 52 matching entries/ }).check();
    await expect(bar).toContainText("All 52 matching entries selected");
    await bar.getByLabel("Action", { exact: true }).selectOption("Delete");
    await bar.getByRole("button", { name: "Delete…" }).click();

    const confirm = bar.getByRole("group", { name: "Confirm delete" });
    await expect(confirm).toContainText("Delete 52 entries?");
    await expect(confirm).toContainText("There is no undo");
    await expect(confirm.getByRole("link", { name: "Go to Data" })).toHaveAttribute("href", "/data");
    await expect(bar.getByRole("heading", { name: "Confirm delete" })).toBeFocused();
    await confirm.getByRole("button", { name: "Delete 52 entries" }).click();

    const result = page.getByRole("status").filter({ hasText: /^Deleted/ });
    await expect(result).toHaveText("Deleted 52 entries.");
    await expect(result).toBeFocused();
    await expect(page.getByRole("button", { name: /^Food n\d+/ })).toHaveCount(0);
  });

  test.describe("without JavaScript", () => {
    test.use({ javaScriptEnabled: false });

    test("tick shown rows and delete them after the confirmation", async ({ signedIn: page, user }) => {
      const bank = await seedWallet(user.id, { name: "Bank", currency: "EUR", initialBalanceMinor: 100_000 });
      await seedEntry(user.id, { walletId: bank.id, kind: "expense", category: "Food", amountMinor: 100, note: "one" });
      await seedEntry(user.id, { walletId: bank.id, kind: "expense", category: "Food", amountMinor: 200, note: "two" });
      await seedEntry(user.id, { walletId: bank.id, kind: "expense", category: "Food", amountMinor: 300, note: "three" });
      await page.goto("/transactions");
      await page.getByRole("link", { name: "Select", exact: true }).click();
      await page.getByRole("checkbox", { name: /^Food one/ }).check();
      await page.getByRole("checkbox", { name: /^Food two/ }).check();
      const bar = page.getByRole("region", { name: /^Bulk edit/ });
      await bar.getByLabel("Action", { exact: true }).selectOption("Delete");
      await bar.getByRole("button", { name: "Apply" }).click();
      const confirm = page.getByRole("group", { name: "Confirm delete" });
      await expect(confirm).toContainText("Delete 2 entries?");
      // The ticked rows come back ticked.
      await expect(page.getByRole("checkbox", { name: /^Food one/ })).toBeChecked();
      await expect(page.getByRole("checkbox", { name: /^Food three/ })).not.toBeChecked();
      await confirm.getByRole("button", { name: "Delete 2 entries" }).click();
      await expect(page.getByRole("status").filter({ hasText: /^Deleted/ })).toHaveText("Deleted 2 entries.");
      await expect(page.getByText("three")).toBeVisible();
      await expect(page.getByText("one", { exact: true })).toHaveCount(0);
    });
  });
});

test.describe("duplicate", () => {
  test("Duplicate in an open row opens Add prefilled, dated today @phone", async ({ signedIn: page, user }) => {
    const bank = await seedWallet(user.id, { name: "Bank", currency: "EUR", initialBalanceMinor: 100_000 });
    await seedEntry(user.id, {
      walletId: bank.id,
      kind: "expense",
      category: "Groceries",
      amountMinor: 1_234,
      note: "weekly shop",
      tags: ["home"],
      date: `${currentMonth()}-01`,
    });
    await page.goto("/transactions");
    await hydrated(page);
    await page.getByRole("button", { name: /^Groceries weekly shop/ }).click();
    await page.getByRole("link", { name: "Duplicate" }).click();

    const dialog = page.getByRole("dialog", { name: "Add transaction" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("textbox", { name: "Amount" })).toHaveValue("12.34");
    await expect(dialog.getByRole("radio", { name: "Groceries" })).toBeChecked();
    await expect(dialog.getByRole("radio", { name: /^Bank/ })).toBeChecked();
    await expect(dialog.getByRole("textbox", { name: "Note" })).toHaveValue("weekly shop");
    await expect(dialog.getByRole("textbox", { name: "Tags" })).toHaveValue("home");
    await expect(dialog.getByRole("button", { name: "Today" })).toHaveAttribute("aria-pressed", "true");
    await dialog.getByRole("button", { name: "Add expense" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("button", { name: /^Groceries weekly shop/ })).toHaveCount(2);
  });
});
