import type { Page } from "@playwright/test";
import { expect, hydrated, signInContext, test } from "./support/fixtures";
import { seedUser, seedWallet, todayISO } from "./support/seed";

/** Two EUR wallets and a USD one for `userId`. */
async function wallets(userId: number) {
  const bank = await seedWallet(userId, { name: "Bank", currency: "EUR", initialBalanceMinor: 100_000 });
  const cash = await seedWallet(userId, { name: "Cash", currency: "EUR", initialBalanceMinor: 5_000 });
  const usd = await seedWallet(userId, { name: "Dollars", currency: "USD", initialBalanceMinor: 20_000 });
  return { bank, cash, usd };
}

async function openAddDialogWithN(page: Page) {
  await hydrated(page);
  // N works outside text fields only.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("n");
  const dialog = page.getByRole("dialog", { name: "Add transaction" });
  await expect(dialog).toBeVisible();
  await expect(page).toHaveURL(/\/transactions\/new$/);
  return dialog;
}

test.describe("the Add dialog (N shortcut)", () => {
  test("adds an expense, an income and a transfer; the page behind shows them @phone", async ({ signedIn: page, user }) => {
    await wallets(user.id);
    await page.goto("/transactions");

    let dialog = await openAddDialogWithN(page);
    // From `sm` up the amount has focus on open; on a phone the sheet itself (no keyboard popping up).
    if ((page.viewportSize()?.width ?? 0) >= 640) {
      await expect(dialog.getByRole("textbox", { name: "Amount" })).toBeFocused();
    } else {
      await expect(dialog.getByRole("textbox", { name: "Amount" })).not.toBeFocused();
    }
    await dialog.getByRole("textbox", { name: "Amount" }).fill("12.50");
    await dialog.getByText("Groceries", { exact: true }).click();
    await dialog.getByRole("textbox", { name: "Note" }).fill("weekly shop");
    await dialog.getByRole("button", { name: "Add expense" }).click();
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(/\/transactions$/);
    await expect(page.getByRole("button", { name: /Groceries weekly shop · Bank -€12\.50/ })).toBeVisible();

    dialog = await openAddDialogWithN(page);
    await dialog.getByText("Income", { exact: true }).click();
    await dialog.getByRole("textbox", { name: "Amount" }).fill("2000");
    await dialog.getByText("Salary", { exact: true }).click();
    await dialog.getByText("Cash", { exact: true }).click();
    await dialog.getByRole("button", { name: "Add income" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("button", { name: /Salary Cash \+€2,000\.00/ })).toBeVisible();

    dialog = await openAddDialogWithN(page);
    await dialog.getByText("Transfer", { exact: true }).click();
    await dialog.getByLabel("From").selectOption({ label: "Bank (EUR)" });
    await dialog.getByLabel("To").selectOption({ label: "Dollars (USD)" });
    await dialog.getByRole("textbox", { name: "Sent" }).fill("100");
    // Different currencies: the received amount is asked for.
    await dialog.getByRole("textbox", { name: "Received" }).fill("108.20");
    await dialog.getByRole("button", { name: "Add transfer" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("button", { name: /Transfer → Dollars Bank -€100\.00/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Transfer ← Bank Dollars \+\$108\.20/ })).toBeVisible();
  });

  test("a refused save keeps the dialog open with the error on the field", async ({ signedIn: page, user }) => {
    await wallets(user.id);
    await page.goto("/");
    const dialog = await openAddDialogWithN(page);
    await dialog.getByRole("textbox", { name: "Amount" }).fill("12.345");
    await dialog.getByText("Food", { exact: true }).click();
    await dialog.getByRole("button", { name: "Add expense" }).click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("textbox", { name: "Amount" })).toHaveAttribute("aria-invalid", "true");
    await expect(dialog.getByRole("textbox", { name: "Amount" })).toBeFocused();
  });

  test("Keep open for another clears amount and note and stays open", async ({ signedIn: page, user }) => {
    await wallets(user.id);
    await page.goto("/");
    const dialog = await openAddDialogWithN(page);
    await dialog.getByText("Keep open for another").click();
    await dialog.getByRole("textbox", { name: "Amount" }).fill("3");
    await dialog.getByText("Food", { exact: true }).click();
    await dialog.getByRole("textbox", { name: "Note" }).fill("coffee");
    await dialog.getByRole("button", { name: "Add expense" }).click();
    await expect(dialog.getByRole("status")).toHaveText(/added/i);
    await expect(dialog.getByRole("textbox", { name: "Amount" })).toHaveValue("");
    await expect(dialog.getByRole("textbox", { name: "Note" })).toHaveValue("");
    await expect(dialog.getByRole("textbox", { name: "Amount" })).toBeFocused();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
  });

  test("amount and note survive a Transfer ↔ Expense switch", async ({ signedIn: page, user }) => {
    await wallets(user.id);
    await page.goto("/");
    const dialog = await openAddDialogWithN(page);
    await dialog.getByRole("textbox", { name: "Amount" }).fill("42.10");
    await dialog.getByRole("textbox", { name: "Note" }).fill("kept across kinds");
    await dialog.getByText("Transfer", { exact: true }).click();
    await expect(dialog.getByRole("textbox", { name: "Sent" })).toHaveValue("42.10");
    await expect(dialog.getByRole("textbox", { name: "Note" })).toHaveValue("kept across kinds");
    await dialog.getByRole("textbox", { name: "Sent" }).fill("43");
    await dialog.getByText("Expense", { exact: true }).click();
    await expect(dialog.getByRole("textbox", { name: "Amount" })).toHaveValue("43");
    await expect(dialog.getByRole("textbox", { name: "Note" })).toHaveValue("kept across kinds");
  });

  test("+ New category creates the category, selects it and keeps what was typed", async ({ signedIn: page, user }) => {
    await wallets(user.id);
    await page.goto("/");
    const dialog = await openAddDialogWithN(page);
    await dialog.getByRole("textbox", { name: "Amount" }).fill("9.99");
    await dialog.getByRole("textbox", { name: "Note" }).fill("new pill");
    await dialog.getByRole("button", { name: "+ New category" }).click();
    const name = dialog.getByLabel("New expense category name");
    await expect(name).toBeFocused();
    await name.fill("Books");
    await name.press("Enter");
    const pill = dialog.getByRole("radio", { name: "Books" });
    await expect(pill).toBeChecked();
    await expect(pill).toBeFocused();
    // The layout refresh behind the open dialog kept the typed values.
    await expect(dialog.getByRole("textbox", { name: "Amount" })).toHaveValue("9.99");
    await expect(dialog.getByRole("textbox", { name: "Note" })).toHaveValue("new pill");
    // A duplicate name is refused in place.
    await dialog.getByRole("button", { name: "+ New category" }).click();
    await dialog.getByLabel("New expense category name").fill("books");
    await dialog.getByRole("button", { name: "Add", exact: true }).click();
    await expect(dialog.getByLabel("New expense category name")).toHaveAttribute("aria-invalid", "true");
    await dialog.getByLabel("New expense category name").press("Escape");
    // Escape closed the field, not the dialog.
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "+ New category" })).toBeFocused();

    await dialog.getByRole("button", { name: "Add expense" }).click();
    await expect(dialog).toBeHidden();
    await page.goto("/transactions");
    await expect(page.getByRole("button", { name: /Books new pill · Bank -€9\.99/ })).toBeVisible();
  });

  test("Manage categories keeps a draft that the next Add form restores (dialog)", async ({ signedIn: page, user }) => {
    await wallets(user.id);
    await page.goto("/");
    const dialog = await openAddDialogWithN(page);
    await dialog.getByText("Income", { exact: true }).click();
    await dialog.getByRole("textbox", { name: "Amount" }).fill("77");
    await dialog.getByText("Cash", { exact: true }).click();
    await dialog.getByRole("textbox", { name: "Note" }).fill("draft note");
    await dialog.getByRole("link", { name: "Manage categories" }).click();
    await expect(page).toHaveURL(/\/categories$/);
    await expect(page.getByRole("heading", { name: "Categories", level: 1 })).toBeVisible();
    await expect(page.getByRole("dialog")).toBeHidden();

    await page.getByRole("textbox", { name: "New income category" }).fill("Gifts");
    await page.getByRole("textbox", { name: "New income category" }).press("Enter");
    await expect(page.getByRole("button", { name: /^Gifts · / })).toBeVisible();

    const again = await openAddDialogWithN(page);
    await expect(again.getByRole("radio", { name: "Income", exact: true })).toBeChecked();
    await expect(again.getByRole("textbox", { name: "Amount" })).toHaveValue("77");
    await expect(again.getByRole("textbox", { name: "Note" })).toHaveValue("draft note");
    await expect(again.getByRole("radio", { name: "Cash" })).toBeChecked();
    await again.getByText("Gifts", { exact: true }).click();
    await again.getByRole("button", { name: "Add income" }).click();
    await expect(again).toBeHidden();

    // Used once: the next form starts empty.
    const third = await openAddDialogWithN(page);
    await expect(third.getByRole("textbox", { name: "Amount" })).toHaveValue("");
  });

  test("the full page form adds an entry and the draft round trip works there too", async ({ signedIn: page, user }) => {
    await wallets(user.id);
    await page.goto("/transactions/new");
    await expect(page.getByRole("heading", { name: "Add transaction", level: 1 })).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await hydrated(page);
    await page.getByRole("textbox", { name: "Amount" }).fill("5.25");
    await page.getByRole("textbox", { name: "Note" }).fill("page draft");
    await page.getByRole("link", { name: "Manage categories" }).click();
    await expect(page).toHaveURL(/\/categories$/);
    await page.goto("/transactions/new");
    await expect(page.getByRole("textbox", { name: "Amount" })).toHaveValue("5.25");
    await expect(page.getByRole("textbox", { name: "Note" })).toHaveValue("page draft");
    await page.getByText("Transport", { exact: true }).click();
    await page.getByRole("button", { name: "Add expense" }).click();
    await expect(page).toHaveURL(/\/transactions$/);
    await expect(page.getByRole("button", { name: /Transport page draft · Bank -€5\.25/ })).toBeVisible();
  });
});

