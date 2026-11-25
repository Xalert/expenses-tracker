// Budgets (src/server/budgets.ts): set / replace / remove, the expense-only and held-currency rules, the month's
// progress in the budget's own currency over every wallet (converted per day, missing rates named), and what removing,
// archiving and the kind change of a category do to its budget. Plus the pure display helpers (src/lib/budgets.ts).
import { beforeEach, describe, expect, it } from "vitest";
import type { DB } from "@/db";
import {
  budgetBar,
  budgetPercent,
  closestToLimit,
  leftLine,
  missingLine,
  paceLine,
  spentOfLine,
} from "@/lib/budgets";
import { isServiceError } from "@/lib/errors";
import type { DailyRates } from "@/lib/fx";
import { getMonthBudgets, listBudgets, removeBudget, setBudget } from "@/server/budgets";
import { archiveCategory, changeCategoryKind, createCategory, deleteCategory, unarchiveCategory } from "@/server/categories";
import { createTransaction } from "@/server/transactions";
import { createTransfer } from "@/server/transfers";
import { createWalletGroup } from "@/server/wallet-groups";
import { archiveWallet, createWallet } from "@/server/wallets";
import { makeUser, useFreshDb } from "./helpers";

type User = Awaited<ReturnType<typeof makeUser>>;

let db: DB;
let alice: User;
let bob: User;

beforeEach(async () => {
  db = await useFreshDb();
  alice = await makeUser(db, "alice@example.com");
  bob = await makeUser(db, "bob@example.com");
});

async function expectServiceError(f: () => Promise<unknown>, code: string, field?: string) {
  try {
    await f();
  } catch (err) {
    expect(isServiceError(err)).toBe(true);
    if (!isServiceError(err)) throw err;
    expect(err.code).toBe(code);
    if (field !== undefined) expect(err.field).toBe(field);
    return err;
  }
  throw new Error("expected a ServiceError");
}

const wallet = async (u: User, currency = "EUR", groupId?: number) =>
  (await createWallet(u.id, { name: `W ${currency} ${Math.random()}`, currency, initialBalanceMinor: 0, groupId })).id;
const spend = (u: User, walletId: number, category: string, amountMinor: number, date: string) =>
  createTransaction(u.id, { walletId, kind: "expense", categoryId: u.cat(category), amountMinor, date, note: null });

const TODAY = "2026-03-10";

describe("setBudget / listBudgets / removeBudget", () => {
  it("creates, replaces and removes a category budget and the overall one; lists the overall one first", async () => {
    await wallet(alice, "EUR");
    await wallet(alice, "RON");
    const food = await setBudget(alice.id, { categoryId: alice.cat("Food"), currency: "EUR", amountMinor: 30000 });
    expect(food).toEqual({ id: expect.any(Number), categoryId: alice.cat("Food"), currency: "EUR", amountMinor: 30000 });
    const overall = await setBudget(alice.id, { categoryId: null, currency: "eur", amountMinor: 200000 });
    expect(overall).toMatchObject({ categoryId: null, currency: "EUR" });
    expect((await listBudgets(alice.id)).map((b) => b.categoryId)).toEqual([null, alice.cat("Food")]);

    // Replaced in place: one row per category, the new currency and amount.
    const again = await setBudget(alice.id, { categoryId: alice.cat("Food"), currency: "RON", amountMinor: 150000 });
    expect(again.id).toBe(food.id);
    expect(await listBudgets(alice.id)).toHaveLength(2);
    expect((await listBudgets(alice.id))[1]).toMatchObject({ currency: "RON", amountMinor: 150000 });
    const overall2 = await setBudget(alice.id, { categoryId: null, currency: "EUR", amountMinor: 250000 });
    expect(overall2.id).toBe(overall.id);

    expect(await removeBudget(alice.id, alice.cat("Food"))).toBe(true);
    expect(await removeBudget(alice.id, alice.cat("Food"))).toBe(false);
    expect(await removeBudget(alice.id, null)).toBe(true);
    expect(await listBudgets(alice.id)).toEqual([]);
  });

  it("is for expense categories only, in a currency the user holds (archived wallets count), with a positive amount", async () => {
    await expectServiceError(
      () => setBudget(alice.id, { categoryId: null, currency: "EUR", amountMinor: 100 }),
      "VALIDATION",
      "currency",
    );
    const usd = await wallet(alice, "USD");
    await archiveWallet(alice.id, usd);
    expect(await setBudget(alice.id, { categoryId: null, currency: "USD", amountMinor: 100 })).toMatchObject({ currency: "USD" });
    const err = await expectServiceError(
      () => setBudget(alice.id, { categoryId: null, currency: "EUR", amountMinor: 100 }),
      "VALIDATION",
      "currency",
    );
    expect(err.message).toContain("USD");
    await expectServiceError(() => setBudget(alice.id, { categoryId: null, currency: "XXQ", amountMinor: 100 }), "VALIDATION", "currency");
    for (const amountMinor of [0, -5, 1.5, Number.NaN]) {
      await expectServiceError(() => setBudget(alice.id, { categoryId: null, currency: "USD", amountMinor }), "VALIDATION", "amount");
    }
    await expectServiceError(
      () => setBudget(alice.id, { categoryId: alice.cat("Salary"), currency: "USD", amountMinor: 100 }),
      "VALIDATION",
      "categoryId",
    );
  });

  it("treats another user's category (and budget) as missing", async () => {
    await wallet(alice, "EUR");
    await wallet(bob, "EUR");
    await setBudget(bob.id, { categoryId: bob.cat("Food"), currency: "EUR", amountMinor: 500 });
    await expectServiceError(
      () => setBudget(alice.id, { categoryId: bob.cat("Food"), currency: "EUR", amountMinor: 100 }),
      "NOT_FOUND",
      "categoryId",
    );
    await expectServiceError(() => setBudget(alice.id, { categoryId: 999999, currency: "EUR", amountMinor: 100 }), "NOT_FOUND");
    expect(await removeBudget(alice.id, bob.cat("Food"))).toBe(false);
    expect(await removeBudget(alice.id, 0)).toBe(false);
    expect(await listBudgets(alice.id)).toEqual([]);
    expect(await listBudgets(bob.id)).toHaveLength(1);
    // Alice's overall budget does not touch Bob's.
    await setBudget(alice.id, { categoryId: null, currency: "EUR", amountMinor: 100 });
    expect(await removeBudget(bob.id, null)).toBe(false);
    expect(await listBudgets(alice.id)).toHaveLength(1);
  });
});

