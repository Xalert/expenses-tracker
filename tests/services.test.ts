import { beforeEach, describe, expect, it } from "vitest";
import type { DB } from "@/db";
import { transactions } from "@/db/schema";
import { ServiceError } from "@/lib/errors";
import { listCategories } from "@/server/categories";
import { getDashboard } from "@/server/dashboard";
import {
  createTransaction,
  deleteTransaction,
  getTransaction,
  listTransactions,
  updateTransaction,
} from "@/server/transactions";
import { createTransfer, deleteTransfer, getTransfer, updateTransfer } from "@/server/transfers";
import {
  archiveWallet,
  createWallet,
  deleteWallet,
  getWallet,
  listWallets,
  unarchiveWallet,
  updateWallet,
} from "@/server/wallets";
import { makeUser, useFreshDb } from "./helpers";

let db: DB;
let alice: Awaited<ReturnType<typeof makeUser>>;
let bob: Awaited<ReturnType<typeof makeUser>>;

beforeEach(async () => {
  db = await useFreshDb();
  alice = await makeUser(db, "alice@example.com");
  bob = await makeUser(db, "bob@example.com");
});

async function expectServiceError(fn: () => unknown, code: ServiceError["code"], field?: string) {
  try {
    await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe(code);
    if (field !== undefined) expect((err as ServiceError).field).toBe(field);
    return;
  }
  throw new Error("expected a ServiceError");
}

const expense = (walletId: number, categoryId: number, amountMinor: number, date = "2026-03-10", note?: string) =>
  ({ walletId, kind: "expense" as const, categoryId, amountMinor, date, note });
const income = (walletId: number, categoryId: number, amountMinor: number, date = "2026-03-10", note?: string) =>
  ({ walletId, kind: "income" as const, categoryId, amountMinor, date, note });

describe("categories", () => {
  it("seeds the 8 defaults", async () => {
    const cats = await listCategories(alice.id);
    expect(cats).toHaveLength(8);
    expect((await listCategories(alice.id, "expense")).map((c) => c.name)).toEqual([
      "Bills", "Food", "Groceries", "Housing", "Transport",
    ]);
    expect((await listCategories(alice.id, "income")).map((c) => c.name)).toEqual(["Extra Income", "Refund", "Salary"]);
  });
});

