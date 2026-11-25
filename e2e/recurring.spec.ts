import { expect, hydrated, test } from "./support/fixtures";
import { seedWallet } from "./support/seed";

const rentRow = { name: /^Housing \(repeats\) rent · Bank -€950\.00$/ };

test.describe("repeating entries", () => {
  test("a monthly expense from two months ago: caught up, marked, then paused and deleted on /recurring @phone", async ({
    signedIn: page,
    user,
  }) => {
    await seedWallet(user.id, { name: "Bank", currency: "EUR", initialBalanceMinor: 100_000 });
    await page.goto("/transactions");
    await hydrated(page);

    await page.getByRole("link", { name: "Add transaction" }).click();
    const dialog = page.getByRole("dialog", { name: "Add transaction" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("textbox", { name: "Amount" }).fill("950");
    await dialog.getByText("Housing", { exact: true }).click();
    // The 1st of the month two months ago.
    await dialog.getByRole("combobox", { name: "Choose another date" }).click();
    const picker = page.getByRole("dialog", { name: "Choose a date" });
    await picker.getByRole("button", { name: /^Previous month, / }).click();
    await picker.getByRole("button", { name: /^Previous month, / }).click();
    await picker.getByRole("gridcell").filter({ hasText: /^1$/ }).first().click();
    await expect(picker).toBeHidden();

    // Repeat takes one row until something other than Never is chosen.
    await expect(dialog.getByRole("textbox", { name: "Every" })).toHaveCount(0);
    await dialog.getByLabel("Repeat").selectOption("monthly");
    await expect(dialog.getByRole("textbox", { name: "Every" })).toHaveValue("1");
    await expect(dialog.getByText("saving also adds 2 more entries for the dates up to today")).toBeVisible();
    await dialog.getByRole("textbox", { name: "Note" }).fill("rent");
    await dialog.getByRole("button", { name: "Add expense" }).click();
    await expect(dialog).toBeHidden();

    // This month's entry (the 1st) is in the list, with the marker; all three are there over all time.
    await expect(page.getByRole("button", rentRow)).toHaveCount(1);
    await page.goto("/transactions?month=all");
    await expect(page.getByRole("button", rentRow)).toHaveCount(3);

    // The open row links to the rule.
    await hydrated(page);
    await page.getByRole("button", rentRow).first().click();
    await page.getByRole("link", { name: "Repeating entry" }).click();
    await expect(page).toHaveURL(/\/recurring#rule-\d+$/);
    await expect(page.getByRole("heading", { name: "Repeating entries" })).toBeVisible();
    const rule = page.getByRole("listitem").filter({ hasText: "Every month on the 1st · Bank · rent" });
    await expect(rule).toContainText("Active");
    await expect(rule).toContainText("3 entries so far");

    await rule.getByRole("button", { name: /^Pause / }).click();
    await expect(rule).toContainText("Paused");
    await expect(rule.getByRole("button", { name: /^Resume / })).toBeVisible();

    page.once("dialog", (d) => d.accept());
    await rule.getByRole("button", { name: /^Delete / }).click();
    await expect(page.getByText("No repeating entries yet")).toBeVisible();

    // Its entries stay, now without the marker.
    await page.goto("/transactions?month=all");
    await expect(page.getByRole("button", rentRow)).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Housing rent · Bank -€950\.00$/ })).toHaveCount(3);
  });

  test("the Transactions header links to /recurring, whose New opens Add with Repeat preselected", async ({ signedIn: page, user }) => {
    await seedWallet(user.id, { name: "Bank", currency: "EUR", initialBalanceMinor: 0 });
    await page.goto("/transactions");
    await hydrated(page);
    await page.getByRole("link", { name: "Repeating" }).click();
    await expect(page).toHaveURL(/\/recurring$/);
    await hydrated(page);
    await page.getByRole("link", { name: "New repeating entry" }).click();
    const dialog = page.getByRole("dialog", { name: "Add transaction" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("Repeat")).toHaveValue("monthly");
  });
});