describe("a category's life and its budget", () => {
  beforeEach(async () => {
    await wallet(alice, "EUR");
  });

  it("removing the category removes its budget (the FK cascades), also when its entries move", async () => {
    const coffee = await createCategory(alice.id, { name: "Coffee", kind: "expense" });
    await setBudget(alice.id, { categoryId: coffee.id, currency: "EUR", amountMinor: 1000 });
    await setBudget(alice.id, { categoryId: alice.cat("Food"), currency: "EUR", amountMinor: 1000 });
    const w = await wallet(alice, "EUR");
    await spend(alice, w, "Food", 300, "2026-03-02");
    await deleteCategory(alice.id, coffee.id);
    await deleteCategory(alice.id, alice.cat("Food"), { moveToCategoryId: alice.cat("Groceries") });
    expect(await listBudgets(alice.id)).toEqual([]);
  });

  it("archiving keeps the budget and its progress; it can still be changed", async () => {
    const w = await wallet(alice, "EUR");
    await spend(alice, w, "Food", 300, "2026-03-02");
    await setBudget(alice.id, { categoryId: alice.cat("Food"), currency: "EUR", amountMinor: 1000 });
    await archiveCategory(alice.id, alice.cat("Food"));
    const month = await getMonthBudgets(alice.id, { month: "2026-03", today: TODAY });
    expect(month.budgets).toEqual([
      expect.objectContaining({ categoryId: alice.cat("Food"), spentMinor: 300, category: { name: "Food", archived: true, color: null } }),
    ]);
    expect(await setBudget(alice.id, { categoryId: alice.cat("Food"), currency: "EUR", amountMinor: 2000 })).toMatchObject({ amountMinor: 2000 });
    await unarchiveCategory(alice.id, alice.cat("Food"));
    expect(await listBudgets(alice.id)).toHaveLength(1);
  });

  it("switching an expense category to income removes its budget, in the same transaction", async () => {
    const coffee = await createCategory(alice.id, { name: "Coffee", kind: "expense" });
    await setBudget(alice.id, { categoryId: coffee.id, currency: "EUR", amountMinor: 1000 });
    expect(await changeCategoryKind(alice.id, coffee.id, { kind: "income" })).toMatchObject({ kind: "income", budgetRemoved: true });
    expect(await listBudgets(alice.id)).toEqual([]);
    // Back to expense: nothing to remove, and no budget comes back.
    expect(await changeCategoryKind(alice.id, coffee.id, { kind: "expense" })).toMatchObject({ budgetRemoved: false });
    expect(await listBudgets(alice.id)).toEqual([]);
  });

  it("a refused kind change keeps the budget", async () => {
    const w = await wallet(alice, "EUR");
    await spend(alice, w, "Food", 300, "2026-03-02");
    await setBudget(alice.id, { categoryId: alice.cat("Food"), currency: "EUR", amountMinor: 1000 });
    await expectServiceError(() => changeCategoryKind(alice.id, alice.cat("Food"), { kind: "income" }), "CONFLICT", "kind");
    expect(await listBudgets(alice.id)).toHaveLength(1);
  });
});

