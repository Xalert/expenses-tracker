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
let alice: ReturnType<typeof makeUser>;
let bob: ReturnType<typeof makeUser>;

beforeEach(() => {
  db = useFreshDb();
  alice = makeUser(db, "alice@example.com");
  bob = makeUser(db, "bob@example.com");
});

function expectServiceError(fn: () => unknown, code: ServiceError["code"], field?: string): ServiceError {
  try {
    fn();
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
function snapshot() {
  return {
    categories: db.select().from(categories).orderBy(categories.id).all(),
    transactions: db.select().from(transactions).orderBy(transactions.id).all(),
  };
}

const usage = (userId: number) =>
  Object.fromEntries(listCategoriesWithUsage(userId).map((c) => [`${c.kind}:${c.name}`, c.transactionCount]));

describe("listCategoriesWithUsage", () => {
  it("counts transactions per category in listCategories order, ignoring transfer legs", () => {
    const w = createWallet(alice.id, { name: "Cash", currency: "EUR", initialBalanceMinor: 0 });
    const w2 = createWallet(alice.id, { name: "Bank", currency: "EUR", initialBalanceMinor: 0 });
    createTransaction(alice.id, expense(w.id, alice.cat("Food"), 100));
    createTransaction(alice.id, expense(w.id, alice.cat("Food"), 200));
    createTransaction(alice.id, income(w.id, alice.cat("Salary"), 300));
    createTransfer(alice.id, { fromWalletId: w.id, toWalletId: w2.id, amountMinor: 50, date: "2026-03-11" });
    createCategory(alice.id, { name: "coffee", kind: "expense" });

    const list = listCategoriesWithUsage(alice.id);
    expect(list.map(({ id, name, kind }) => ({ id, name, kind }))).toEqual(listCategories(alice.id));
    // case-insensitive name order: "coffee" sits between Bills and Food
    expect(list.filter((c) => c.kind === "expense").map((c) => c.name)).toEqual([
      "Bills", "coffee", "Food", "Groceries", "Housing", "Transport",
    ]);
    expect(usage(alice.id)).toMatchObject({ "expense:Food": 2, "income:Salary": 1, "expense:Bills": 0, "expense:coffee": 0 });
    expect(Object.values(usage(bob.id)).every((n) => n === 0)).toBe(true);
  });
});

describe("listCategoriesWithUsage with a month and currency", () => {
  const byName = (rows: ReturnType<typeof listCategoriesWithUsage>) =>
    Object.fromEntries(rows.map((c) => [`${c.kind}:${c.name}`, [c.transactionCount, c.monthCount, c.monthAmountMinor]]));

  it("adds the month's count over all currencies and its amount in the chosen currency only", () => {
    const eur = createWallet(alice.id, { name: "Cash", currency: "EUR", initialBalanceMinor: 0 });
    const old = createWallet(alice.id, { name: "Old", currency: "EUR", initialBalanceMinor: 0 });
    const usd = createWallet(alice.id, { name: "Dollars", currency: "USD", initialBalanceMinor: 0 });
    createTransaction(alice.id, expense(eur.id, alice.cat("Food"), 100, "2026-03-01"));
    createTransaction(alice.id, expense(old.id, alice.cat("Food"), 40, "2026-03-31"));
    createTransaction(alice.id, expense(usd.id, alice.cat("Food"), 7000, "2026-03-15"));
    createTransaction(alice.id, expense(eur.id, alice.cat("Food"), 9, "2026-02-28"));
    createTransaction(alice.id, expense(eur.id, alice.cat("Food"), 8, "2026-04-01"));
    createTransaction(alice.id, income(usd.id, alice.cat("Salary"), 5000, "2026-03-10"));
    createTransfer(alice.id, { fromWalletId: eur.id, toWalletId: old.id, amountMinor: 50, date: "2026-03-05" });
    archiveWallet(alice.id, old.id);
    createTransaction(bob.id, expense(createWallet(bob.id, { name: "B", currency: "EUR", initialBalanceMinor: 0 }).id, bob.cat("Food"), 1, "2026-03-02"));

    expect(byName(listCategoriesWithUsage(alice.id, { month: "2026-03", currency: "EUR" }))).toMatchObject({
      "expense:Food": [5, 3, 140],
      "income:Salary": [1, 1, 0],
      "expense:Bills": [0, 0, 0],
    });
    expect(byName(listCategoriesWithUsage(alice.id, { month: "2026-03", currency: "USD" }))).toMatchObject({
      "expense:Food": [5, 3, 7000],
      "income:Salary": [1, 1, 5000],
    });
    // A month without a currency counts but has no amounts; no options at all keeps the old figures with zeros.
    expect(byName(listCategoriesWithUsage(alice.id, { month: "2026-03" }))).toMatchObject({ "expense:Food": [5, 3, 0] });
    expect(byName(listCategoriesWithUsage(alice.id, { currency: "EUR" }))).toMatchObject({ "expense:Food": [5, 0, 0] });
    expect(byName(listCategoriesWithUsage(alice.id))).toMatchObject({ "expense:Food": [5, 0, 0] });
    expect(listCategoriesWithUsage(alice.id, { month: "2026-03" }).map((c) => c.id)).toEqual(
      listCategories(alice.id).map((c) => c.id),
    );
  });

  it("rejects an invalid month or currency", () => {
    expectServiceError(() => listCategoriesWithUsage(alice.id, { month: "2026-13" }), "VALIDATION", "month");
    expectServiceError(() => listCategoriesWithUsage(alice.id, { month: "2026-03", currency: "eur" }), "VALIDATION", "currency");
  });
});

describe("createCategory", () => {
  it("creates a category, trimming and collapsing whitespace", () => {
    const c = createCategory(alice.id, { name: "  Eating   out\t ", kind: "expense" });
    expect(c).toEqual({ id: expect.any(Number), name: "Eating out", kind: "expense" });
    expect(getCategory(alice.id, c.id)).toEqual(c);
    expect(listCategories(alice.id, "expense")).toContainEqual(c);
  });

  it("validates the name and kind", () => {
    expectServiceError(() => createCategory(alice.id, { name: "", kind: "expense" }), "VALIDATION", "name");
    expectServiceError(() => createCategory(alice.id, { name: "   \n ", kind: "expense" }), "VALIDATION", "name");
    expectServiceError(() => createCategory(alice.id, { name: "x".repeat(41), kind: "expense" }), "VALIDATION", "name");
    expect(createCategory(alice.id, { name: "y".repeat(40), kind: "expense" }).name).toHaveLength(40);
    // whitespace collapsing happens before the length check
    expect(createCategory(alice.id, { name: `${"z".repeat(20)}     ${"z".repeat(19)}`, kind: "expense" }).name).toHaveLength(40);
    expectServiceError(
      () => createCategory(alice.id, { name: "Gifts", kind: "transfer" as unknown as "expense" }),
      "VALIDATION",
      "kind",
    );
  });

  it("rejects a duplicate differing only in case or spacing, but allows it under the other kind", () => {
    const before = snapshot();
    const err = expectServiceError(() => createCategory(alice.id, { name: "food", kind: "expense" }), "CONFLICT", "name");
    expect(err.message).toContain("Food");
    expectServiceError(() => createCategory(alice.id, { name: " FOOD ", kind: "expense" }), "CONFLICT", "name");
    expectServiceError(() => createCategory(alice.id, { name: "extra   income", kind: "income" }), "CONFLICT", "name");
    expect(snapshot()).toEqual(before);

    expect(createCategory(alice.id, { name: "Food", kind: "income" })).toMatchObject({ name: "Food", kind: "income" });
    expect(createCategory(alice.id, { name: "Salary", kind: "expense" })).toMatchObject({ kind: "expense" });
    // another user's names don't matter
    expect(createCategory(bob.id, { name: "Coffee", kind: "expense" }).name).toBe("Coffee");
    expect(createCategory(alice.id, { name: "coffee", kind: "expense" }).name).toBe("coffee");
  });
});

describe("unique index", () => {
  it("recognises the DB's own UNIQUE violation (mapped to CONFLICT by the service)", () => {
    let caught: unknown;
    try {
      db.insert(categories).values({ userId: alice.id, kind: "expense", name: "Food" }).run();
    } catch (err) {
      caught = err;
    }
    expect(isUniqueViolation(caught)).toBe(true);
    expect(isUniqueViolation(new Error("other"))).toBe(false);
  });
});

describe("renameCategory", () => {
  it("renames, normalising the name, and the new name shows up on transactions and the dashboard", () => {
    const w = createWallet(alice.id, { name: "Cash", currency: "EUR", initialBalanceMinor: 0 });
    const t = createTransaction(alice.id, expense(w.id, alice.cat("Food"), 1500, "2026-03-02"));
    const r = renameCategory(alice.id, alice.cat("Food"), { name: "  Eating  out " });
    expect(r).toEqual({ id: alice.cat("Food"), name: "Eating out", kind: "expense" });
    expect(getTransaction(alice.id, t.id)?.categoryName).toBe("Eating out");
    expect(getDashboard(alice.id, { month: "2026-03" }).expenseByCategory).toEqual([
      { currency: "EUR", categoryId: alice.cat("Food"), categoryName: "Eating out", amountMinor: 1500 },
    ]);
  });

  it("allows changing only the letter case of its own name, and a no-op rename", () => {
    expect(renameCategory(alice.id, alice.cat("Food"), { name: "FOOD" }).name).toBe("FOOD");
    expect(renameCategory(alice.id, alice.cat("Food"), { name: " FOOD " }).name).toBe("FOOD");
    expect(getCategory(alice.id, alice.cat("Food"))?.name).toBe("FOOD");
  });

  it("rejects empty, too long and duplicate names without changing anything", () => {
    const before = snapshot();
    expectServiceError(() => renameCategory(alice.id, alice.cat("Food"), { name: "  " }), "VALIDATION", "name");
    expectServiceError(() => renameCategory(alice.id, alice.cat("Food"), { name: "a".repeat(41) }), "VALIDATION", "name");
    expectServiceError(() => renameCategory(alice.id, alice.cat("Food"), { name: "bills" }), "CONFLICT", "name");
    expect(snapshot()).toEqual(before);
    // the same name under the other kind is fine
    expect(renameCategory(alice.id, alice.cat("Food"), { name: "Salary" }).name).toBe("Salary");
  });

  it("is NOT_FOUND for missing ids", () => {
    expectServiceError(() => renameCategory(alice.id, 999_999, { name: "X" }), "NOT_FOUND");
    expectServiceError(() => renameCategory(alice.id, 0, { name: "X" }), "NOT_FOUND");
  });
});

describe("deleteCategory", () => {
  let w: ReturnType<typeof createWallet>;
  let w2: ReturnType<typeof createWallet>;
  beforeEach(() => {
    w = createWallet(alice.id, { name: "Cash", currency: "EUR", initialBalanceMinor: 0 });
    w2 = createWallet(alice.id, { name: "Bank", currency: "EUR", initialBalanceMinor: 0 });
  });

  it("deletes an unused category (replacement ignored)", () => {
    expect(deleteCategory(alice.id, alice.cat("Housing"))).toEqual({ movedTransactions: 0 });
    expect(getCategory(alice.id, alice.cat("Housing"))).toBeNull();
    expect(deleteCategory(alice.id, alice.cat("Bills"), { moveToCategoryId: alice.cat("Salary") })).toEqual({
      movedTransactions: 0,
    });
    expect(listCategories(alice.id, "expense").map((c) => c.name)).toEqual(["Food", "Groceries", "Transport"]);
  });

  it("refuses an in-use category without a replacement, naming the count, and changes nothing", () => {
    createTransaction(alice.id, expense(w.id, alice.cat("Food"), 100));
    createTransaction(alice.id, expense(w.id, alice.cat("Food"), 200));
    createTransaction(alice.id, expense(w.id, alice.cat("Food"), 300));
    const before = snapshot();
    const err = expectServiceError(() => deleteCategory(alice.id, alice.cat("Food")), "CONFLICT", "moveToCategoryId");
    expect(err.message).toContain("3 transactions");
    expectServiceError(() => deleteCategory(alice.id, alice.cat("Food"), { moveToCategoryId: null }), "CONFLICT");
    expect(snapshot()).toEqual(before);
  });

  it("moves transactions to the replacement and deletes the category atomically", () => {
    const food = alice.cat("Food");
    const groceries = alice.cat("Groceries");
    const t1 = createTransaction(alice.id, expense(w.id, food, 1000, "2026-03-02"));
    const t2 = createTransaction(alice.id, expense(w2.id, food, 500, "2026-03-03"));
    const t3 = createTransaction(alice.id, expense(w.id, groceries, 250, "2026-03-04"));
    const other = createTransaction(alice.id, expense(w.id, alice.cat("Bills"), 70, "2026-03-05"));
    const tr = createTransfer(alice.id, { fromWalletId: w.id, toWalletId: w2.id, amountMinor: 40, date: "2026-03-06", note: "move" });

    expect(getDashboard(alice.id, { month: "2026-03" }).expenseByCategory).toEqual([
      { currency: "EUR", categoryId: food, categoryName: "Food", amountMinor: 1500 },
      { currency: "EUR", categoryId: groceries, categoryName: "Groceries", amountMinor: 250 },
      { currency: "EUR", categoryId: alice.cat("Bills"), categoryName: "Bills", amountMinor: 70 },
    ]);

    expect(deleteCategory(alice.id, food, { moveToCategoryId: groceries })).toEqual({ movedTransactions: 2 });

    expect(getCategory(alice.id, food)).toBeNull();
    for (const t of [t1, t2, t3]) {
      expect(getTransaction(alice.id, t.id)).toMatchObject({ categoryId: groceries, categoryName: "Groceries" });
    }
    expect(getTransaction(alice.id, other.id)?.categoryId).toBe(alice.cat("Bills"));
    expect(usage(alice.id)).toMatchObject({ "expense:Groceries": 3, "expense:Bills": 1 });
    expect(usage(alice.id)["expense:Food"]).toBeUndefined();
    expect(listTransactions(alice.id, { categoryId: groceries }).total).toBe(3);
    expect(getDashboard(alice.id, { month: "2026-03" }).expenseByCategory).toEqual([
      { currency: "EUR", categoryId: groceries, categoryName: "Groceries", amountMinor: 1750 },
      { currency: "EUR", categoryId: alice.cat("Bills"), categoryName: "Bills", amountMinor: 70 },
    ]);
    // transfer legs are untouched
    expect(getTransfer(alice.id, tr.id)).toMatchObject({ note: "move", from: { amountMinor: 40 }, to: { amountMinor: 40 } });
    const legs = db.select().from(transactions).where(eq(transactions.transferId, tr.id)).all();
    expect(legs.map((l) => [l.kind, l.categoryId])).toEqual([["transfer_out", null], ["transfer_in", null]]);
  });

  it("rejects a replacement of the other kind, itself, or a missing one, changing nothing", () => {
    createTransaction(alice.id, expense(w.id, alice.cat("Food"), 100));
    const before = snapshot();
    for (const moveToCategoryId of [alice.cat("Salary"), alice.cat("Food"), 999_999, 0, -1, 1.5]) {
      expectServiceError(
        () => deleteCategory(alice.id, alice.cat("Food"), { moveToCategoryId }),
        "VALIDATION",
        "moveToCategoryId",
      );
    }
    expect(snapshot()).toEqual(before);
  });

  it("tells the user to create another category when it is the last of its kind and in use", () => {
    createTransaction(alice.id, income(w.id, alice.cat("Salary"), 100));
    deleteCategory(alice.id, alice.cat("Refund"));
    deleteCategory(alice.id, alice.cat("Extra Income"));
    const before = snapshot();
    const err = expectServiceError(() => deleteCategory(alice.id, alice.cat("Salary")), "CONFLICT", "moveToCategoryId");
    expect(err.message).toMatch(/1 transaction\b.*Create another income category first/);
    expect(snapshot()).toEqual(before);
    // a user may end up with no income categories at all once nothing uses them
    const fresh = makeUser(db, "carol@example.com");
    for (const name of ["Salary", "Refund", "Extra Income"]) deleteCategory(fresh.id, fresh.cat(name));
    expect(listCategories(fresh.id, "income")).toEqual([]);
  });

  it("is NOT_FOUND for a missing category", () => {
    expectServiceError(() => deleteCategory(alice.id, 999_999), "NOT_FOUND");
  });
});

describe("category isolation between users", () => {
  it("user B cannot rename, delete or move into user A's categories", () => {
    const aw = createWallet(alice.id, { name: "A", currency: "EUR", initialBalanceMinor: 0 });
    const bw = createWallet(bob.id, { name: "B", currency: "EUR", initialBalanceMinor: 0 });
    const at = createTransaction(alice.id, expense(aw.id, alice.cat("Food"), 100));
    const bt = createTransaction(bob.id, expense(bw.id, bob.cat("Food"), 200));
    const before = snapshot();

    expect(getCategory(bob.id, alice.cat("Food"))).toBeNull();
    expect(listCategoriesWithUsage(bob.id).map((c) => c.id)).not.toContain(alice.cat("Food"));
    expectServiceError(() => renameCategory(bob.id, alice.cat("Food"), { name: "pwn" }), "NOT_FOUND");
    expectServiceError(() => deleteCategory(bob.id, alice.cat("Bills")), "NOT_FOUND");
    expectServiceError(
      () => deleteCategory(bob.id, alice.cat("Food"), { moveToCategoryId: bob.cat("Bills") }),
      "NOT_FOUND",
    );
    // bob's own category can't be moved into one of alice's
    expectServiceError(
      () => deleteCategory(bob.id, bob.cat("Food"), { moveToCategoryId: alice.cat("Bills") }),
      "VALIDATION",
      "moveToCategoryId",
    );
    expect(snapshot()).toEqual(before);

    // and when bob reorganises his own categories, alice's rows stay as they were
    renameCategory(bob.id, bob.cat("Food"), { name: "Snacks" });
    deleteCategory(bob.id, bob.cat("Food"), { moveToCategoryId: bob.cat("Bills") });
    expect(getTransaction(bob.id, bt.id)?.categoryName).toBe("Bills");
    expect(getTransaction(alice.id, at.id)).toMatchObject({ categoryId: alice.cat("Food"), categoryName: "Food" });
    expect(listCategories(alice.id)).toHaveLength(8);
    expect(before.categories.filter((c) => c.userId === alice.id)).toEqual(
      db.select().from(categories).where(eq(categories.userId, alice.id)).orderBy(categories.id).all(),
    );
  });
});

describe("category form input", () => {
  const fd = (entries: Record<string, string>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(entries)) f.append(k, v);
    return f;
  };

  it("parses the bound kind and ids", () => {
    expect(parseCategoryKind("expense")).toBe("expense");
    expect(parseCategoryKind("income")).toBe("income");
    expect(parseCategoryKind("transfer")).toBeNull();
    expect(parseCategoryId(12)).toBe(12);
    expect(parseCategoryId("12")).toBe(12);
    for (const bad of [0, -1, 1.5, "", "1e3", "abc", null, undefined]) expect(parseCategoryId(bad)).toBeNull();
  });

  it("reads the replacement: empty → none, junk → 0 (rejected by the service)", () => {
    expect(parseMoveTo(fd({}))).toBeUndefined();
    expect(parseMoveTo(fd({ moveToCategoryId: "" }))).toBeUndefined();
    expect(parseMoveTo(fd({ moveToCategoryId: "7" }))).toBe(7);
    expect(parseMoveTo(fd({ moveToCategoryId: "x" }))).toBe(0);
    expect(nameField(fd({ name: "  Coffee " }))).toBe("  Coffee ");
    expect(nameField(fd({}))).toBe("");
  });
});
