// Category kind changes, archiving (services, pickers, entries, imports, backups) and removal into a new category.
import { beforeEach, describe, expect, it } from "vitest";
import { categoryOptions } from "@/app/(app)/transactions/form-options";
import { parseReplacement } from "@/app/(app)/categories/form-input";
import type { DB } from "@/db";
import { categories, transactions } from "@/db/schema";
import { ServiceError } from "@/lib/errors";
import {
  archiveCategory,
  changeCategoryKind,
  createCategory,
  deleteCategory,
  getCategory,
  listCategories,
  listCategoriesWithUsage,
  unarchiveCategory,
} from "@/server/categories";
import { getDashboard } from "@/server/dashboard";
import { buildBackup, buildTransactionsCsv } from "@/server/export";
import { previewImport, runImport } from "@/server/import";
import { pickTopCategory } from "@/server/insights";
import { createTransaction, getTransaction, listTransactions, updateTransaction } from "@/server/transactions";
import { createWallet } from "@/server/wallets";
import { EVERY_ENTRY, makeUser, useFreshDb } from "./helpers";

let db: DB;
let alice: Awaited<ReturnType<typeof makeUser>>;
let bob: Awaited<ReturnType<typeof makeUser>>;
let walletId: number;

beforeEach(async () => {
  db = await useFreshDb();
  alice = await makeUser(db, "alice@example.com");
  bob = await makeUser(db, "bob@example.com");
  walletId = (await createWallet(alice.id, { name: "Cash", currency: "EUR", initialBalanceMinor: 0 })).id;
});

async function expectServiceError(fn: () => unknown, code: ServiceError["code"], field?: string): Promise<ServiceError> {
  try {
    await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe(code);
    if (field !== undefined) expect((err as ServiceError).field).toBe(field);
    return err as ServiceError;
  }
  throw new Error("expected a ServiceError");
}

const spend = (categoryId: number, amountMinor = 100, date = "2026-03-10", note?: string) =>
  createTransaction(alice.id, { walletId, kind: "expense", categoryId, amountMinor, date, note });

async function snapshot() {
  return {
    categories: await db.select().from(categories).orderBy(categories.id),
    transactions: await db.select().from(transactions).orderBy(transactions.id),
  };
}

describe("changeCategoryKind", () => {
  it("switches an unused category to the other kind; the same kind is a no-op", async () => {
    const c = await changeCategoryKind(alice.id, alice.cat("Housing"), { kind: "income" });
    expect(c).toMatchObject({ id: alice.cat("Housing"), name: "Housing", kind: "income" });
    expect((await listCategories(alice.id, "income")).map((x) => x.name)).toContain("Housing");
    expect((await listCategories(alice.id, "expense")).map((x) => x.name)).not.toContain("Housing");
    expect(await changeCategoryKind(alice.id, c.id, { kind: "income" })).toEqual(c);
    // and it can now take income entries
    await createTransaction(alice.id, { walletId, kind: "income", categoryId: c.id, amountMinor: 5, date: "2026-03-01" });
  });

  it("refuses while the category has transactions, saying why, and changes nothing", async () => {
    await spend(alice.cat("Food"));
    await spend(alice.cat("Food"));
    const before = await snapshot();
    const err = await expectServiceError(
      () => changeCategoryKind(alice.id, alice.cat("Food"), { kind: "income" }),
      "CONFLICT",
      "kind",
    );
    expect(err.message).toBe(
      "“Food” is used by 2 transactions, so it stays an expense category: changing it would turn those entries into " +
        "income. Add a new income category instead.",
    );
    expect(await snapshot()).toEqual(before);
  });

  it("refuses a name already used in the other kind (ignoring case), an invalid kind, and other users' categories", async () => {
    await createCategory(alice.id, { name: "food", kind: "income" });
    const err = await expectServiceError(() => changeCategoryKind(alice.id, alice.cat("Food"), { kind: "income" }), "CONFLICT", "kind");
    expect(err.message).toContain("You already have an income category called “food”");
    await expectServiceError(
      () => changeCategoryKind(alice.id, alice.cat("Food"), { kind: "transfer" as never }),
      "VALIDATION",
      "kind",
    );
    await expectServiceError(() => changeCategoryKind(bob.id, alice.cat("Bills"), { kind: "income" }), "NOT_FOUND");
    expect((await getCategory(alice.id, alice.cat("Bills")))?.kind).toBe("expense");
  });
});