describe("getMonthBudgets", () => {
  // Synthetic rates per 1 EUR (as tests/insights.test.ts): RON 5 all month; USD 2 until Friday 6 March, 4 from Monday 9.
  const rates: DailyRates = {
    base: "EUR",
    days: [
      { date: "2026-02-27", rates: { USD: 2, RON: 5 } },
      { date: "2026-03-06", rates: { USD: 2, RON: 5 } },
      { date: "2026-03-09", rates: { USD: 4, RON: 5 } },
    ],
  };

  it("sums the month's expenses in the budget's currency over every wallet, each day at its rate; transfers and income never count", async () => {
    const eur = await wallet(alice, "EUR");
    const usd = await wallet(alice, "USD");
    const ron = await wallet(alice, "RON");
    const archived = await wallet(alice, "EUR");
    await spend(alice, eur, "Food", 1000, "2026-03-02");
    await spend(alice, usd, "Food", 1000, "2026-03-07"); // Saturday: Friday's 2 → 500
    await spend(alice, usd, "Food", 1000, "2026-03-09"); // Monday: 4 → 250
    await spend(alice, ron, "Groceries", 5000, "2026-03-03"); // → 1000
    await spend(alice, archived, "Groceries", 200, "2026-03-04");
    await archiveWallet(alice.id, archived);
    await spend(alice, eur, "Food", 9999, "2026-02-28"); // last month
    await spend(alice, eur, "Food", 9999, "2026-04-01"); // next month
    await createTransaction(alice.id, { walletId: eur, kind: "income", categoryId: alice.cat("Salary"), amountMinor: 50000, date: "2026-03-01", note: null });
    await createTransfer(alice.id, { fromWalletId: eur, toWalletId: usd, amountMinor: 7000, receivedAmountMinor: 14000, date: "2026-03-05" });

    await setBudget(alice.id, { categoryId: alice.cat("Food"), currency: "EUR", amountMinor: 1500 });
    await setBudget(alice.id, { categoryId: null, currency: "EUR", amountMinor: 3000 });
    await setBudget(alice.id, { categoryId: alice.cat("Groceries"), currency: "RON", amountMinor: 5000 });

    const month = await getMonthBudgets(alice.id, { month: "2026-03", today: TODAY, convert: { rates } });
    expect(month.elapsed).toEqual({ day: 10, days: 31 });
    const [overall, food, groceries] = month.budgets;
    expect(overall).toMatchObject({ categoryId: null, category: null, spentMinor: 1000 + 500 + 250 + 1000 + 200, missingCurrencies: [] });
    expect(overall.remainingMinor).toBe(3000 - 2950);
    expect(food).toMatchObject({ categoryId: alice.cat("Food"), spentMinor: 1750, remainingMinor: -250, category: { name: "Food" } });
    // In RON: 5000 RON as they are, 200 EUR cents → 1000 bani.
    expect(groceries).toMatchObject({ currency: "RON", spentMinor: 6000, remainingMinor: -1000 });
  });

  it("leaves out and names a currency without a rate (no conversion at all: every other currency)", async () => {
    const eur = await wallet(alice, "EUR");
    const jpy = await wallet(alice, "JPY");
    const usd = await wallet(alice, "USD");
    await spend(alice, eur, "Food", 1000, "2026-03-02");
    await spend(alice, jpy, "Food", 500, "2026-03-02");
    await spend(alice, usd, "Transport", 400, "2026-03-02");
    await setBudget(alice.id, { categoryId: null, currency: "EUR", amountMinor: 3000 });
    await setBudget(alice.id, { categoryId: alice.cat("Food"), currency: "EUR", amountMinor: 3000 });
    await setBudget(alice.id, { categoryId: alice.cat("Transport"), currency: "EUR", amountMinor: 3000 });

    const withRates = await getMonthBudgets(alice.id, { month: "2026-03", today: TODAY, convert: { rates } });
    expect(withRates.budgets.map((b) => [b.spentMinor, b.missingCurrencies])).toEqual([
      [1000 + 200, ["JPY"]],
      [1000, ["JPY"]],
      [200, []],
    ]);
    // A manual rate fills the gap (1 JPY = 0.01 EUR from the 1st).
    const manual = await getMonthBudgets(alice.id, {
      month: "2026-03",
      today: TODAY,
      convert: { rates, manual: [{ currency: "JPY", base: "EUR", effectiveDate: "2026-03-01", rate: 0.01 }] },
    });
    expect(manual.budgets[1]).toMatchObject({ spentMinor: 1000 + 500, missingCurrencies: [] });

    const none = await getMonthBudgets(alice.id, { month: "2026-03", today: TODAY });
    expect(none.budgets.map((b) => [b.spentMinor, b.missingCurrencies])).toEqual([
      [1000, ["JPY", "USD"]],
      [1000, ["JPY"]],
      [0, ["USD"]],
    ]);
  });

  it("counts every wallet group (budgets are account-wide)", async () => {
    const business = await createWalletGroup(alice.id, { name: "Business" });
    const personal = await wallet(alice, "EUR");
    const work = await wallet(alice, "EUR", business.id);
    await spend(alice, personal, "Food", 100, "2026-03-02");
    await spend(alice, work, "Food", 200, "2026-03-03");
    await setBudget(alice.id, { categoryId: alice.cat("Food"), currency: "EUR", amountMinor: 1000 });
    const month = await getMonthBudgets(alice.id, { month: "2026-03", today: TODAY });
    expect(month.budgets[0].spentMinor).toBe(300);
  });

  it("orders the category budgets like the categories, says how far through the current month today is, and never shows another user's", async () => {
    await wallet(alice, "EUR");
    await wallet(bob, "EUR");
    await setBudget(alice.id, { categoryId: alice.cat("Transport"), currency: "EUR", amountMinor: 100 });
    await setBudget(alice.id, { categoryId: alice.cat("Bills"), currency: "EUR", amountMinor: 100 });
    await setBudget(alice.id, { categoryId: null, currency: "EUR", amountMinor: 100 });
    await setBudget(bob.id, { categoryId: bob.cat("Food"), currency: "EUR", amountMinor: 100 });
    const current = await getMonthBudgets(alice.id, { month: "2026-03", today: TODAY });
    expect(current.budgets.map((b) => b.category?.name ?? "overall")).toEqual(["overall", "Bills", "Transport"]);
    expect((await getMonthBudgets(alice.id, { month: "2026-02", today: TODAY })).elapsed).toBeNull();
    expect((await getMonthBudgets(alice.id, { month: "2026-02", today: "2026-02-28" })).elapsed).toEqual({ day: 28, days: 28 });
    expect(await getMonthBudgets(bob.id, { month: "2026-03", today: TODAY })).toMatchObject({
      budgets: [expect.objectContaining({ categoryId: bob.cat("Food") })],
    });
    expect((await getMonthBudgets(alice.id, { month: "2026-03", today: TODAY })).budgets).toHaveLength(3);
  });

  it("returns no budgets for an account without any, and rejects a bad month or today", async () => {
    expect(await getMonthBudgets(alice.id, { month: "2026-03", today: TODAY })).toEqual({
      month: "2026-03",
      budgets: [],
      elapsed: { day: 10, days: 31 },
    });
    await expectServiceError(() => getMonthBudgets(alice.id, { month: "2026-13", today: TODAY }), "VALIDATION", "month");
    await expectServiceError(() => getMonthBudgets(alice.id, { month: "2026-03", today: "soon" }), "VALIDATION", "today");
  });
});