describe("wallets", () => {
  it("creates wallets and computes balances", async () => {
    const w = await createWallet(alice.id, { name: "  Cash  ", currency: "eur", initialBalanceMinor: 10000 });
    expect(w).toMatchObject({ name: "Cash", currency: "EUR", balanceMinor: 10000, transactionCount: 0, archivedAt: null });

    await createTransaction(alice.id, income(w.id, alice.cat("Salary"), 5000));
    await createTransaction(alice.id, expense(w.id, alice.cat("Food"), 1250));
    const other = await createWallet(alice.id, { name: "Bank", currency: "EUR", initialBalanceMinor: 0 });
    await createTransfer(alice.id, { fromWalletId: w.id, toWalletId: other.id, amountMinor: 2000, date: "2026-03-11" });
    await createTransfer(alice.id, { fromWalletId: other.id, toWalletId: w.id, amountMinor: 500, date: "2026-03-12" });

    // 10000 + 5000 - 1250 - 2000 + 500
    expect(await getWallet(alice.id, w.id)).toMatchObject({ balanceMinor: 12250, transactionCount: 4 });
    expect(await getWallet(alice.id, other.id)).toMatchObject({ balanceMinor: 1500, transactionCount: 2 });
  });

  it("allows a negative initial balance and validates input", async () => {
    expect((await createWallet(alice.id, { name: "Card", currency: "USD", initialBalanceMinor: -500 })).balanceMinor).toBe(-500);
    await expectServiceError(() => createWallet(alice.id, { name: " ", currency: "EUR", initialBalanceMinor: 0 }), "VALIDATION", "name");
    await expectServiceError(() => createWallet(alice.id, { name: "X", currency: "ZZZ", initialBalanceMinor: 0 }), "VALIDATION", "currency");
    await expectServiceError(() => createWallet(alice.id, { name: "X", currency: "EUR", initialBalanceMinor: 1.5 }), "VALIDATION");
  });

  it("updates name and initial balance but never the currency", async () => {
    const w = await createWallet(alice.id, { name: "Cash", currency: "EUR", initialBalanceMinor: 0 });
    const updated = await updateWallet(alice.id, w.id, { name: "Pocket", initialBalanceMinor: 300, currency: "USD" } as never);
    expect(updated).toMatchObject({ name: "Pocket", initialBalanceMinor: 300, balanceMinor: 300, currency: "EUR" });
  });

  it("lists active first then archived, by name", async () => {
    const b = await createWallet(alice.id, { name: "b", currency: "EUR", initialBalanceMinor: 0 });
    await createWallet(alice.id, { name: "C", currency: "EUR", initialBalanceMinor: 0 });
    const a = await createWallet(alice.id, { name: "A", currency: "EUR", initialBalanceMinor: 0 });
    await archiveWallet(alice.id, a.id);
    expect((await listWallets(alice.id)).map((w) => w.name)).toEqual(["b", "C"]);
    expect((await listWallets(alice.id, { includeArchived: true })).map((w) => w.name)).toEqual(["b", "C", "A"]);
    expect((await getWallet(alice.id, a.id))?.archivedAt).toBeInstanceOf(Date);
    await unarchiveWallet(alice.id, a.id);
    expect((await listWallets(alice.id)).map((w) => w.name)).toEqual(["A", "b", "C"]);
    expect(b.archivedAt).toBeNull();
  });

  it("deletes only wallets without transactions", async () => {
    const empty = await createWallet(alice.id, { name: "Empty", currency: "EUR", initialBalanceMinor: 100 });
    await deleteWallet(alice.id, empty.id);
    expect(await getWallet(alice.id, empty.id)).toBeNull();

    const used = await createWallet(alice.id, { name: "Used", currency: "EUR", initialBalanceMinor: 0 });
    const t = await createTransaction(alice.id, expense(used.id, alice.cat("Food"), 100));
    await expectServiceError(() => deleteWallet(alice.id, used.id), "CONFLICT");
    await deleteTransaction(alice.id, t.id);
    await deleteWallet(alice.id, used.id);
    expect(await getWallet(alice.id, used.id)).toBeNull();
  });

  it("archived wallets cannot receive new transactions or transfers", async () => {
    const w = await createWallet(alice.id, { name: "Old", currency: "EUR", initialBalanceMinor: 0 });
    const w2 = await createWallet(alice.id, { name: "New", currency: "EUR", initialBalanceMinor: 0 });
    const t = await createTransaction(alice.id, expense(w.id, alice.cat("Food"), 100));
    await archiveWallet(alice.id, w.id);
    await expectServiceError(() => createTransaction(alice.id, expense(w.id, alice.cat("Food"), 100)), "VALIDATION", "walletId");
    await expectServiceError(
      () => createTransfer(alice.id, { fromWalletId: w2.id, toWalletId: w.id, amountMinor: 1, date: "2026-03-01" }),
      "VALIDATION",
      "toWalletId",
    );
    // Editing an existing transaction that already lives on the archived wallet is still allowed.
    expect((await updateTransaction(alice.id, t.id, expense(w.id, alice.cat("Food"), 250))).amountMinor).toBe(250);
    // History stays visible.
    expect((await listTransactions(alice.id, { walletId: w.id })).total).toBe(1);
  });
});