describe("archiving categories", () => {
  it("hides an archived category from listCategories unless asked, and keeps it in the usage list, last of its kind", async () => {
    await spend(alice.cat("Bills"), 700);
    const archived = await archiveCategory(alice.id, alice.cat("Bills"));
    expect(archived.archivedAt).toBeInstanceOf(Date);

    expect((await listCategories(alice.id, "expense")).map((c) => c.name)).toEqual(["Food", "Groceries", "Housing", "Transport"]);
    expect((await listCategories(alice.id, "expense", { includeArchived: true })).map((c) => c.name)).toEqual([
      "Food", "Groceries", "Housing", "Transport", "Bills",
    ]);
    const usage = await listCategoriesWithUsage(alice.id, { month: "2026-03", currency: "EUR" });
    expect(usage.filter((c) => c.kind === "expense").map((c) => c.name)).toEqual([
      "Food", "Groceries", "Housing", "Transport", "Bills",
    ]);
    expect(usage.find((c) => c.name === "Bills")).toMatchObject({ transactionCount: 1, monthAmountMinor: 700 });
    expect((await getCategory(alice.id, alice.cat("Bills")))?.archivedAt).toEqual(archived.archivedAt);
  });

  it("keeps its entries in history and reports", async () => {
    const t = await spend(alice.cat("Bills"), 700, "2026-03-04");
    await archiveCategory(alice.id, alice.cat("Bills"));
    expect((await listTransactions(alice.id, { categoryId: alice.cat("Bills") })).items.map((x) => x.id)).toEqual([t.id]);
    expect((await getDashboard(alice.id, { month: "2026-03", balanceOn: EVERY_ENTRY })).expenseByCategory).toEqual([
      { currency: "EUR", categoryId: alice.cat("Bills"), categoryName: "Bills", amountMinor: 700 },
    ]);
    expect(await buildTransactionsCsv(alice.id)).toContain(",Bills,");
  });

  it("refuses new entries under it, but an entry that already has it keeps it when edited", async () => {
    const t = await spend(alice.cat("Bills"), 700);
    const other = await spend(alice.cat("Food"), 300);
    await archiveCategory(alice.id, alice.cat("Bills"));

    const err = await expectServiceError(() => spend(alice.cat("Bills")), "VALIDATION", "categoryId");
    expect(err.message).toBe("“Bills” is archived. Choose another category.");
    // moving another entry into it is new activity too
    await expectServiceError(
      () => updateTransaction(alice.id, other.id, { walletId, kind: "expense", categoryId: alice.cat("Bills"), amountMinor: 300, date: "2026-03-10" }),
      "VALIDATION",
      "categoryId",
    );
    const edited = await updateTransaction(alice.id, t.id, {
      walletId,
      kind: "expense",
      categoryId: alice.cat("Bills"),
      amountMinor: 750,
      date: "2026-03-11",
    });
    expect(edited).toMatchObject({ categoryId: alice.cat("Bills"), amountMinor: 750 });

    await unarchiveCategory(alice.id, alice.cat("Bills"));
    await spend(alice.cat("Bills"), 10);
    expect((await listCategories(alice.id, "expense")).map((c) => c.name)).toContain("Bills");
  });

  it("is idempotent (the first date is kept), scoped per user, and archived categories can still be renamed and removed", async () => {
    const first = await archiveCategory(alice.id, alice.cat("Housing"));
    expect((await archiveCategory(alice.id, alice.cat("Housing"))).archivedAt).toEqual(first.archivedAt);
    expect((await unarchiveCategory(alice.id, alice.cat("Food"))).archivedAt).toBeNull();
    await expectServiceError(() => archiveCategory(bob.id, alice.cat("Food")), "NOT_FOUND");
    await expectServiceError(() => unarchiveCategory(bob.id, alice.cat("Housing")), "NOT_FOUND");
    expect((await getCategory(alice.id, alice.cat("Food")))?.archivedAt).toBeNull();
    expect((await getCategory(alice.id, alice.cat("Housing")))?.archivedAt).not.toBeNull();
    await deleteCategory(alice.id, alice.cat("Housing"));
    expect(await getCategory(alice.id, alice.cat("Housing"))).toBeNull();
  });

  it("the entry form's options leave archived categories out, except the one an entry uses (labelled)", async () => {
    await archiveCategory(alice.id, alice.cat("Bills"));
    const plain = await categoryOptions(alice.id);
    expect(plain.map((c) => c.name)).not.toContain("Bills");
    expect(plain.every((c) => !c.archived)).toBe(true);
    const keeping = await categoryOptions(alice.id, [alice.cat("Bills"), null]);
    expect(keeping.filter((c) => c.kind === "expense").map((c) => c.name)).toEqual([
      "Food", "Groceries", "Housing", "Transport", "Bills (archived)",
    ]);
    expect(keeping.find((c) => c.id === alice.cat("Bills"))).toEqual({
      id: alice.cat("Bills"),
      name: "Bills (archived)",
      kind: "expense",
      archived: true,
    });
    // keeping an active one adds nothing
    expect(await categoryOptions(alice.id, [alice.cat("Food")])).toEqual(plain);
  });

  it("an archived category is not offered as a replacement; the last active one asks for a new name", async () => {
    await spend(alice.cat("Food"));
    for (const name of ["Groceries", "Housing", "Transport"]) await deleteCategory(alice.id, alice.cat(name));
    await archiveCategory(alice.id, alice.cat("Bills"));
    const before = await snapshot();
    const err = await expectServiceError(
      () => deleteCategory(alice.id, alice.cat("Food"), { moveToCategoryId: alice.cat("Bills") }),
      "VALIDATION",
      "moveToCategoryId",
    );
    expect(err.message).toBe("“Bills” is archived. Choose an active category, or unarchive it first.");
    const conflict = await expectServiceError(() => deleteCategory(alice.id, alice.cat("Food")), "CONFLICT", "moveToNewCategoryName");
    expect(conflict.message).toContain("is your only expense category");
    expect(await snapshot()).toEqual(before);
  });
});