describe("display helpers (src/lib/budgets.ts)", () => {
  const b = (spentMinor: number, amountMinor = 30000, categoryId: number | null = 1) => ({
    categoryId,
    currency: "EUR",
    amountMinor,
    spentMinor,
    remainingMinor: amountMinor - spentMinor,
  });

  it("writes the lines: spent of the limit, left or over, the share and the day of the month", () => {
    expect(spentOfLine(b(12000))).toBe("€120.00 of €300.00");
    expect(leftLine(b(12000))).toBe("€180.00 left");
    expect(leftLine(b(30000))).toBe("Limit reached");
    expect(leftLine(b(32000))).toBe("€20.00 over");
    expect(paceLine(b(18000), { day: 10, days: 30 })).toBe("60% spent · day 10 of 30");
    expect(paceLine(b(18000), null)).toBe("60% spent");
    expect(budgetPercent(b(29999))).toBe(99);
    expect(missingLine([])).toBe("");
    expect(missingLine(["RON"])).toBe("RON not counted: no exchange rate");
    expect(missingLine(["JPY", "RON", "USD"])).toBe("JPY, RON and USD not counted: no exchange rates");
  });

  it("caps the bar's fill and places the pace tick", () => {
    expect(budgetBar(b(15000), { day: 10, days: 30 })).toEqual({ fill: 0.5, pace: 1 / 3 });
    expect(budgetBar(b(60000), null)).toEqual({ fill: 1, pace: null });
  });

  it("picks the category budgets closest to or over their limit, leaving out the overall one", () => {
    const list = [b(99999, 100, null), b(100, 1000, 1), b(900, 1000, 2), b(2000, 1000, 3), b(900, 1000, 4), b(0, 1000, 5)];
    expect(closestToLimit(list).map((x) => x.categoryId)).toEqual([3, 2, 4]);
    expect(closestToLimit(list, 1).map((x) => x.categoryId)).toEqual([3]);
  });
});
