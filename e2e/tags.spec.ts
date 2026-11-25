import type { Page } from "@playwright/test";
import { expect, expectNoHorizontalOverflow, hydrated, test } from "./support/fixtures";
import { seedEntry, seedWallet } from "./support/seed";

async function openAddDialog(page: Page) {
  await hydrated(page);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("n");
  const dialog = page.getByRole("dialog", { name: "Add transaction" });
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe("tags", () => {
  test("add an entry with a new tag, see the pill, filter by it, rename it and delete it on /categories @phone", async ({
    signedIn: page,
    user,
  }) => {
    const bank = await seedWallet(user.id, { name: "Bank", currency: "EUR", initialBalanceMinor: 100_000 });
    await seedEntry(user.id, { walletId: bank.id, kind: "expense", category: "Bills", amountMinor: 4_000, note: "Phone bill", tags: ["work"] });
    await page.goto("/transactions");

    // The Add dialog: a new tag typed, an existing one picked from the suggestions.
    const dialog = await openAddDialog(page);
    await dialog.getByRole("textbox", { name: "Amount" }).fill("18.40");
    await dialog.getByText("Food", { exact: true }).click();
    await dialog.getByRole("textbox", { name: "Note" }).fill("Beach lunch");
    const tags = dialog.getByRole("textbox", { name: "Tags" });
    // One row until used: no suggestions before the field is focused.
    await expect(dialog.getByRole("group", { name: "Your tags" })).toHaveCount(0);
    await tags.fill("holiday 2026");
    await expect(dialog.getByText("New tag “holiday 2026”: created when you save.")).toBeVisible();
    const work = dialog.getByRole("group", { name: "Your tags" }).getByRole("button", { name: "work" });
    // "holiday 2026" matches no tag, so the suggestions narrow to nothing until the comma.
    await expect(work).toHaveCount(0);
    await tags.fill("holiday 2026, ");
    await expect(work).toHaveAttribute("aria-pressed", "false");
    await work.click();
    await expect(tags).toHaveValue("holiday 2026, work");
    await expect(work).toHaveAttribute("aria-pressed", "true");
    await dialog.getByRole("button", { name: "Add expense" }).click();
    await expect(dialog).toBeHidden();

    // The row shows its tags after the note (the whole list is in the row's accessible name).
    const row = page.getByRole("button", { name: /Food Beach lunch · Bank Tags: holiday 2026, work -€18\.40/ });
    await expect(row).toBeVisible();
    await expect(row.getByText("holiday 2026", { exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(page);

    // Filter by the new tag: only its entry is listed, and the chip shows it.
    await page.getByRole("button", { name: "Tag", exact: true }).click();
    await page.getByRole("option", { name: "holiday 2026" }).click();
    await expect(page).toHaveURL(/[?&]tag=\d+/);
    await expect(page.getByRole("button", { name: "Tag: holiday 2026" })).toBeVisible();
    await expect(row).toBeVisible();
    await expect(page.getByRole("button", { name: /Phone bill/ })).toHaveCount(0);
    await expect(page.getByText("1 matches your filters")).toBeVisible();

    // Rename it on /categories.
    await page.goto("/categories");
    const card = page.getByRole("region", { name: /^Tags ·/ });
    await card.getByRole("button", { name: /^holiday 2026 1 entry$/ }).click();
    const name = page.getByLabel("New name for “holiday 2026”");
    await expect(name).toBeFocused();
    await name.fill("Summer holiday");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(card.getByRole("status").first()).toHaveText("Renamed to “Summer holiday”.");
    const renamed = card.getByRole("button", { name: /^Summer holiday 1 entry$/ });
    await expect(renamed).toBeFocused();
    await expectNoHorizontalOverflow(page);

    // Its entries are one link away.
    await renamed.click();
    await expect(page.getByRole("link", { name: /Show its 1 entry/ })).toHaveAttribute("href", /\/transactions\?month=all&tag=\d+/);

    // Delete it: the entry stays, without the tag.
    page.once("dialog", (d) => d.accept());
    await page.getByRole("button", { name: "Delete Summer holiday" }).click();
    await expect(card.getByRole("status").first()).toHaveText("Deleted “Summer holiday” and took it off 1 entry.");
    await expect(page.getByRole("heading", { name: /^Tags · 1 tag$/ })).toBeFocused();
    await page.goto("/transactions");
    await expect(page.getByRole("button", { name: /Food Beach lunch · Bank Tags: work -€18\.40/ })).toBeVisible();
  });

  test("the in-place editor changes an entry's tags", async ({ signedIn: page, user }) => {
    const bank = await seedWallet(user.id, { name: "Bank", currency: "EUR", initialBalanceMinor: 0 });
    await seedEntry(user.id, { walletId: bank.id, kind: "expense", category: "Food", amountMinor: 500, note: "Snack", tags: ["a", "b"] });
    await page.goto("/transactions");
    await hydrated(page);
    await page.getByRole("button", { name: /Food Snack · Bank Tags: a, b/ }).click();
    const tags = page.getByRole("region", { name: /Edit Food/ }).getByRole("textbox", { name: "Tags" });
    await expect(tags).toHaveValue("a, b");
    await tags.fill("b, c");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("button", { name: /Food Snack · Bank Tags: b, c/ })).toBeVisible();
  });

  test("Keep open for another keeps the tags for the next entry; amount and note are cleared", async ({ signedIn: page, user }) => {
    await seedWallet(user.id, { name: "Bank", currency: "EUR", initialBalanceMinor: 0 });
    await page.goto("/transactions");
    const dialog = await openAddDialog(page);
    await dialog.getByText("Keep open for another").click();
    await dialog.getByRole("textbox", { name: "Amount" }).fill("3");
    await dialog.getByText("Food", { exact: true }).click();
    await dialog.getByRole("textbox", { name: "Note" }).fill("coffee");
    await dialog.getByRole("textbox", { name: "Tags" }).fill("trip");
    await dialog.getByRole("button", { name: "Add expense" }).click();
    await expect(dialog.getByRole("status")).toHaveText(/added/i);
    await expect(dialog.getByRole("textbox", { name: "Amount" })).toHaveValue("");
    await expect(dialog.getByRole("textbox", { name: "Note" })).toHaveValue("");
    await expect(dialog.getByRole("textbox", { name: "Tags" })).toHaveValue("trip");
    await expect(dialog.getByRole("textbox", { name: "Amount" })).toBeFocused();
  });

});

test.describe("tags without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("the Tags field is a plain comma-separated input, and the filter form has a Tag select @phone", async ({
    signedIn: page,
    user,
  }) => {
    await seedWallet(user.id, { name: "Bank", currency: "EUR", initialBalanceMinor: 0 });
    await page.goto("/transactions/new");
    await page.getByRole("textbox", { name: "Amount" }).fill("7");
    await page.getByText("Food", { exact: true }).click();
    await page.getByRole("textbox", { name: "Tags" }).fill("no script, Trip");
    await page.getByRole("button", { name: "Add expense" }).click();
    await expect(page).toHaveURL(/\/transactions$/);
    await expect(page.getByRole("button", { name: /Food Bank Tags: no script, Trip -€7\.00/ })).toBeVisible();
    // The no-JS filter form has a Tag select.
    const filters = page.getByRole("form", { name: "Filters" });
    await filters.getByLabel("Tag").selectOption({ label: "Trip" });
    await filters.getByRole("button", { name: "Apply" }).click();
    await expect(page).toHaveURL(/[?&]tag=\d+/);
    await expect(page.getByText("1 matches your filters")).toBeVisible();
  });
});
