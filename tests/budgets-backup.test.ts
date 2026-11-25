// Budgets and category colours in the JSON backup: written by `buildBackup`, restored additively by the importer
// (a budget the account lacks is created, an existing one is kept with a notice; a colour only on categories the
// import creates). The version stays 1, and older files without the fields import as before.
import { beforeEach, describe, expect, it } from "vitest";
import type { DB } from "@/db";
import { listBudgets, setBudget } from "@/server/budgets";
import { archiveCategory, createCategory, listCategories, renameCategory } from "@/server/categories";
import { buildBackup } from "@/server/export";
import { previewImport, runImport, type ImportPreview } from "@/server/import";
import { createTransaction } from "@/server/transactions";
import { createWallet } from "@/server/wallets";
import { makeUser, useFreshDb } from "./helpers";

let db: DB;
let alice: Awaited<ReturnType<typeof makeUser>>;

beforeEach(async () => {
  db = await useFreshDb();
  alice = await makeUser(db, "alice@example.com");
});

const json = (o: unknown) => JSON.stringify(o);

function expectProblems(p: ImportPreview, expected: { path: string; message: RegExp }[]) {
  expect(p.ok).toBe(false);
  for (const e of expected) {
    expect(p.problems).toContainEqual(expect.objectContaining({ path: e.path, message: expect.stringMatching(e.message) }));
  }
}

async function seedAlice() {
  const eur = await createWallet(alice.id, { name: "Main", currency: "EUR", initialBalanceMinor: 0 });
  await createWallet(alice.id, { name: "Tokyo", currency: "JPY", initialBalanceMinor: 0 });
  await createTransaction(alice.id, { walletId: eur.id, kind: "expense", categoryId: alice.cat("Food"), amountMinor: 1250, date: "2026-03-02" });
  const coffee = await createCategory(alice.id, { name: "Coffee", kind: "expense" });
  await renameCategory(alice.id, alice.cat("Food"), { name: "Food", color: "amber" });
  await renameCategory(alice.id, coffee.id, { name: "Coffee", color: "violet" });
  await archiveCategory(alice.id, coffee.id);
  await setBudget(alice.id, { categoryId: alice.cat("Food"), currency: "EUR", amountMinor: 30000 });
  await setBudget(alice.id, { categoryId: coffee.id, currency: "JPY", amountMinor: 5000 });
  await setBudget(alice.id, { categoryId: null, currency: "EUR", amountMinor: 200000 });
  return { coffee };
}