describe("deleteCategory into a new category", () => {
  it("creates the category, moves the entries and deletes the old one", async () => {
    const t1 = await spend(alice.cat("Food"), 100);
    const t2 = await spend(alice.cat("Food"), 200);
    const r = await deleteCategory(alice.id, alice.cat("Food"), { moveToNewCategoryName: "  Eating   out " });
    expect(r).toMatchObject({ movedTransactions: 2, movedTo: { name: "Eating out", kind: "expense", archivedAt: null } });
    expect(await getCategory(alice.id, alice.cat("Food"))).toBeNull();
    for (const t of [t1, t2]) {
      expect(await getTransaction(alice.id, t.id)).toMatchObject({ categoryId: r.movedTo!.id, categoryName: "Eating out" });
    }
  });

  it("is the way out for the only category of its kind", async () => {
    await createTransaction(alice.id, { walletId, kind: "income", categoryId: alice.cat("Salary"), amountMinor: 9, date: "2026-03-01" });
    await deleteCategory(alice.id, alice.cat("Refund"));
    await deleteCategory(alice.id, alice.cat("Extra Income"));
    const r = await deleteCategory(alice.id, alice.cat("Salary"), { moveToNewCategoryName: "Wages" });
    expect(r.movedTransactions).toBe(1);
    expect((await listCategories(alice.id, "income")).map((c) => c.name)).toEqual(["Wages"]);
  });

  it("changes nothing when the new name is invalid or taken (including the removed category's own name)", async () => {
    await spend(alice.cat("Food"));
    const before = await snapshot();
    await expectServiceError(() => deleteCategory(alice.id, alice.cat("Food"), { moveToNewCategoryName: "  " }), "VALIDATION", "moveToNewCategoryName");
    await expectServiceError(
      () => deleteCategory(alice.id, alice.cat("Food"), { moveToNewCategoryName: "x".repeat(41) }),
      "VALIDATION",
      "moveToNewCategoryName",
    );
    for (const taken of ["groceries", "FOOD"]) {
      await expectServiceError(
        () => deleteCategory(alice.id, alice.cat("Food"), { moveToNewCategoryName: taken }),
        "CONFLICT",
        "moveToNewCategoryName",
      );
    }
    // an income category's name is free for an expense category
    expect(await snapshot()).toEqual(before);
    const r = await deleteCategory(alice.id, alice.cat("Food"), { moveToNewCategoryName: "Salary" });
    expect(r.movedTo).toMatchObject({ name: "Salary", kind: "expense" });
  });

  it("the new name wins over an existing replacement; an unused category ignores both and creates nothing", async () => {
    await spend(alice.cat("Food"));
    const r = await deleteCategory(alice.id, alice.cat("Food"), {
      moveToCategoryId: alice.cat("Bills"),
      moveToNewCategoryName: "Meals",
    });
    expect(r.movedTo?.name).toBe("Meals");
    const count = (await listCategories(alice.id)).length;
    expect(await deleteCategory(alice.id, alice.cat("Housing"), { moveToNewCategoryName: "Rent" })).toEqual({
      movedTransactions: 0,
      movedRecurring: 0,
      movedTo: null,
    });
    expect((await listCategories(alice.id)).map((c) => c.name)).not.toContain("Rent");
    expect(await listCategories(alice.id)).toHaveLength(count - 1);
  });

  it("parses the form: select 'new' or no select → the name; an id → that category", () => {
    const fd = (entries: Record<string, string>) => {
      const f = new FormData();
      for (const [k, v] of Object.entries(entries)) f.append(k, v);
      return f;
    };
    expect(parseReplacement(fd({ moveToCategoryId: "new", moveToNewCategoryName: "Meals" }))).toEqual({ moveToNewCategoryName: "Meals" });
    expect(parseReplacement(fd({ moveToNewCategoryName: "" }))).toEqual({ moveToNewCategoryName: "" });
    expect(parseReplacement(fd({ moveToCategoryId: "7", moveToNewCategoryName: "ignored" }))).toEqual({ moveToCategoryId: 7 });
    expect(parseReplacement(fd({ moveToCategoryId: "new" }))).toEqual({});
    expect(parseReplacement(fd({ moveToCategoryId: "" }))).toEqual({});
    expect(parseReplacement(fd({ moveToCategoryId: "x" }))).toEqual({ moveToCategoryId: 0 });
    expect(parseReplacement(fd({}))).toEqual({});
  });
});

