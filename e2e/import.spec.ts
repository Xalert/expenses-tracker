import { strToU8, zipSync } from "fflate";
import { archiveCategory, createCategory } from "@/server/categories";
import { buildTransactionsCsv } from "@/server/export";
import { expect, hydrated, test } from "./support/fixtures";
import { categoryByName, seedEntry, seedUser, seedWallet } from "./support/seed";

const fileInput = (page: import("@playwright/test").Page) => page.locator("#import-file");

/** A Spendee per-wallet export: `;`-separated, every cell quoted, CRLF, signed amounts, UTC times. */
function spendeeCsv(wallet: string, currency: string, rows: { date: string; category: string; amount: string; note?: string }[]) {
  const quote = (cells: string[]) => cells.map((c) => `"${c.replace(/"/g, '""')}"`).join(";");
  const header = ["Date", "Wallet", "Type", "Category name", "Amount", "Currency", "Notes", "First name", "Last name"];
  const lines = rows.map((r) =>
    quote([r.date, wallet, r.amount.startsWith("-") ? "expense" : "income", r.category, r.amount, currency, r.note ?? "", "Jane", "Doe"]),
  );
  return [quote(header), ...lines].join("\r\n") + "\r\n";
}

test("a transactions CSV with wallet and category rows: preview first, then the confirmed import @phone", async ({ signedIn: page }) => {
  // The CSV comes from another account's export: a wallet row with its initial balance, an archived category row.
  const source = await seedUser();
  const bank = await seedWallet(source.id, { name: "Savings", currency: "CHF", initialBalanceMinor: 123_400 });
  await seedEntry(source.id, { walletId: bank.id, kind: "expense", category: "Housing", amountMinor: 50_000, date: "2026-01-05", note: "rent jan" });
  // A category the importing account does not have (an existing one of the same name would be used as it is).
  await createCategory(source.id, { name: "Old deposits", kind: "income" });
  await seedEntry(source.id, { walletId: bank.id, kind: "income", category: "Old deposits", amountMinor: 2_500, date: "2026-01-06", note: "deposit back" });
  await archiveCategory(source.id, (await categoryByName(source.id, "Old deposits")).id);
  const csv = await buildTransactionsCsv(source.id);

  await page.goto("/data");
  await hydrated(page);
  await fileInput(page).setInputFiles({ name: "transactions.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await page.getByRole("button", { name: "Preview import" }).click();
  const preview = page.getByRole("heading", { name: /^Ready to import/ });
  await expect(preview).toBeVisible();
  await expect(page.getByText(/New wallets:\s*Savings · CHF/)).toBeVisible();
  // A preview writes nothing.
  await page.goto("/wallets");
  await expect(page.getByRole("link", { name: /^Savings/ })).toHaveCount(0);

  await page.goto("/data");
  await hydrated(page);
  await fileInput(page).setInputFiles({ name: "transactions.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await page.getByRole("button", { name: "Preview import" }).click();
  await page.getByRole("button", { name: "Import 2 entries" }).click();
  await expect(page.getByRole("heading", { name: "Import complete" })).toBeVisible();

  await page.goto("/wallets");
  // Initial balance 1,234.00 - 500.00 + 25.00.
  await expect(page.getByRole("link", { name: /^Savings .*Balance CHF\s?759\.00/ })).toBeVisible();
  await page.goto("/categories");
  await expect(page.getByRole("list", { name: "Archived · 1 category" }).getByRole("button", { name: /^Old deposits/ })).toBeVisible();

  // The same file again: everything is a duplicate.
  await page.goto("/data");
  await hydrated(page);
  await fileInput(page).setInputFiles({ name: "transactions.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await page.getByRole("button", { name: "Preview import" }).click();
  await expect(page.getByText(/Nothing to import: everything in this file is already in your account/)).toBeVisible();
});

test("a Spendee .zip of per-wallet CSVs imports as one", async ({ signedIn: page }) => {
  const zip = zipSync({
    "Cash.csv": strToU8(
      spendeeCsv("Cash", "EUR", [
        { date: "2026-02-03 10:00:00", category: "Food & Drinks", amount: "-12.5", note: "lunch" },
        { date: "2026-02-04 10:00:00", category: "Salary", amount: "1500" },
      ]),
    ),
    "Card.csv": strToU8(spendeeCsv("Card", "USD", [{ date: "2026-02-05 10:00:00", category: "Travel", amount: "-80", note: "train" }])),
  });
  await page.goto("/data");
  await hydrated(page);
  await fileInput(page).setInputFiles({ name: "spendee.zip", mimeType: "application/zip", buffer: Buffer.from(zip) });
  await page.getByRole("button", { name: "Preview import" }).click();
  await expect(page.getByRole("heading", { name: /^Ready to import · Spendee/ })).toBeVisible();
  await expect(page.getByText(/A Spendee export carries no starting balances/)).toBeVisible();
  await page.getByRole("button", { name: "Import 3 entries" }).click();
  await expect(page.getByRole("heading", { name: "Import complete" })).toBeVisible();
  await page.goto("/transactions?month=2026-02");
  await expect(page.getByRole("button", { name: /^Food & Drinks lunch · Cash/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Travel train · Card/ })).toBeVisible();
});

test.describe("oversized uploads", () => {
  test("a file over 5 MB is refused before it is sent", async ({ signedIn: page }) => {
    await page.goto("/data");
    await hydrated(page);
    let posted = false;
    page.on("request", (r) => {
      if (r.method() === "POST") posted = true;
    });
    await fileInput(page).setInputFiles({ name: "big.csv", mimeType: "text/csv", buffer: Buffer.alloc(5 * 1024 * 1024 + 10, "a") });
    await page.getByRole("button", { name: "Preview import" }).click();
    await expect(page.getByText("The file is larger than 5 MB. Split it into smaller files and import them one by one.")).toBeVisible();
    expect(posted).toBe(false);
  });

  test.describe(() => {
    test.use({ allowConsoleErrors: [/status of 413/] });
    test("an upload over the server's limit gets the app's message, not a generic error", async ({ signedIn: page }) => {
      // Skip the browser-side check (as an old cached page would) so the server's own refusal (src/proxy.ts) is seen.
      await page.addInitScript(() => {
        Object.defineProperty(File.prototype, "size", { get: () => 1 });
      });
      await page.goto("/data");
      await hydrated(page);
      await fileInput(page).setInputFiles({ name: "big.csv", mimeType: "text/csv", buffer: Buffer.alloc(6 * 1024 * 1024 + 10, "a") });
      await page.getByRole("button", { name: "Preview import" }).click();
      await expect(
        page.getByText("The upload is too large: the selected files can be at most 5 MB in total. Import them in smaller groups, or split a large file."),
      ).toBeVisible();
    });
  });
});