describe("budgets and colours in the backup", () => {
  it("writes the budgets (overall first, category by name, minor units + decimal) and each category's colour", async () => {
    await seedAlice();
    const backup = await buildBackup(alice.id);
    expect(backup.version).toBe(1);
    expect(backup.budgets).toEqual([
      { currency: "EUR", amountMinor: 200000, amount: "2000.00" },
      { category: "Food", currency: "EUR", amountMinor: 30000, amount: "300.00" },
      { category: "Coffee", currency: "JPY", amountMinor: 5000, amount: "5000" },
    ]);
    expect(backup.categories.find((c) => c.name === "Food")).toMatchObject({ color: "amber" });
    expect(backup.categories.find((c) => c.name === "Coffee")).toMatchObject({ color: "violet", archived: true });
    expect(backup.categories.find((c) => c.name === "Bills")).not.toHaveProperty("color");
  });

  it("round trip into a fresh account: every budget and colour comes back", async () => {
    await seedAlice();
    const backup = await buildBackup(alice.id);
    const bob = await makeUser(db, "bob@example.com");
    const p = await previewImport(bob.id, json(backup));
    expect(p).toMatchObject({ ok: true, budgetsToAdd: 3, notices: [] });
    const r = await runImport(bob.id, json(backup));
    expect(r).toMatchObject({ imported: true, budgetsToAdd: 3 });

    const cats = await listCategories(bob.id, undefined, { includeArchived: true });
    const byName = (n: string) => cats.find((c) => c.name === n)!;
    // Food existed already (a default category): it keeps its own colour (none); Coffee was created with its colour.
    expect(byName("Food").color).toBeNull();
    expect(byName("Coffee")).toMatchObject({ color: "violet", archivedAt: expect.any(Date) });
    expect((await listBudgets(bob.id)).map((b) => [b.categoryId, b.currency, b.amountMinor])).toEqual([
      [null, "EUR", 200000],
      [byName("Food").id, "EUR", 30000],
      [byName("Coffee").id, "JPY", 5000],
    ]);
    // Importing it again adds nothing and says nothing.
    expect(await previewImport(bob.id, json(backup))).toMatchObject({ ok: true, budgetsToAdd: 0, notices: [] });
  });

  it("into an account that already has budgets: adds the missing ones, keeps its own with a notice", async () => {
    await seedAlice();
    const backup = await buildBackup(alice.id);
    const bob = await makeUser(db, "bob@example.com");
    await createWallet(bob.id, { name: "Cash", currency: "EUR", initialBalanceMinor: 0 });
    await setBudget(bob.id, { categoryId: null, currency: "EUR", amountMinor: 99900 }); // differs
    await setBudget(bob.id, { categoryId: bob.cat("Food"), currency: "EUR", amountMinor: 30000 }); // the same
    const p = await previewImport(bob.id, json(backup));
    expect(p).toMatchObject({ ok: true, budgetsToAdd: 1 });
    expect(p.notices).toEqual([expect.objectContaining({ code: "budgets-kept", count: 1, message: expect.stringContaining("your own is kept") })]);
    await runImport(bob.id, json(backup));
    const budgets = await listBudgets(bob.id);
    expect(budgets).toHaveLength(3);
    expect(budgets[0]).toMatchObject({ categoryId: null, amountMinor: 99900 });
  });

  it("an older backup without budgets or colours imports as before", async () => {
    const empty = { app: "expenses-tracker", version: 1, wallets: [], categories: [{ id: 1, name: "Pets", kind: "expense" }], transactions: [], transfers: [] };
    expect(await previewImport(alice.id, json(empty))).toMatchObject({ ok: true, budgetsToAdd: 0 });
    await runImport(alice.id, json(empty));
    expect((await listCategories(alice.id)).find((c) => c.name === "Pets")?.color).toBeNull();
    expect(await listBudgets(alice.id)).toEqual([]);
  });

  it("an unknown colour reads as none; bad budgets are problems", async () => {
    const base = {
      app: "expenses-tracker",
      version: 1,
      wallets: [],
      categories: [
        { id: 1, name: "Pets", kind: "expense", color: "pink" },
        { id: 2, name: "Bonus", kind: "income" },
      ],
      transactions: [],
      transfers: [],
    };
    await runImport(alice.id, json(base));
    expect((await listCategories(alice.id)).find((c) => c.name === "Pets")?.color).toBeNull();

    const bad = await previewImport(
      alice.id,
      json({
        ...base,
        budgets: [
          { category: "Bonus", currency: "EUR", amountMinor: 100 },
          { category: "Nowhere", currency: "EUR", amountMinor: 100 },
          { category: "Pets", currency: "EURO", amountMinor: 100 },
          { category: "pets", currency: "EUR", amountMinor: 100, amount: "2.00" },
          { currency: "EUR", amountMinor: 100 },
          { category: null, currency: "EUR", amountMinor: 200 },
        ],
      }),
    );
    expectProblems(bad, [
      { path: "budgets[0].category", message: /income category/ },
      { path: "budgets[1].category", message: /No expense category “Nowhere”/ },
      { path: "budgets[2].currency", message: /ISO 4217/ },
      { path: "budgets[3].amount", message: /does not match/ },
      { path: "budgets[5]", message: /second overall budget/ },
    ]);
    // The shape is checked first (as for every list of the file).
    expectProblems(await previewImport(alice.id, json({ ...base, budgets: [{ currency: "EUR", amountMinor: 0 }] })), [
      { path: "budgets[0].amountMinor", message: /greater than zero/ },
    ]);
    // A budget for the same category spelled twice (ignoring case) is one too many.
    const twice = await previewImport(
      alice.id,
      json({ ...base, budgets: [{ category: "Pets", currency: "EUR", amountMinor: 100 }, { category: "PETS", currency: "EUR", amountMinor: 100 }] }),
    );
    expectProblems(twice, [{ path: "budgets[1]", message: /second budget for “Pets”/ }]);
  });
});