describe("transactions", () => {
  it("creates, reads, updates and deletes", async () => {
    const w = await createWallet(alice.id, { name: "Cash", currency: "EUR", initialBalanceMinor: 0 });
    const t = await createTransaction(alice.id, expense(w.id, alice.cat("Food"), 1999, "2026-03-01", "  lunch "));
    expect(t).toMatchObject({
      kind: "expense",
      walletName: "Cash",
      currency: "EUR",
      categoryName: "Food",
      amountMinor: 1999,
      signedAmountMinor: -1999,
      note: "lunch",
      transferId: null,
      counterparty: null,
    });
    const u = await updateTransaction(alice.id, t.id, income(w.id, alice.cat("Refund"), 500, "2026-03-02", ""));
    expect(u).toMatchObject({ kind: "income", categoryName: "Refund", signedAmountMinor: 500, note: null, date: "2026-03-02" });
    await deleteTransaction(alice.id, t.id);
    expect(await getTransaction(alice.id, t.id)).toBeNull();
  });

  it("requires the category kind to match the transaction kind", async () => {
    const w = await createWallet(alice.id, { name: "Cash", currency: "EUR", initialBalanceMinor: 0 });
    await expectServiceError(() => createTransaction(alice.id, expense(w.id, alice.cat("Salary"), 100)), "VALIDATION", "categoryId");
    await expectServiceError(() => createTransaction(alice.id, income(w.id, alice.cat("Food"), 100)), "VALIDATION", "categoryId");
    const t = await createTransaction(alice.id, expense(w.id, alice.cat("Food"), 100));
    await expectServiceError(() => updateTransaction(alice.id, t.id, income(w.id, alice.cat("Food"), 100)), "VALIDATION", "categoryId");
  });

  it("validates amount, date and kind", async () => {
    const w = await createWallet(alice.id, { name: "Cash", currency: "EUR", initialBalanceMinor: 0 });
    const food = alice.cat("Food");
    await expectServiceError(() => createTransaction(alice.id, expense(w.id, food, 0)), "VALIDATION", "amount");
    await expectServiceError(() => createTransaction(alice.id, expense(w.id, food, -5)), "VALIDATION", "amount");
    await expectServiceError(() => createTransaction(alice.id, expense(w.id, food, 1.5)), "VALIDATION", "amount");
    await expectServiceError(() => createTransaction(alice.id, expense(w.id, food, 100, "2026-02-30")), "VALIDATION", "date");
    await expectServiceError(
      () => createTransaction(alice.id, { ...expense(w.id, food, 100), kind: "transfer_out" as never }),
      "VALIDATION",
      "kind",
    );
  });

  it("rejects editing or deleting transfer legs directly", async () => {
    const a = await createWallet(alice.id, { name: "A", currency: "EUR", initialBalanceMinor: 0 });
    const b = await createWallet(alice.id, { name: "B", currency: "EUR", initialBalanceMinor: 0 });
    const tr = await createTransfer(alice.id, { fromWalletId: a.id, toWalletId: b.id, amountMinor: 100, date: "2026-03-01" });
    const leg = (await listTransactions(alice.id, { kind: "transfer" })).items[0];
    expect(leg.transferId).toBe(tr.id);
    await expectServiceError(() => updateTransaction(alice.id, leg.id, expense(a.id, alice.cat("Food"), 1)), "VALIDATION");
    await expectServiceError(() => deleteTransaction(alice.id, leg.id), "VALIDATION");
  });

  it("filters and paginates", async () => {
    const eur = await createWallet(alice.id, { name: "EUR", currency: "EUR", initialBalanceMinor: 0 });
    const usd = await createWallet(alice.id, { name: "USD", currency: "USD", initialBalanceMinor: 0 });
    const food = alice.cat("Food");
    const bills = alice.cat("Bills");
    const salary = alice.cat("Salary");
    for (let d = 1; d <= 9; d++) {
      await createTransaction(alice.id, expense(eur.id, food, 100 * d, `2026-03-0${d}`, d === 5 ? "Pizza 100% night" : `meal ${d}`));
    }
    await createTransaction(alice.id, expense(usd.id, bills, 5000, "2026-02-15", "Electricity"));
    await createTransaction(alice.id, income(usd.id, salary, 300000, "2026-02-28", "March pay"));
    await createTransfer(alice.id, { fromWalletId: eur.id, toWalletId: usd.id, amountMinor: 1000, receivedAmountMinor: 1100, date: "2026-03-20" });

    const all = await listTransactions(alice.id);
    expect(all.total).toBe(13);
    // date desc, then id desc
    expect(all.items.map((t) => t.date).slice(0, 3)).toEqual(["2026-03-20", "2026-03-20", "2026-03-09"]);
    expect(all.items[0].id).toBeGreaterThan(all.items[1].id);

    expect((await listTransactions(alice.id, { walletId: usd.id })).total).toBe(3);
    expect((await listTransactions(alice.id, { kind: "expense" })).total).toBe(10);
    expect((await listTransactions(alice.id, { kind: "income" })).total).toBe(1);
    expect((await listTransactions(alice.id, { kind: "transfer" })).total).toBe(2);
    expect((await listTransactions(alice.id, { categoryId: bills })).items.map((t) => t.note)).toEqual(["Electricity"]);
    expect((await listTransactions(alice.id, { from: "2026-02-01", to: "2026-02-28" })).total).toBe(2);
    expect((await listTransactions(alice.id, { from: "2026-03-09" })).total).toBe(3);
    expect((await listTransactions(alice.id, { q: "PIZZA" })).items).toHaveLength(1);
    expect((await listTransactions(alice.id, { q: "100%" })).items).toHaveLength(1); // % is literal
    expect((await listTransactions(alice.id, { q: "_" })).total).toBe(0); // _ is literal
    expect((await listTransactions(alice.id, { kind: "expense", walletId: eur.id, from: "2026-03-03", to: "2026-03-05" })).total).toBe(3);

    const page1 = await listTransactions(alice.id, { limit: 5 });
    const page2 = await listTransactions(alice.id, { limit: 5, offset: 5 });
    const page3 = await listTransactions(alice.id, { limit: 5, offset: 10 });
    expect([page1.total, page2.total, page3.total]).toEqual([13, 13, 13]);
    expect(page3.items).toHaveLength(3);
    const ids = [...page1.items, ...page2.items, ...page3.items].map((t) => t.id);
    expect(new Set(ids).size).toBe(13);
    expect(ids).toEqual(all.items.map((t) => t.id));

    expect((await listTransactions(alice.id, { limit: 0 })).items).toHaveLength(1); // clamped to >= 1
    await expectServiceError(() => listTransactions(alice.id, { from: "March" }), "VALIDATION", "from");
  });

  it("defaults to 50 items per page", async () => {
    const w = await createWallet(alice.id, { name: "Cash", currency: "EUR", initialBalanceMinor: 0 });
    const food = alice.cat("Food");
    await db
      .insert(transactions)
      .values(Array.from({ length: 60 }, () => ({ userId: alice.id, walletId: w.id, kind: "expense" as const, categoryId: food, amountMinor: 1, date: "2026-01-01" })));
    const r = await listTransactions(alice.id);
    expect(r.items).toHaveLength(50);
    expect(r.total).toBe(60);
  });
});

