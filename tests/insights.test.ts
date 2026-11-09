import { beforeEach, describe, expect, it } from "vitest";
import type { DB } from "@/db";
import { addDays, currentMonth, monthRange, shiftMonth, todayISO } from "@/lib/dates";
import { ServiceError } from "@/lib/errors";
import type { DailyRates } from "@/lib/fx";
import {
  getMonthInsights,
  getMonthTimeline,
  getWalletMonth,
  listUserCurrencies,
  monthDayN,
  pickDefaultCurrency,
} from "@/server/insights";
import { createTransaction } from "@/server/transactions";
import { createTransfer } from "@/server/transfers";
import { archiveWallet, createWallet } from "@/server/wallets";
import { makeUser, useFreshDb } from "./helpers";

let db: DB;
let alice: Awaited<ReturnType<typeof makeUser>>;
let bob: Awaited<ReturnType<typeof makeUser>>;

beforeEach(async () => {
  db = await useFreshDb();
  alice = await makeUser(db, "alice@example.com");
  bob = await makeUser(db, "bob@example.com");
});

async function expectServiceError(fn: () => unknown, code: ServiceError["code"], field?: string): Promise<void> {
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

type User = Awaited<ReturnType<typeof makeUser>>;
const wallet = async (u: User, currency = "EUR", name = `${currency} wallet`, initialBalanceMinor = 0) =>
  (await createWallet(u.id, { name, currency, initialBalanceMinor })).id;
const spend = async (u: User, walletId: number, amountMinor: number, date: string, category = "Food", note?: string) =>
  createTransaction(u.id, { walletId, kind: "expense", categoryId: u.cat(category), amountMinor, date, note });
const earn = async (u: User, walletId: number, amountMinor: number, date: string, category = "Salary") =>
  createTransaction(u.id, { walletId, kind: "income", categoryId: u.cat(category), amountMinor, date });
const move = async (u: User, fromWalletId: number, toWalletId: number, amountMinor: number, date: string, received?: number) =>
  createTransfer(u.id, { fromWalletId, toWalletId, amountMinor, receivedAmountMinor: received, date });

const expensesByDay = (days: { date: string; expenseMinor: number }[]) =>
  Object.fromEntries(days.filter((d) => d.expenseMinor !== 0).map((d) => [d.date, d.expenseMinor]));

// 2026-03 has 31 days, 2026-02 has 28, 2026-04 has 30, 2026-05 has 31. All are in the past relative to the
// test run (the suite was written in November 2026), so day N is the month's last day.

describe("monthDayN", () => {
  it("is today's day for the current month, the last day for a past month and 0 for a future one", async () => {
    expect(monthDayN("2026-11", "2026-11-08")).toBe(8);
    expect(monthDayN("2026-10", "2026-11-08")).toBe(31);
    expect(monthDayN("2026-02", "2026-11-08")).toBe(28);
    expect(monthDayN("2026-12", "2026-11-08")).toBe(0);
    expect(monthDayN(currentMonth())).toBe(Number(todayISO().slice(8)));
  });
});

describe("listUserCurrencies", () => {
  it("lists the currencies of active wallets by code, without archived-only currencies or other users'", async () => {
    await wallet(alice, "USD");
    await wallet(alice, "EUR", "Cash");
    await wallet(alice, "EUR", "Bank");
    await archiveWallet(alice.id, await wallet(alice, "GBP"));
    await wallet(bob, "JPY");
    expect(await listUserCurrencies(alice.id)).toEqual(["EUR", "USD"]);
    expect(await listUserCurrencies(bob.id)).toEqual(["JPY"]);
    expect(await listUserCurrencies((await makeUser(db, "carol@example.com")).id)).toEqual([]);
  });
});

describe("pickDefaultCurrency", () => {
  it("returns null without wallets and validates the month", async () => {
    expect(await pickDefaultCurrency(alice.id, "2026-03")).toBeNull();
    await expectServiceError(async () => await pickDefaultCurrency(alice.id, "2026-13"), "VALIDATION", "month");
    await expectServiceError(async () => await pickDefaultCurrency(alice.id, "March"), "VALIDATION", "month");
  });

  it("picks the currency with the most expense + income entries in the month", async () => {
    const eur = await wallet(alice, "EUR");
    const usd = await wallet(alice, "USD");
    // EUR is busier overall, USD is busier in March.
    for (let i = 0; i < 5; i++) await spend(alice, eur, 100, "2026-01-10");
    await spend(alice, usd, 100, "2026-03-02");
    await earn(alice, usd, 100, "2026-03-03");
    await spend(alice, eur, 100, "2026-03-04");
    // Transfers do not count: three EUR-side transfer legs would otherwise win.
    const eur2 = await wallet(alice, "EUR", "Savings");
    await move(alice, eur, eur2, 10, "2026-03-05");
    await move(alice, eur, eur2, 10, "2026-03-06");
    expect(await pickDefaultCurrency(alice.id, "2026-03")).toBe("USD");
  });

  it("falls back to the active wallet with the most transactions on a tie or an empty month", async () => {
    const eur = await wallet(alice, "EUR");
    const usd = await wallet(alice, "USD");
    await spend(alice, usd, 100, "2026-03-02");
    await spend(alice, eur, 100, "2026-03-02");
    await spend(alice, usd, 100, "2026-01-02");
    expect(await pickDefaultCurrency(alice.id, "2026-03")).toBe("USD"); // tie 1–1; USD wallet has 2 entries overall
    expect(await pickDefaultCurrency(alice.id, "2026-07")).toBe("USD"); // nothing in July
    await spend(alice, eur, 100, "2026-01-03");
    await spend(alice, eur, 100, "2026-01-04");
    expect(await pickDefaultCurrency(alice.id, "2026-03")).toBe("EUR"); // still a tie; EUR wallet now has 3
  });

  it("breaks a fallback tie by currency code and ignores archived wallets there", async () => {
    await wallet(alice, "USD");
    await wallet(alice, "GBP");
    const chf = await wallet(alice, "CHF");
    await spend(alice, chf, 100, "2026-01-02");
    await archiveWallet(alice.id, chf);
    expect(await pickDefaultCurrency(alice.id, "2026-03")).toBe("GBP");
  });

  it("counts archived wallets for the busiest currency, and is null with no active wallets and no entries", async () => {
    const usd = await wallet(alice, "USD");
    await wallet(alice, "EUR");
    await spend(alice, usd, 100, "2026-03-02");
    await archiveWallet(alice.id, usd);
    expect(await pickDefaultCurrency(alice.id, "2026-03")).toBe("USD");

    const gbp = await wallet(bob, "GBP");
    await archiveWallet(bob.id, gbp);
    expect(await pickDefaultCurrency(bob.id, "2026-03")).toBeNull();
  });

  it("does not see another user's entries", async () => {
    await wallet(alice, "EUR");
    const bobUsd = await wallet(bob, "USD");
    await spend(bob, bobUsd, 100, "2026-03-02");
    expect(await pickDefaultCurrency(alice.id, "2026-03")).toBe("EUR");
  });
});

describe("getMonthTimeline", () => {
  it("has one entry per calendar day plus the previous month's running total", async () => {
    const w = await wallet(alice);
    await spend(alice, w, 300, "2026-03-01");
    await spend(alice, w, 200, "2026-03-01");
    await earn(alice, w, 5000, "2026-03-05");
    await spend(alice, w, 50, "2026-03-31");
    await spend(alice, w, 70, "2026-02-01");
    await spend(alice, w, 30, "2026-02-28");

    const t = await getMonthTimeline(alice.id, { month: "2026-03", currency: "EUR" });
    expect(t.days).toHaveLength(31);
    expect(t.days[0]).toEqual({ date: "2026-03-01", expenseMinor: 500, incomeMinor: 0 });
    expect(t.days[1]).toEqual({ date: "2026-03-02", expenseMinor: 0, incomeMinor: 0 });
    expect(t.days[4]).toEqual({ date: "2026-03-05", expenseMinor: 0, incomeMinor: 5000 });
    expect(t.days[30]).toEqual({ date: "2026-03-31", expenseMinor: 50, incomeMinor: 0 });
    expect(t.previousCumulativeMinor).toHaveLength(28);
    expect(t.previousCumulativeMinor[0]).toBe(70);
    expect(t.previousCumulativeMinor[26]).toBe(70);
    expect(t.previousCumulativeMinor[27]).toBe(100);
  });

  it("keeps the month boundary: the last day of the previous month is not the 1st", async () => {
    const w = await wallet(alice);
    await spend(alice, w, 111, "2026-04-30");
    await spend(alice, w, 222, "2026-05-01");
    const may = await getMonthTimeline(alice.id, { month: "2026-05", currency: "EUR" });
    expect(expensesByDay(may.days)).toEqual({ "2026-05-01": 222 });
    expect(may.previousCumulativeMinor).toHaveLength(30);
    expect(may.previousCumulativeMinor.at(-1)).toBe(111);
    const april = await getMonthTimeline(alice.id, { month: "2026-04", currency: "EUR" });
    expect(expensesByDay(april.days)).toEqual({ "2026-04-30": 111 });
    expect(april.days).toHaveLength(30);
    expect(april.previousCumulativeMinor).toHaveLength(31);
  });

  it("names the largest day by its largest entry's note, else its category", async () => {
    const w = await wallet(alice);
    await spend(alice, w, 400, "2026-03-03", "Food", "Lunch");
    await spend(alice, w, 115000, "2026-03-10", "Housing", "Rent");
    await spend(alice, w, 500, "2026-03-10", "Food", "Snacks");
    expect((await getMonthTimeline(alice.id, { month: "2026-03", currency: "EUR" })).largestDay).toEqual({
      date: "2026-03-10",
      amountMinor: 115500,
      label: "Rent",
    });

    const w2 = await wallet(bob);
    await spend(bob, w2, 900, "2026-03-12", "Bills");
    await spend(bob, w2, 100, "2026-03-12", "Food", "Coffee");
    expect((await getMonthTimeline(bob.id, { month: "2026-03", currency: "EUR" })).largestDay).toEqual({
      date: "2026-03-12",
      amountMinor: 1000,
      label: "Bills",
    });
  });

  it("keeps currencies apart on the same days", async () => {
    const eur = await wallet(alice, "EUR");
    const usd = await wallet(alice, "USD");
    await spend(alice, eur, 100, "2026-03-02");
    await spend(alice, usd, 7000, "2026-03-02");
    await earn(alice, usd, 9000, "2026-03-02");
    const e = await getMonthTimeline(alice.id, { month: "2026-03", currency: "EUR" });
    const u = await getMonthTimeline(alice.id, { month: "2026-03", currency: "USD" });
    expect(e.days[1]).toEqual({ date: "2026-03-02", expenseMinor: 100, incomeMinor: 0 });
    expect(u.days[1]).toEqual({ date: "2026-03-02", expenseMinor: 7000, incomeMinor: 9000 });
    expect(e.largestDay?.amountMinor).toBe(100);
    expect((await getMonthTimeline(alice.id, { month: "2026-03", currency: "GBP" })).largestDay).toBeNull();
  });

  it("includes archived wallets, excludes transfers, and narrows by wallet or category", async () => {
    const cash = await wallet(alice, "EUR", "Cash");
    const old = await wallet(alice, "EUR", "Old");
    const usd = await wallet(alice, "USD");
    await spend(alice, cash, 100, "2026-03-02", "Food");
    await spend(alice, old, 40, "2026-03-02", "Bills");
    await move(alice, cash, old, 1000, "2026-03-03");
    await move(alice, usd, cash, 500, "2026-03-04", 450);
    await archiveWallet(alice.id, old);

    const all = await getMonthTimeline(alice.id, { month: "2026-03", currency: "EUR" });
    expect(expensesByDay(all.days)).toEqual({ "2026-03-02": 140 });
    expect(all.days.every((d) => d.incomeMinor === 0)).toBe(true);
    const oneWallet = await getMonthTimeline(alice.id, { month: "2026-03", currency: "EUR", walletId: old });
    expect(expensesByDay(oneWallet.days)).toEqual({ "2026-03-02": 40 });
    expect(oneWallet.largestDay?.label).toBe("Bills");
    const oneCategory = await getMonthTimeline(alice.id, { month: "2026-03", currency: "EUR", categoryId: alice.cat("Food") });
    expect(expensesByDay(oneCategory.days)).toEqual({ "2026-03-02": 100 });
  });

  it("returns zeros for an empty month and does not see another user's data", async () => {
    const w = await wallet(bob);
    await spend(bob, w, 100, "2026-03-02");
    await wallet(alice);
    const t = await getMonthTimeline(alice.id, { month: "2026-03", currency: "EUR" });
    expect(t.days).toHaveLength(31);
    expect(t.days.every((d) => d.expenseMinor === 0 && d.incomeMinor === 0)).toBe(true);
    expect(t.previousCumulativeMinor).toEqual(Array(28).fill(0));
    expect(t.largestDay).toBeNull();
    // Narrowing to another user's wallet behaves like a wallet with no entries.
    expect(expensesByDay((await getMonthTimeline(alice.id, { month: "2026-03", currency: "EUR", walletId: w })).days)).toEqual({});
  });

  it("rejects an invalid month or currency", async () => {
    await expectServiceError(async () => await getMonthTimeline(alice.id, { month: "2026-3", currency: "EUR" }), "VALIDATION", "month");
    await expectServiceError(async () => await getMonthTimeline(alice.id, { month: "2026-03", currency: "" }), "VALIDATION", "currency");
    await expectServiceError(async () => await getMonthTimeline(alice.id, { month: "2026-03", currency: "eur" }), "VALIDATION", "currency");
    await expectServiceError(async () => await getMonthTimeline(alice.id, { month: "2026-03", currency: "XYZ" }), "VALIDATION", "currency");
    await expectServiceError(
      async () => await getMonthTimeline(alice.id, { month: "2026-03", currency: "EUR", walletId: 0 }),
      "VALIDATION",
      "walletId",
    );
  });
});

describe("getMonthInsights", () => {
  it("computes net, top category, pace and no-spend days for a past month", async () => {
    const w = await wallet(alice);
    await earn(alice, w, 10000, "2026-03-01");
    await spend(alice, w, 3000, "2026-03-02", "Housing");
    await spend(alice, w, 1000, "2026-03-02", "Food");
    await spend(alice, w, 1500, "2026-03-20", "Food");
    await spend(alice, w, 500, "2026-03-31", "Bills");
    await spend(alice, w, 800, "2026-02-10", "Food");
    await spend(alice, w, 200, "2026-02-28", "Food");

    const i = await getMonthInsights(alice.id, { month: "2026-03", currency: "EUR" });
    expect(i.incomeMinor).toBe(10000);
    expect(i.expenseMinor).toBe(6000);
    expect(i.netMinor).toBe(4000);
    expect(i.topCategory).toEqual({
      categoryId: alice.cat("Housing"),
      categoryName: "Housing",
      amountMinor: 3000,
      sharePercent: 50,
    });
    expect(i.pace).toEqual({ day: 31, thisMonthMinor: 6000, previousMonthMinor: 1000 });
    expect(i.noSpendDays).toEqual({ days: 28, outOf: 31, previousDays: 26, previousOutOf: 28 });
  });

  it("clamps the previous month's pace to its length (31-day month after a 30-day one and vice-versa)", async () => {
    const w = await wallet(alice);
    await spend(alice, w, 100, "2026-03-30");
    await spend(alice, w, 900, "2026-03-31"); // after day 30: outside April's pace comparison
    await spend(alice, w, 50, "2026-04-15");
    await spend(alice, w, 7, "2026-05-31");

    const april = await getMonthInsights(alice.id, { month: "2026-04", currency: "EUR" });
    expect(april.pace).toEqual({ day: 30, thisMonthMinor: 50, previousMonthMinor: 100 });
    expect(april.noSpendDays).toEqual({ days: 29, outOf: 30, previousDays: 29, previousOutOf: 31 });

    const may = await getMonthInsights(alice.id, { month: "2026-05", currency: "EUR" });
    expect(may.pace).toEqual({ day: 31, thisMonthMinor: 7, previousMonthMinor: 50 });
    expect(may.noSpendDays).toEqual({ days: 30, outOf: 31, previousDays: 29, previousOutOf: 30 });
  });

  it("uses today as day N for the current month", async () => {
    const today = todayISO();
    const month = currentMonth();
    const n = Number(today.slice(8));
    const { to } = monthRange(month);
    const w = await wallet(alice);
    await spend(alice, w, 500, today);
    if (n > 1) await spend(alice, w, 100, `${month}-01`);
    if (today !== to) await spend(alice, w, 9999, addDays(today, 1)); // future-dated: in the total, not in the pace
    const previous = shiftMonth(month, -1);
    const prevLength = Number(monthRange(previous).to.slice(8));
    await spend(alice, w, 40, `${previous}-01`);
    await spend(alice, w, 60, monthRange(previous).to);

    const i = await getMonthInsights(alice.id, { month, currency: "EUR" });
    const spentToday = 500 + (n > 1 ? 100 : 0);
    expect(i.expenseMinor).toBe(spentToday + (today !== to ? 9999 : 0));
    expect(i.pace).toEqual({
      day: n,
      thisMonthMinor: spentToday,
      previousMonthMinor: 40 + (Math.min(n, prevLength) === prevLength ? 60 : 0),
    });
    expect(i.noSpendDays).toEqual({
      days: n - (n > 1 ? 2 : 1),
      outOf: n,
      previousDays: prevLength - 2,
      previousOutOf: prevLength,
    });
  });

  it("returns zeros and nulls for an empty or future month", async () => {
    await wallet(alice);
    const empty = await getMonthInsights(alice.id, { month: "2026-03", currency: "EUR" });
    expect(empty).toEqual({
      incomeMinor: 0,
      expenseMinor: 0,
      netMinor: 0,
      topCategory: null,
      pace: { day: 31, thisMonthMinor: 0, previousMonthMinor: 0 },
      noSpendDays: { days: 31, outOf: 31, previousDays: 28, previousOutOf: 28 },
    });
    const future = await getMonthInsights(alice.id, { month: shiftMonth(currentMonth(), 2), currency: "EUR" });
    expect(future.pace).toEqual({ day: 0, thisMonthMinor: 0, previousMonthMinor: 0 });
    expect(future.noSpendDays.days).toBe(0);
    expect(future.noSpendDays.outOf).toBe(0);
  });

  it("keeps currencies apart, includes archived wallets, excludes transfers and other users", async () => {
    const eur = await wallet(alice, "EUR");
    const old = await wallet(alice, "EUR", "Old");
    const usd = await wallet(alice, "USD");
    await spend(alice, eur, 100, "2026-03-02", "Food");
    await spend(alice, old, 300, "2026-03-03", "Bills");
    await spend(alice, usd, 5000, "2026-03-02", "Housing");
    await earn(alice, usd, 7000, "2026-03-02");
    await move(alice, eur, usd, 1000, "2026-03-04", 1100);
    await move(alice, eur, old, 50, "2026-03-05");
    await archiveWallet(alice.id, old);
    await spend(bob, await wallet(bob, "EUR"), 999999, "2026-03-02");

    const e = await getMonthInsights(alice.id, { month: "2026-03", currency: "EUR" });
    expect([e.incomeMinor, e.expenseMinor, e.netMinor]).toEqual([0, 400, -400]);
    expect(e.topCategory).toMatchObject({ categoryName: "Bills", amountMinor: 300, sharePercent: 75 });
    expect(e.noSpendDays.days).toBe(29);
    const u = await getMonthInsights(alice.id, { month: "2026-03", currency: "USD" });
    expect([u.incomeMinor, u.expenseMinor, u.netMinor]).toEqual([7000, 5000, 2000]);
    expect(u.topCategory).toMatchObject({ categoryName: "Housing", sharePercent: 100 });
  });

  it("rejects an invalid month or currency", async () => {
    await expectServiceError(async () => await getMonthInsights(alice.id, { month: "", currency: "EUR" }), "VALIDATION", "month");
    await expectServiceError(async () => await getMonthInsights(alice.id, { month: "2026-03", currency: "EURO" }), "VALIDATION", "currency");
  });
});

describe("getWalletMonth", () => {
  it("returns the opening balance, money in / out with transfers, and the balance after each day", async () => {
    const cash = await wallet(alice, "EUR", "Cash", 1000);
    const savings = await wallet(alice, "EUR", "Savings");
    const usd = await wallet(alice, "USD");
    await spend(alice, cash, 100, "2026-02-28");
    await earn(alice, cash, 500, "2026-03-01");
    await spend(alice, cash, 50, "2026-03-01");
    await move(alice, cash, savings, 200, "2026-03-15");
    await move(alice, usd, cash, 100, "2026-03-20", 90);
    await spend(alice, cash, 10, "2026-04-01");

    const m = (await getWalletMonth(alice.id, cash, "2026-03"))!;
    expect(m.openingMinor).toBe(900);
    expect(m.inMinor).toBe(590);
    expect(m.outMinor).toBe(250);
    expect(m.entryCount).toBe(4);
    expect(m.totalEntryCount).toBe(6);
    expect(m.days).toHaveLength(31);
    expect(m.days[0]).toEqual({ date: "2026-03-01", inMinor: 500, outMinor: 50, closingMinor: 1350 });
    expect(m.days[1]).toEqual({ date: "2026-03-02", inMinor: 0, outMinor: 0, closingMinor: 1350 });
    expect(m.days[14]).toEqual({ date: "2026-03-15", inMinor: 0, outMinor: 200, closingMinor: 1150 });
    expect(m.days[19]).toEqual({ date: "2026-03-20", inMinor: 90, outMinor: 0, closingMinor: 1240 });
    expect(m.days[30].closingMinor).toBe(1240);

    // The other legs land on their own wallets, in their own currency's amounts.
    const u = (await getWalletMonth(alice.id, usd, "2026-03"))!;
    expect([u.openingMinor, u.inMinor, u.outMinor, u.entryCount]).toEqual([0, 0, 100, 1]);
    expect(u.days[19]).toEqual({ date: "2026-03-20", inMinor: 0, outMinor: 100, closingMinor: -100 });
    expect((await getWalletMonth(alice.id, savings, "2026-03"))!.inMinor).toBe(200);

    // April opens where March closed.
    expect((await getWalletMonth(alice.id, cash, "2026-04"))!.openingMinor).toBe(1240);
  });

  it("works for an archived wallet and gives an empty month its opening balance throughout", async () => {
    const w = await wallet(alice, "EUR", "Old", -500);
    await spend(alice, w, 100, "2026-01-05");
    await archiveWallet(alice.id, w);
    const m = (await getWalletMonth(alice.id, w, "2026-02"))!;
    expect(m).toMatchObject({ openingMinor: -600, inMinor: 0, outMinor: 0, entryCount: 0, totalEntryCount: 1 });
    expect(m.days).toHaveLength(28);
    expect(m.days.every((d) => d.closingMinor === -600 && d.inMinor === 0 && d.outMinor === 0)).toBe(true);
  });

  it("runs days 1..today for the current month and has no days for a future month", async () => {
    const w = await wallet(alice, "EUR", "Cash", 100);
    const today = todayISO();
    await spend(alice, w, 30, today);
    const m = (await getWalletMonth(alice.id, w, currentMonth()))!;
    expect(m.days).toHaveLength(Number(today.slice(8)));
    expect(m.days.at(-1)).toEqual({ date: today, inMinor: 0, outMinor: 30, closingMinor: 70 });
    const future = (await getWalletMonth(alice.id, w, shiftMonth(currentMonth(), 2)))!;
    expect(future.days).toEqual([]);
    expect(future.openingMinor).toBe(70);
  });

  it("returns null for another user's or a missing wallet and rejects an invalid month", async () => {
    const bobs = await wallet(bob);
    expect(await getWalletMonth(alice.id, bobs, "2026-03")).toBeNull();
    expect(await getWalletMonth(alice.id, 999999, "2026-03")).toBeNull();
    await expectServiceError(async () => await getWalletMonth(bob.id, bobs, "2026-00"), "VALIDATION", "month");
  });
});

describe("convert (Overview 'All in <currency>')", () => {
  // Synthetic rates per 1 EUR. Friday 6 March has USD 2; Monday 9 March has USD 4; no row for the weekend.
  const rates: DailyRates = {
    base: "EUR",
    days: [
      { date: "2026-02-27", rates: { USD: 2, RON: 5 } },
      { date: "2026-03-06", rates: { USD: 2, RON: 5 } },
      { date: "2026-03-09", rates: { USD: 4, RON: 5 } },
    ],
  };

  it("converts each day at that day's rate (a weekend uses the Friday before)", async () => {
    const eur = await wallet(alice, "EUR");
    const usd = await wallet(alice, "USD");
    await spend(alice, eur, 100, "2026-03-07");
    await spend(alice, usd, 1000, "2026-03-07"); // Saturday: Friday's 2 → 500
    await spend(alice, usd, 1000, "2026-03-09"); // Monday: 4 → 250
    await earn(alice, usd, 2000, "2026-03-09"); // → 500
    await spend(alice, usd, 400, "2026-02-27"); // previous month → 200
    const t = await getMonthTimeline(alice.id, { month: "2026-03", currency: "EUR", convert: { rates } });
    expect(expensesByDay(t.days)).toEqual({ "2026-03-07": 600, "2026-03-09": 250 });
    expect(t.days[8].incomeMinor).toBe(500);
    expect(t.previousCumulativeMinor.at(-1)).toBe(200);
    expect(t.largestDay).toMatchObject({ date: "2026-03-07", amountMinor: 600 });
    expect(t.missingCurrencies).toEqual([]);

    const i = await getMonthInsights(alice.id, { month: "2026-03", currency: "EUR", convert: { rates } });
    expect([i.incomeMinor, i.expenseMinor, i.netMinor]).toEqual([500, 850, -350]);
    // Without convert, nothing changes.
    expect((await getMonthInsights(alice.id, { month: "2026-03", currency: "EUR" })).expenseMinor).toBe(100);
    expect((await getMonthInsights(alice.id, { month: "2026-03", currency: "EUR" })).missingCurrencies).toBeUndefined();
  });

  it("labels the largest day with the largest entry after conversion", async () => {
    const eur = await wallet(alice, "EUR");
    const usd = await wallet(alice, "USD");
    await spend(alice, eur, 300, "2026-03-09", "Food", "Lunch");
    await spend(alice, usd, 1000, "2026-03-09", "Bills", "Phone"); // 250 EUR: smaller once converted
    const t = await getMonthTimeline(alice.id, { month: "2026-03", currency: "EUR", convert: { rates } });
    expect(t.largestDay).toEqual({ date: "2026-03-09", amountMinor: 550, label: "Lunch" });
  });

  it("picks the top category from converted amounts", async () => {
    const eur = await wallet(alice, "EUR");
    const usd = await wallet(alice, "USD");
    await spend(alice, eur, 300, "2026-03-09", "Food");
    await spend(alice, usd, 1000, "2026-03-06", "Bills"); // 500 EUR
    const i = await getMonthInsights(alice.id, { month: "2026-03", currency: "EUR", convert: { rates } });
    expect(i.topCategory).toMatchObject({ categoryName: "Bills", amountMinor: 500, sharePercent: 63 });
  });

  it("leaves out and lists a currency without a rate, or every other one without rates", async () => {
    const eur = await wallet(alice, "EUR");
    await spend(alice, eur, 100, "2026-03-09");
    await spend(alice, await wallet(alice, "CHF"), 5000, "2026-03-09");
    await spend(alice, await wallet(alice, "RON"), 500, "2026-03-09"); // → 100
    const t = await getMonthTimeline(alice.id, { month: "2026-03", currency: "EUR", convert: { rates } });
    expect(t.days[8].expenseMinor).toBe(200);
    expect(t.missingCurrencies).toEqual(["CHF"]);
    const none = await getMonthInsights(alice.id, { month: "2026-03", currency: "EUR", convert: { rates: null } });
    expect(none.expenseMinor).toBe(100);
    expect(none.missingCurrencies).toEqual(["CHF", "RON"]);
  });

  it("never counts another user's wallets", async () => {
    await wallet(alice, "EUR");
    await spend(bob, await wallet(bob, "USD"), 1000, "2026-03-09");
    const i = await getMonthInsights(alice.id, { month: "2026-03", currency: "EUR", convert: { rates } });
    expect(i.expenseMinor).toBe(0);
  });
});