describe("archived categories in backups and imports", () => {
  it("the backup carries the archived flag and restores it, with the history, in a fresh account", async () => {
    await spend(alice.cat("Bills"), 700, "2026-03-04", "power");
    await archiveCategory(alice.id, alice.cat("Bills"));
    const backup = await buildBackup(alice.id);
    expect(backup.categories.find((c) => c.name === "Bills")).toMatchObject({ kind: "expense", archived: true });
    expect(backup.categories.find((c) => c.name === "Food")).toMatchObject({ archived: false });

    const carol = await makeUser(db, "carol@example.com");
    // Carol's own Bills would match (and stay active), so remove it: the backup's archived Bills is then created.
    await deleteCategory(carol.id, carol.cat("Bills"));
    const file = JSON.stringify(backup);
    const preview = await previewImport(carol.id, file);
    expect(preview).toMatchObject({ ok: true, transactionsToAdd: 1 });
    expect(preview.categoriesToCreate).toEqual([{ name: "Bills", kind: "expense", archived: true }]);
    await runImport(carol.id, file);
    const bills = (await listCategories(carol.id, "expense", { includeArchived: true })).find((c) => c.name === "Bills")!;
    expect(bills.archivedAt).not.toBeNull();
    expect((await listTransactions(carol.id, { categoryId: bills.id })).total).toBe(1);

    // Re-importing the same backup adds nothing and reports no problem (the entry is a duplicate).
    const again = await runImport(carol.id, file);
    expect(again).toMatchObject({ ok: true, imported: true, transactionsToAdd: 0, duplicateTransactions: 1 });
  });

  it("an existing active category is left active; an existing archived one takes no new entries", async () => {
    await spend(alice.cat("Bills"), 700, "2026-03-04");
    await archiveCategory(alice.id, alice.cat("Bills"));
    const file = JSON.stringify(await buildBackup(alice.id));

    // Bob's Bills is active: the import files the entry there and leaves it active.
    const r = await runImport(bob.id, file);
    expect(r).toMatchObject({ ok: true, imported: true, transactionsToAdd: 1, categoriesToCreate: [] });
    expect((await getCategory(bob.id, bob.cat("Bills")))?.archivedAt).toBeNull();

    // Alice archived hers: a new entry for it is a problem with its location.
    const csv = "date,type,wallet,currency,amount,category,note\r\n2026-03-20,expense,Cash,EUR,5.00,bills,\r\n";
    const p = await previewImport(alice.id, csv);
    expect(p.ok).toBe(false);
    expect(p.problems).toEqual([
      {
        line: 2,
        message:
          "Category “bills” (expense) is archived in your account, so nothing new can be added to it. " +
          "Unarchive it first, or remove these rows.",
      },
    ]);
  });

  it("an old backup without the archived field imports its categories as active", async () => {
    const backup = await buildBackup(alice.id);
    const old = { ...backup, categories: backup.categories.map((c) => ({ id: c.id, name: c.name, kind: c.kind })) };
    const carol = await makeUser(db, "carol@example.com");
    await deleteCategory(carol.id, carol.cat("Bills"));
    await runImport(carol.id, JSON.stringify(old));
    expect((await listCategories(carol.id, "expense")).map((c) => c.name)).toContain("Bills");
  });
});

describe("top category tie-break", () => {
  const row = (categoryId: number, categoryName: string, amountMinor: number) => ({ categoryId, categoryName, amountMinor });

  it("largest amount, then the lower-cased name by code units, then the id", () => {
    expect(pickTopCategory([row(1, "b", 5), row(2, "a", 9)])?.categoryId).toBe(2);
    expect(pickTopCategory([row(1, "b", 5), row(2, "A", 5)])?.categoryId).toBe(2);
    expect(pickTopCategory([row(3, "Food", 5), row(2, "food", 5)])?.categoryId).toBe(2);
    // Not locale order: "É" (U+00C9 → é U+00E9) sorts after "z".
    expect(pickTopCategory([row(1, "Éclairs", 5), row(2, "Zoo", 5)])?.categoryId).toBe(2);
    expect(pickTopCategory([])).toBeUndefined();
  });
});