describe("transfers", () => {
  it("same currency: both legs carry the sent amount; received is ignored", async () => {
    const a = await createWallet(alice.id, { name: "A", currency: "EUR", initialBalanceMinor: 10000 });
    const b = await createWallet(alice.id, { name: "B", currency: "EUR", initialBalanceMinor: 0 });
    const t = await createTransfer(alice.id, { fromWalletId: a.id, toWalletId: b.id, amountMinor: 2500, receivedAmountMinor: 9999, date: "2026-03-05", note: "save" });
    expect(t).toMatchObject({
      date: "2026-03-05",
      note: "save",
      from: { walletId: a.id, walletName: "A", currency: "EUR", amountMinor: 2500 },
      to: { walletId: b.id, walletName: "B", currency: "EUR", amountMinor: 2500 },
    });
    expect((await getWallet(alice.id, a.id))?.balanceMinor).toBe(7500);
    expect((await getWallet(alice.id, b.id))?.balanceMinor).toBe(2500);

    const legs = (await listTransactions(alice.id, { kind: "transfer" })).items;
    const out = legs.find((l) => l.kind === "transfer_out")!;
    const inn = legs.find((l) => l.kind === "transfer_in")!;
    expect(out).toMatchObject({ walletId: a.id, signedAmountMinor: -2500, categoryId: null, note: "save", counterparty: { walletId: b.id, walletName: "B", amountMinor: 2500 } });
    expect(inn).toMatchObject({ walletId: b.id, signedAmountMinor: 2500, counterparty: { walletId: a.id, walletName: "A", currency: "EUR" } });
  });

  it("cross currency: requires the received amount", async () => {
    const eur = await createWallet(alice.id, { name: "EUR", currency: "EUR", initialBalanceMinor: 0 });
    const ron = await createWallet(alice.id, { name: "RON", currency: "RON", initialBalanceMinor: 0 });
    await expectServiceError(
      () => createTransfer(alice.id, { fromWalletId: eur.id, toWalletId: ron.id, amountMinor: 1000, date: "2026-03-05" }),
      "VALIDATION",
      "receivedAmount",
    );
    await expectServiceError(
      () => createTransfer(alice.id, { fromWalletId: eur.id, toWalletId: ron.id, amountMinor: 1000, receivedAmountMinor: 0, date: "2026-03-05" }),
      "VALIDATION",
      "receivedAmount",
    );
    // nothing half-written
    expect((await listTransactions(alice.id)).total).toBe(0);

    const t = await createTransfer(alice.id, { fromWalletId: eur.id, toWalletId: ron.id, amountMinor: 1000, receivedAmountMinor: 4975, date: "2026-03-05" });
    expect(t.from).toMatchObject({ currency: "EUR", amountMinor: 1000 });
    expect(t.to).toMatchObject({ currency: "RON", amountMinor: 4975 });
    expect((await getWallet(alice.id, eur.id))?.balanceMinor).toBe(-1000);
    expect((await getWallet(alice.id, ron.id))?.balanceMinor).toBe(4975);
  });

  it("validates wallets", async () => {
    const a = await createWallet(alice.id, { name: "A", currency: "EUR", initialBalanceMinor: 0 });
    await expectServiceError(
      () => createTransfer(alice.id, { fromWalletId: a.id, toWalletId: a.id, amountMinor: 1, date: "2026-03-05" }),
      "VALIDATION",
      "toWalletId",
    );
    await expectServiceError(
      () => createTransfer(alice.id, { fromWalletId: a.id, toWalletId: 9999, amountMinor: 1, date: "2026-03-05" }),
      "NOT_FOUND",
      "toWalletId",
    );
  });

  it("updates both legs, including switching currencies and wallets", async () => {
    const a = await createWallet(alice.id, { name: "A", currency: "EUR", initialBalanceMinor: 0 });
    const b = await createWallet(alice.id, { name: "B", currency: "EUR", initialBalanceMinor: 0 });
    const c = await createWallet(alice.id, { name: "C", currency: "USD", initialBalanceMinor: 0 });
    const t = await createTransfer(alice.id, { fromWalletId: a.id, toWalletId: b.id, amountMinor: 1000, date: "2026-03-05" });

    const u = await updateTransfer(alice.id, t.id, { fromWalletId: a.id, toWalletId: c.id, amountMinor: 2000, receivedAmountMinor: 2150, date: "2026-03-06", note: "fx" });
    expect(u).toMatchObject({ id: t.id, date: "2026-03-06", note: "fx", from: { walletId: a.id, amountMinor: 2000 }, to: { walletId: c.id, currency: "USD", amountMinor: 2150 } });
    expect((await getWallet(alice.id, a.id))?.balanceMinor).toBe(-2000);
    expect((await getWallet(alice.id, b.id))?.balanceMinor).toBe(0);
    expect((await getWallet(alice.id, c.id))?.balanceMinor).toBe(2150);
    const legs = (await listTransactions(alice.id)).items;
    expect(legs).toHaveLength(2);
    expect(legs.every((l) => l.date === "2026-03-06" && l.note === "fx")).toBe(true);

    // back to same currency: received forced to equal sent
    const v = await updateTransfer(alice.id, t.id, { fromWalletId: b.id, toWalletId: a.id, amountMinor: 700, receivedAmountMinor: 1, date: "2026-03-07" });
    expect(v.to.amountMinor).toBe(700);
    expect((await getWallet(alice.id, b.id))?.balanceMinor).toBe(-700);
    expect((await getWallet(alice.id, a.id))?.balanceMinor).toBe(700);
  });

  it("delete removes the transfer and both legs", async () => {
    const a = await createWallet(alice.id, { name: "A", currency: "EUR", initialBalanceMinor: 0 });
    const b = await createWallet(alice.id, { name: "B", currency: "EUR", initialBalanceMinor: 0 });
    const t = await createTransfer(alice.id, { fromWalletId: a.id, toWalletId: b.id, amountMinor: 1000, date: "2026-03-05" });
    await deleteTransfer(alice.id, t.id);
    expect(await getTransfer(alice.id, t.id)).toBeNull();
    expect((await listTransactions(alice.id)).total).toBe(0);
    expect((await getWallet(alice.id, a.id))?.balanceMinor).toBe(0);
    await deleteWallet(alice.id, a.id); // now empty
  });
});

