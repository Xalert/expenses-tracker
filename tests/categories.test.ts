import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { nameField, parseCategoryId, parseCategoryKind, parseMoveTo } from "@/app/(app)/categories/form-input";
import type { DB } from "@/db";
import { categories, transactions } from "@/db/schema";
import { ServiceError } from "@/lib/errors";
import {
  createCategory,
  deleteCategory,
  getCategory,
  listCategories,
  listCategoriesWithUsage,
  renameCategory,
} from "@/server/categories";
import { getDashboard } from "@/server/dashboard";
import { createTransaction, getTransaction, listTransactions } from "@/server/transactions";
import { createTransfer, getTransfer } from "@/server/transfers";
import { archiveWallet, createWallet } from "@/server/wallets";
import { isUniqueViolation } from "@/server/_validate";
import { makeUser, useFreshDb } from "./helpers";

let db: DB;
let alice: Awaited<ReturnType<typeof makeUser>>;
let bob: Awaited<ReturnType<typeof makeUser>>;

beforeEach(async () => {
  db = await useFreshDb();
  alice = await makeUser(db, "alice@example.com");
  bob = await makeUser(db, "bob@example.com");
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

const expense = (walletId: number, categoryId: number, amountMinor: number, date = "2026-03-10") =>
  ({ walletId, kind: "expense" as const, categoryId, amountMinor, date });
const income = (walletId: number, categoryId: number, amountMinor: number, date = "2026-03-10") =>
  ({ walletId, kind: "income" as const, categoryId, amountMinor, date });

/** Snapshot of every row in both tables, to prove a failed call changed nothing. */
async function snapshot() {
  return {
    categories: await db.select().from(categories).orderBy(categories.id),
    transactions: await db.select().from(transactions).orderBy(transactions.id),
  };
}

const usage = async (userId: number) =>
  Object.fromEntries((await listCategoriesWithUsage(userId)).map((c) => [`${c.kind}:${c.name}`, c.transactionCount]));

describe("listCategoriesWithUsage", () => {
  it("counts transactions per category in listCategories order, ignoring transfer legs", async () => {
    const w = await createWallet(alice.id, { name: "Cash", currency: "EUR", initialBalanceMinor: 0 });
    const w2 = await createWallet(alice.id, { name: "Bank", currency: "EUR", initialBalanceMinor: 0 });
    await createTransaction(alice.id, expense(w.id, alice.cat("Food"), 100));
    await createTransaction(alice.id, expense(w.id, alice.cat("Food"), 200));
    await createTransaction(alice.id, income(w.id, alice.cat("Salary"), 300));
    await createTransfer(alice.id, { fromWalletId: w.id, toWalletId: w2.id, amountMinor: 50, date: "2026-03-11" });
    await createCategory(alice.id, { name: "coffee", kind: "expense" });

    const list = await listCategoriesWithUsage(alice.id);
    expect(list.map(({ id, name, kind }) => ({ id, name, kind }))).toEqual(await listCategories(alice.id));
    // case-insensitive name order: "coffee" sits between Bills and Food
    expect(list.filter((c) => c.kind === "expense").map((c) => c.name)).toEqual([
      "Bills", "coffee", "Food", "Groceries", "Housing", "Transport",
    ]);
    expect(await usage(alice.id)).toMatchObject({ "expense:Food": 2, "income:Salary": 1, "expense:Bills": 0, "expense:coffee": 0 });
    expect(Object.values(await usage(bob.id)).every((n) => n === 0)).toBe(true);
  });
});

describe("listCategoriesWithUsage with a month and currency", () => {
  const byName = (rows: Awaited<ReturnType<typeof listCategoriesWithUsage>>) =>
    Object.fromEntries(rows.map((c) => [`${c.kind}:${c.name}`, [c.transactionCount, c.monthCount, c.monthAmountMinor]]));

  it("adds the month's count over all currencies and its amount in the chosen currency only", async () => {
    const eur = await createWallet(alice.id, { name: "Cash", currency: "EUR", initialBalanceMinor: 0 });
    const old = await createWallet(alice.id, { name: "Old", currency: "EUR", initialBalanceMinor: 0 });
    const usd = await createWallet(alice.id, { name: "Dollars", currency: "USD", initialBalanceMinor: 0 });
    await createTransaction(alice.id, expense(eur.id, alice.cat("Food"), 100, "2026-03-01"));
    await createTransaction(alice.id, expense(old.id, alice.cat("Food"), 40, "2026-03-31"));
    await createTransaction(alice.id, expense(usd.id, alice.cat("Food"), 7000, "2026-03-15"));
    await createTransaction(alice.id, expense(eur.id, alice.cat("Food"), 9, "2026-02-28"));
    await createTransaction(alice.id, expense(eur.id, alice.cat("Food"), 8, "2026-04-01"));
    await createTransaction(alice.id, income(usd.id, alice.cat("Salary"), 5000, "2026-03-10"));
    await createTransfer(alice.id, { fromWalletId: eur.id, toWalletId: old.id, amountMinor: 50, date: "2026-03-05" });
    await archiveWallet(alice.id, old.id);
    await createTransaction(bob.id, expense((await createWallet(bob.id, { name: "B", currency: "EUR", initialBalanceMinor: 0 })).id, bob.cat("Food"), 1, "2026-03-02"));

    expect(byName(await listCategoriesWithUsage(alice.id, { month: "2026-03", currency: "EUR" }))).toMatchObject({
      "expense:Food": [5, 3, 140],
      "income:Salary": [1, 1, 0],
      "expense:Bills": [0, 0, 0],
    });
    expect(byName(await listCategoriesWithUsage(alice.id, { month: "2026-03", currency: "USD" }))).toMatchObject({
      "expense:Food": [5, 3, 7000],
      "income:Salary": [1, 1, 5000],
    });
    // A month without a currency counts but has no amounts; no options at all keeps the old figures with zeros.
    expect(byName(await listCategoriesWithUsage(alice.id, { month: "2026-03" }))).toMatchObject({ "expense:Food": [5, 3, 0] });
    expect(byName(await listCategoriesWithUsage(alice.id, { currency: "EUR" }))).toMatchObject({ "expense:Food": [5, 0, 0] });
    expect(byName(await listCategoriesWithUsage(alice.id))).toMatchObject({ "expense:Food": [5, 0, 0] });
    expect((await listCategoriesWithUsage(alice.id, { month: "2026-03" })).map((c) => c.id)).toEqual(
      (await listCategories(alice.id)).map((c) => c.id),
    );
  });

  it("rejects an invalid month or currency", async () => {
    await expectServiceError(() => listCategoriesWithUsage(alice.id, { month: "2026-13" }), "VALIDATION", "month");
    await expectServiceError(() => listCategoriesWithUsage(alice.id, { month: "2026-03", currency: "eur" }), "VALIDATION", "currency");
  });
});

describe("createCategory", () => {
  it("creates a category, trimming and collapsing whitespace", async () => {
    const c = await createCategory(alice.id, { name: "  Eating   out\t ", kind: "expense" });
    expect(c).toEqual({ id: expect.any(Number), name: "Eating out", kind: "expense" });
    expect(await getCategory(alice.id, c.id)).toEqual(c);
    expect(await listCategories(alice.id, "expense")).toContainEqual(c);
  });

  it("validates the name and kind", async () => {
    await expectServiceError(() => createCategory(alice.id, { name: "", kind: "expense" }), "VALIDATION", "name");
    await expectServiceError(() => createCategory(alice.id, { name: "   \n ", kind: "expense" }), "VALIDATION", "name");
    await expectServiceError(() => createCategory(alice.id, { name: "x".repeat(41), kind: "expense" }), "VALIDATION", "name");
    expect((await createCategory(alice.id, { name: "y".repeat(40), kind: "expense" })).name).toHaveLength(40);
    // whitespace collapsing happens before the length check
    expect((await createCategory(alice.id, { name: `${"z".repeat(20)}     ${"z".repeat(19)}`, kind: "expense" })).name).toHaveLength(40);
    await expectServiceError(
      () => createCategory(alice.id, { name: "Gifts", kind: "transfer" as unknown as "expense" }),
      "VALIDATION",
      "kind",
    );
  });

  it("rejects a duplicate differing only in case or spacing, but allows it under the other kind", async () => {
    const before = await snapshot();
    const err = await expectServiceError(() => createCategory(alice.id, { name: "food", kind: "expense" }), "CONFLICT", "name");
    expect(err.message).toContain("Food");
    await expectServiceError(() => createCategory(alice.id, { name: " FOOD ", kind: "expense" }), "CONFLICT", "name");
    await expectServiceError(() => createCategory(alice.id, { name: "extra   income", kind: "income" }), "CONFLICT", "name");
    expect(await snapshot()).toEqual(before);

    expect(await createCategory(alice.id, { name: "Food", kind: "income" })).toMatchObject({ name: "Food", kind: "income" });
    expect(await createCategory(alice.id, { name: "Salary", kind: "expense" })).toMatchObject({ kind: "expense" });
    // another user's names don't matter
    expect((await createCategory(bob.id, { name: "Coffee", kind: "expense" })).name).toBe("Coffee");
    expect((await createCategory(alice.id, { name: "coffee", kind: "expense" })).name).toBe("coffee");
  });
});

describe("unique index", () => {
  it("recognises the DB's own UNIQUE violation (mapped to CONFLICT by the service)", async () => {
    let caught: unknown;
    try {
      await db.insert(categories).values({ userId: alice.id, kind: "expense", name: "Food" });
    } catch (err) {
      caught = err;
    }
    expect(isUniqueViolation(caught)).toBe(true);
    expect(isUniqueViolation(new Error("other"))).toBe(false);
  });
});

describe("renameCategory", () => {
  it("renames, normalising the name, and the new name shows up on transactions and the dashboard", async () => {
    const w = await createWallet(alice.id, { name: "Cash", currency: "EUR", initialBalanceMinor: 0 });
    const t = await createTransaction(alice.id, expense(w.id, alice.cat("Food"), 1500, "2026-03-02"));
    const r = await renameCategory(alice.id, alice.cat("Food"), { name: "  Eating  out " });
    expect(r).toEqual({ id: alice.cat("Food"), name: "Eating out", kind: "expense" });
    expect((await getTransaction(alice.id, t.id))?.categoryName).toBe("Eating out");
    expect((await getDashboard(alice.id, { month: "2026-03" })).expenseByCategory).toEqual([
      { currency: "EUR", categoryId: alice.cat("Food"), categoryName: "Eating out", amountMinor: 1500 },
    ]);
  });

  it("allows changing only the letter case of its own name, and a no-op rename", async () => {
    expect((await renameCategory(alice.id, alice.cat("Food"), { name: "FOOD" })).name).toBe("FOOD");
    expect((await renameCategory(alice.id, alice.cat("Food"), { name: " FOOD " })).name).toBe("FOOD");
    expect((await getCategory(alice.id, alice.cat("Food")))?.name).toBe("FOOD");
  });

  it("rejects empty, too long and duplicate names without changing anything", async () => {
    const before = await snapshot();
    await expectServiceError(() => renameCategory(alice.id, alice.cat("Food"), { name: "  " }), "VALIDATION", "name");
    await expectServiceError(() => renameCategory(alice.id, alice.cat("Food"), { name: "a".repeat(41) }), "VALIDATION", "name");
    await expectServiceError(() => renameCategory(alice.id, alice.cat("Food"), { name: "bills" }), "CONFLICT", "name");
    expect(await snapshot()).toEqual(before);
    // the same name under the other kind is fine
    expect((await renameCategory(alice.id, alice.cat("Food"), { name: "Salary" })).name).toBe("Salary");
  });

  it("is NOT_FOUND for missing ids", async () => {
    await expectServiceError(() => renameCategory(alice.id, 999_999, { name: "X" }), "NOT_FOUND");
    await expectServiceError(() => renameCategory(alice.id, 0, { name: "X" }), "NOT_FOUND");
  });
});

describe("deleteCategory", () => {
  let w: Awaited<ReturnType<typeof createWallet>>;
  let w2: Awaited<ReturnType<typeof createWallet>>;
  beforeEach(async () => {
    w = await createWallet(alice.id, { name: "Cash", currency: "EUR", initialBalanceMinor: 0 });
    w2 = await createWallet(alice.id, { name: "Bank", currency: "EUR", initialBalanceMinor: 0 });
  });

  it("deletes an unused category (replacement ignored)", async () => {
    expect(await deleteCategory(alice.id, alice.cat("Housing"))).toEqual({ movedTransactions: 0 });
    expect(await getCategory(alice.id, alice.cat("Housing"))).toBeNull();
    expect(await deleteCategory(alice.id, alice.cat("Bills"), { moveToCategoryId: alice.cat("Salary") })).toEqual({
      movedTransactions: 0,
    });
    expect((await listCategories(alice.id, "expense")).map((c) => c.name)).toEqual(["Food", "Groceries", "Transport"]);
  });

  it("refuses an in-use category without a replacement, naming the count, and changes nothing", async () => {
    await createTransaction(alice.id, expense(w.id, alice.cat("Food"), 100));
    await createTransaction(alice.id, expense(w.id, alice.cat("Food"), 200));
    await createTransaction(alice.id, expense(w.id, alice.cat("Food"), 300));
    const before = await snapshot();
    const err = await expectServiceError(() => deleteCategory(alice.id, alice.cat("Food")), "CONFLICT", "moveToCategoryId");
    expect(err.message).toContain("3 transactions");
    await expectServiceError(() => deleteCategory(alice.id, alice.cat("Food"), { moveToCategoryId: null }), "CONFLICT");
    expect(await snapshot()).toEqual(before);
  });

  it("moves transactions to the replacement and deletes the category atomically", async () => {
    const food = alice.cat("Food");
    const groceries = alice.cat("Groceries");
    const t1 = await createTransaction(alice.id, expense(w.id, food, 1000, "2026-03-02"));
    const t2 = await createTransaction(alice.id, expense(w2.id, food, 500, "2026-03-03"));
    const t3 = await createTransaction(alice.id, expense(w.id, groceries, 250, "2026-03-04"));
    const other = await createTransaction(alice.id, expense(w.id, alice.cat("Bills"), 70, "2026-03-05"));
    const tr = await createTransfer(alice.id, { fromWalletId: w.id, toWalletId: w2.id, amountMinor: 40, date: "2026-03-06", note: "move" });

    expect((await getDashboard(alice.id, { month: "2026-03" })).expenseByCategory).toEqual([
      { currency: "EUR", categoryId: food, categoryName: "Food", amountMinor: 1500 },
      { currency: "EUR", categoryId: groceries, categoryName: "Groceries", amountMinor: 250 },
      { currency: "EUR", categoryId: alice.cat("Bills"), categoryName: "Bills", amountMinor: 70 },
    ]);

    expect(await deleteCategory(alice.id, food, { moveToCategoryId: groceries })).toEqual({ movedTransactions: 2 });

    expect(await getCategory(alice.id, food)).toBeNull();
    for (const t of [t1, t2, t3]) {
      expect(await getTransaction(alice.id, t.id)).toMatchObject({ categoryId: groceries, categoryName: "Groceries" });
    }
    expect((await getTransaction(alice.id, other.id))?.categoryId).toBe(alice.cat("Bills"));
    expect(await usage(alice.id)).toMatchObject({ "expense:Groceries": 3, "expense:Bills": 1 });
    expect((await usage(alice.id))["expense:Food"]).toBeUndefined();
    expect((await listTransactions(alice.id, { categoryId: groceries })).total).toBe(3);
    expect((await getDashboard(alice.id, { month: "2026-03" })).expenseByCategory).toEqual([
      { currency: "EUR", categoryId: groceries, categoryName: "Groceries", amountMinor: 1750 },
      { currency: "EUR", categoryId: alice.cat("Bills"), categoryName: "Bills", amountMinor: 70 },
    ]);
    // transfer legs are untouched
    expect(await getTransfer(alice.id, tr.id)).toMatchObject({ note: "move", from: { amountMinor: 40 }, to: { amountMinor: 40 } });
    const legs = await db.select().from(transactions).where(eq(transactions.transferId, tr.id)).orderBy(transactions.id);
    expect(legs.map((l) => [l.kind, l.categoryId])).toEqual([["transfer_out", null], ["transfer_in", null]]);
  });

  it("rejects a replacement of the other kind, itself, or a missing one, changing nothing", async () => {
    await createTransaction(alice.id, expense(w.id, alice.cat("Food"), 100));
    const before = await snapshot();
    for (const moveToCategoryId of [alice.cat("Salary"), alice.cat("Food"), 999_999, 0, -1, 1.5]) {
      await expectServiceError(
        () => deleteCategory(alice.id, alice.cat("Food"), { moveToCategoryId }),
        "VALIDATION",
        "moveToCategoryId",
      );
    }
    expect(await snapshot()).toEqual(before);
  });

  it("tells the user to create another category when it is the last of its kind and in use", async () => {
    await createTransaction(alice.id, income(w.id, alice.cat("Salary"), 100));
    await deleteCategory(alice.id, alice.cat("Refund"));
    await deleteCategory(alice.id, alice.cat("Extra Income"));
    const before = await snapshot();
    const err = await expectServiceError(() => deleteCategory(alice.id, alice.cat("Salary")), "CONFLICT", "moveToCategoryId");
    expect(err.message).toMatch(/1 transaction\b.*Create another income category first/);
    expect(await snapshot()).toEqual(before);
    // a user may end up with no income categories at all once nothing uses them
    const fresh = await makeUser(db, "carol@example.com");
    for (const name of ["Salary", "Refund", "Extra Income"]) await deleteCategory(fresh.id, fresh.cat(name));
    expect(await listCategories(fresh.id, "income")).toEqual([]);
  });

  it("is NOT_FOUND for a missing category", async () => {
    await expectServiceError(() => deleteCategory(alice.id, 999_999), "NOT_FOUND");
  });
});

describe("category isolation between users", () => {
  it("user B cannot rename, delete or move into user A's categories", async () => {
    const aw = await createWallet(alice.id, { name: "A", currency: "EUR", initialBalanceMinor: 0 });
    const bw = await createWallet(bob.id, { name: "B", currency: "EUR", initialBalanceMinor: 0 });
    const at = await createTransaction(alice.id, expense(aw.id, alice.cat("Food"), 100));
    const bt = await createTransaction(bob.id, expense(bw.id, bob.cat("Food"), 200));
    const before = await snapshot();

    expect(await getCategory(bob.id, alice.cat("Food"))).toBeNull();
    expect((await listCategoriesWithUsage(bob.id)).map((c) => c.id)).not.toContain(alice.cat("Food"));
    await expectServiceError(() => renameCategory(bob.id, alice.cat("Food"), { name: "pwn" }), "NOT_FOUND");
    await expectServiceError(() => deleteCategory(bob.id, alice.cat("Bills")), "NOT_FOUND");
    await expectServiceError(
      () => deleteCategory(bob.id, alice.cat("Food"), { moveToCategoryId: bob.cat("Bills") }),
      "NOT_FOUND",
    );
    // bob's own category can't be moved into one of alice's
    await expectServiceError(
      () => deleteCategory(bob.id, bob.cat("Food"), { moveToCategoryId: alice.cat("Bills") }),
      "VALIDATION",
      "moveToCategoryId",
    );
    expect(await snapshot()).toEqual(before);

    // and when bob reorganises his own categories, alice's rows stay as they were
    await renameCategory(bob.id, bob.cat("Food"), { name: "Snacks" });
    await deleteCategory(bob.id, bob.cat("Food"), { moveToCategoryId: bob.cat("Bills") });
    expect((await getTransaction(bob.id, bt.id))?.categoryName).toBe("Bills");
    expect(await getTransaction(alice.id, at.id)).toMatchObject({ categoryId: alice.cat("Food"), categoryName: "Food" });
    expect(await listCategories(alice.id)).toHaveLength(8);
    expect(before.categories.filter((c) => c.userId === alice.id)).toEqual(
      await db.select().from(categories).where(eq(categories.userId, alice.id)).orderBy(categories.id),
    );
  });
});

describe("category form input", () => {
  const fd = (entries: Record<string, string>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(entries)) f.append(k, v);
    return f;
  };

  it("parses the bound kind and ids", async () => {
    expect(parseCategoryKind("expense")).toBe("expense");
    expect(parseCategoryKind("income")).toBe("income");
    expect(parseCategoryKind("transfer")).toBeNull();
    expect(parseCategoryId(12)).toBe(12);
    expect(parseCategoryId("12")).toBe(12);
    for (const bad of [0, -1, 1.5, "", "1e3", "abc", null, undefined]) expect(parseCategoryId(bad)).toBeNull();
  });

  it("reads the replacement: empty → none, junk → 0 (rejected by the service)", async () => {
    expect(parseMoveTo(fd({}))).toBeUndefined();
    expect(parseMoveTo(fd({ moveToCategoryId: "" }))).toBeUndefined();
    expect(parseMoveTo(fd({ moveToCategoryId: "7" }))).toBe(7);
    expect(parseMoveTo(fd({ moveToCategoryId: "x" }))).toBe(0);
    expect(nameField(fd({ name: "  Coffee " }))).toBe("  Coffee ");
    expect(nameField(fd({}))).toBe("");
  });
});