test.describe("date picker", () => {
  // WebKit does not focus a clicked button, so focus stayed on a day cell that the month change removed; it then moved
  // to the Add dialog's panel and the picker closed itself.
  test("inside the Add dialog, changing month or opening the month view keeps the picker open", async ({ signedIn: page, user }) => {
    await wallets(user.id);
    await page.goto("/transactions");
    const dialog = await openAddDialogWithN(page);
    const picker = page.getByRole("dialog", { name: "Choose a date" });
    await dialog.getByRole("combobox", { name: "Choose another date" }).click();
    await picker.getByRole("button", { name: /^Previous month, / }).click();
    await picker.getByRole("button", { name: /^Previous month, / }).click();
    await expect(picker).toBeVisible();
    await picker.getByRole("button", { name: /, choose a month$/ }).click();
    await expect(picker.getByRole("group", { name: /^Months of / })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(picker.getByRole("grid")).toBeVisible();
  });

  test("Other date: the month view's Back to days returns focus to a day, Escape steps back first", async ({ signedIn: page, user }) => {
    await wallets(user.id);
    await page.goto("/transactions/new");
    await hydrated(page);
    await page.getByRole("combobox", { name: "Choose another date" }).click();
    const picker = page.getByRole("dialog", { name: "Choose a date" });
    await expect(picker).toBeVisible();
    await expect(picker.getByRole("gridcell").and(page.locator(":focus"))).toHaveCount(1);

    await picker.getByRole("button", { name: /, choose a month$/ }).click();
    await expect(picker.getByRole("group", { name: /^Months of / })).toBeVisible();
    await picker.getByRole("button", { name: /^Back to days/ }).click();
    await expect(picker.getByRole("grid")).toBeVisible();
    await expect(picker.getByRole("gridcell").and(page.locator(":focus"))).toHaveCount(1);

    // Escape in the month view goes back to the days; a second Escape closes the picker.
    await picker.getByRole("button", { name: /, choose a month$/ }).click();
    await page.keyboard.press("Escape");
    await expect(picker.getByRole("grid")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(picker).toBeHidden();
    await expect(page.getByRole("combobox", { name: "Choose another date" })).toBeFocused();

    // Pick the 1st of the previous month through the month grid.
    await page.getByRole("combobox", { name: "Choose another date" }).click();
    await picker.getByRole("button", { name: /^Previous month, / }).click();
    await picker.getByRole("gridcell").filter({ hasText: /^1$/ }).first().click();
    await expect(picker).toBeHidden();
    await expect(page.getByRole("combobox", { name: /^Date: 1 / })).toBeVisible();
  });

  test("the picker opens above its trigger near the bottom of the viewport, below it with room", async ({ signedIn: page, user }) => {
    await wallets(user.id);
    await page.setViewportSize({ width: 1280, height: 600 });
    await page.goto("/transactions/new");
    await hydrated(page);
    const trigger = page.getByRole("combobox", { name: "Choose another date" });
    const picker = page.getByRole("dialog", { name: "Choose a date" });

    // Trigger near the top: opens below.
    await trigger.evaluate((el) => el.scrollIntoView({ block: "start" }));
    await trigger.click();
    await expect(picker).toHaveAttribute("data-placement", "below");
    await page.keyboard.press("Escape");

    // Trigger at the very bottom: opens above, and the whole panel is on screen.
    await page.evaluate(() => {
      document.body.style.paddingBottom = "2000px";
    });
    await trigger.evaluate((el) => {
      const r = el.getBoundingClientRect();
      window.scrollBy(0, r.bottom - window.innerHeight + 8);
    });
    await trigger.click();
    await expect(picker).toHaveAttribute("data-placement", "above");
    const box = (await picker.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(600);

    // Scrolling the trigger up to the top re-places the open panel below.
    await trigger.evaluate((el) => el.scrollIntoView({ block: "start" }));
    await expect(picker).toHaveAttribute("data-placement", "below");
  });

  test("inside the Add sheet at 375px the opened picker stays within the viewport @phone-only", async ({ signedIn: page, user }) => {
    await wallets(user.id);
    await page.goto("/");
    const dialog = await openAddDialogWithN(page);
    const trigger = dialog.getByRole("combobox", { name: "Choose another date" });
    await trigger.scrollIntoViewIfNeeded();
    await trigger.click();
    const picker = page.getByRole("dialog", { name: "Choose a date" });
    await expect(picker).toBeVisible();
    const vp = page.viewportSize()!;
    const box = (await picker.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(vp.height);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(vp.width);
  });
});

test.describe("today in the account's time zone", () => {
  // UTC+14 and UTC−11 are 25 hours apart, so at any moment their dates differ: each account must get its own.
  for (const timeZone of ["Pacific/Kiritimati", "Pacific/Pago_Pago"]) {
    test(`the Add form defaults to today in ${timeZone}`, async ({ page, context, baseURL }) => {
      const user = await seedUser({ timeZone });
      await seedWallet(user.id, { name: "Bank", currency: "EUR" });
      await signInContext(context, user.token, baseURL!);
      const before = todayISO(timeZone);
      await page.goto("/transactions/new");
      const posted = await page.locator('form input[type="hidden"][name="date"]').inputValue();
      // Either side of a midnight that passed while the page loaded.
      expect([before, todayISO(timeZone)]).toContain(posted);
      await expect(page.getByRole("button", { name: "Today", exact: true })).toHaveAttribute("aria-pressed", "true");
    });
  }
});