describe("dashboard", () => {
  it("computes per-currency totals for the month, excluding transfers and archived wallets", async () => {
    const eur1 = await createWallet(alice.id, { name: "Cash", currency: "EUR", initialBalanceMinor: 1000 });
    const eur2 = await createWallet(alice.id, { name: "Bank", currency: "EUR", initialBalanceMinor: 50000 });
    const usd = await createWallet(alice.id, { name: "US", currency: "USD", initialBalanceMinor: 0 });
    const old = await createWallet(alice.id, { name: "Old", currency: "GBP", initialBalanceMinor: 0 });
    const food = alice.cat("Food");
    const bills = alice.cat("Bills");

    await createTransaction(alice.id, income(eur2.id, alice.cat("Salary"), 300000, "2026-03-01"));
    await createTransaction(alice.id, expense(eur1.id, food, 1500, "2026-03-02"));
    await createTransaction(alice.id, expense(eur2.id, food, 2500, "2026-03-31"));
    await createTransaction(alice.id, expense(eur2.id, bills, 10000, "2026-03-15"));
    await createTransaction(alice.id, expense(eur2.id, bills, 99999, "2026-02-28")); // previous month
    await createTransaction(alice.id, expense(usd.id, food, 700, "2026-03-03"));
    await createTransaction(alice.id, expense(old.id, food, 5000, "2026-03-03"));
    await archiveWallet(alice.id, old.id);
    await createTransfer(alice.id, { fromWalletId: eur2.id, toWalletId: usd.id, amountMinor: 1000, receivedAmountMinor: 1080, date: "2026-03-10" });

    const d = await getDashboard(alice.id, { month: "2026-03" });
    expect(d.month).toBe("2026-03");
    expect(d.wallets.map((w) => w.name)).toEqual(["Bank", "Cash", "US"]);
    expect(d.totalsByCurrency).toEqual([
      // balance: 1000 + 50000 + 300000 - 1500 - 2500 - 10000 - 99999 - 1000
      { currency: "EUR", balanceMinor: 236001, incomeMinor: 300000, expenseMinor: 14000 },
      { currency: "USD", balanceMinor: 380, incomeMinor: 0, expenseMinor: 700 },
    ]);
    expect(d.expenseByCategory).toEqual([
      { currency: "EUR", categoryId: bills, categoryName: "Bills", amountMinor: 10000 },
      { currency: "EUR", categoryId: food, categoryName: "Food", amountMinor: 4000 },
      { currency: "USD", categoryId: food, categoryName: "Food", amountMinor: 700 },
    ]);
    expect(d.recent).toHaveLength(8);
    expect(d.recent[0].date).toBe("2026-03-31");

    const feb = await getDashboard(alice.id, { month: "2026-02" });
    expect(feb.totalsByCurrency[0]).toMatchObject({ currency: "EUR", incomeMinor: 0, expenseMinor: 99999 });
    expect(feb.expenseByCategory).toHaveLength(1);

    await expectServiceError(() => getDashboard(alice.id, { month: "2026-13" }), "VALIDATION");
    expect((await getDashboard(bob.id)).totalsByCurrency).toEqual([]);
    expect((await getDashboard(bob.id)).month).toMatch(/^\d{4}-\d{2}$/);
  });
});

describe("cross-user isolation", () => {
  it("user B cannot read or mutate user A's data", async () => {
    const aw = await createWallet(alice.id, { name: "Alice EUR", currency: "EUR", initialBalanceMinor: 100 });
    const aw2 = await createWallet(alice.id, { name: "Alice USD", currency: "USD", initialBalanceMinor: 0 });
    const at = await createTransaction(alice.id, expense(aw.id, alice.cat("Food"), 50));
    const atr = await createTransfer(alice.id, { fromWalletId: aw.id, toWalletId: aw2.id, amountMinor: 10, receivedAmountMinor: 11, date: "2026-03-05" });
    const bw = await createWallet(bob.id, { name: "Bob EUR", currency: "EUR", initialBalanceMinor: 0 });
    const bw2 = await createWallet(bob.id, { name: "Bob EUR 2", currency: "EUR", initialBalanceMinor: 0 });

    // reads
    expect(await getWallet(bob.id, aw.id)).toBeNull();
    expect((await listWallets(bob.id, { includeArchived: true })).map((w) => w.id)).toEqual([bw.id, bw2.id]);
    expect(await getTransaction(bob.id, at.id)).toBeNull();
    expect(await getTransfer(bob.id, atr.id)).toBeNull();
    expect((await listTransactions(bob.id)).total).toBe(0);
    expect((await listTransactions(bob.id, { walletId: aw.id })).total).toBe(0);
    expect((await getDashboard(bob.id, { month: "2026-03" })).recent).toEqual([]);

    // wallet mutations
    await expectServiceError(() => updateWallet(bob.id, aw.id, { name: "pwn", initialBalanceMinor: 0 }), "NOT_FOUND");
    await expectServiceError(() => archiveWallet(bob.id, aw.id), "NOT_FOUND");
    await expectServiceError(() => unarchiveWallet(bob.id, aw.id), "NOT_FOUND");
    await expectServiceError(() => deleteWallet(bob.id, aw.id), "NOT_FOUND");

    // transactions: bob can't touch alice's, nor use alice's wallet/category
    await expectServiceError(() => updateTransaction(bob.id, at.id, expense(bw.id, bob.cat("Food"), 1)), "NOT_FOUND");
    await expectServiceError(() => deleteTransaction(bob.id, at.id), "NOT_FOUND");
    await expectServiceError(() => createTransaction(bob.id, expense(aw.id, bob.cat("Food"), 1)), "NOT_FOUND", "walletId");
    await expectServiceError(() => createTransaction(bob.id, expense(bw.id, alice.cat("Food"), 1)), "NOT_FOUND", "categoryId");

    // transfers
    await expectServiceError(() => updateTransfer(bob.id, atr.id, { fromWalletId: bw.id, toWalletId: bw2.id, amountMinor: 1, date: "2026-03-05" }), "NOT_FOUND");
    await expectServiceError(() => deleteTransfer(bob.id, atr.id), "NOT_FOUND");
    await expectServiceError(() => createTransfer(bob.id, { fromWalletId: aw.id, toWalletId: bw.id, amountMinor: 1, date: "2026-03-05" }), "NOT_FOUND", "fromWalletId");
    await expectServiceError(() => createTransfer(bob.id, { fromWalletId: bw.id, toWalletId: aw.id, amountMinor: 1, date: "2026-03-05" }), "NOT_FOUND", "toWalletId");

    // alice's data is untouched
    expect(await getWallet(alice.id, aw.id)).toMatchObject({ name: "Alice EUR", balanceMinor: 40, archivedAt: null });
    expect((await getTransaction(alice.id, at.id))?.amountMinor).toBe(50);
    expect((await getTransfer(alice.id, atr.id))?.to.amountMinor).toBe(11);
  });
});
