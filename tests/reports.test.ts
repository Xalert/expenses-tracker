// The year report (src/server/reports.ts) and its pure helpers (src/lib/reports.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DB } from "@/db";
import { addDays } from "@/lib/dates";
import { ServiceError } from "@/lib/errors";
import type { DailyRates } from "@/lib/fx";
import {
  comparisonSub,
  comparisonThrough,
  compactMoney,
  isValidYear,
  percentChange,
  periodLabel,
  reportsHref,
  resolveReportYear,
  wholeUnits,
  yearMonths,
} from "@/lib/reports";
import { archiveCategory } from "@/server/categories";
import { getConversion, resetExchangeRatesCache } from "@/server/exchange-rates";
import { pickDefaultCurrencyBetween } from "@/server/insights";
import { getYearReport } from "@/server/reports";
import { createTransaction } from "@/server/transactions";
import { createTransfer } from "@/server/transfers";
import { createWalletGroup } from "@/server/wallet-groups";
import { archiveWallet, createWallet } from "@/server/wallets";
import { makeUser, useFreshDb } from "./helpers";

let db: DB;
type User = Awaited<ReturnType<typeof makeUser>>;
let alice: User;
let bob: User;

beforeEach(async () => {
  db = await useFreshDb();
  alice = await makeUser(db, "alice@example.com");
  bob = await makeUser(db, "bob@example.com");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const wallet = async (u: User, currency = "EUR", groupId?: number) =>
  (await createWallet(u.id, { name: `${currency} ${Math.random()}`, currency, initialBalanceMinor: 0, groupId })).id;
const spend = (u: User, walletId: number, amountMinor: number, date: string, category = "Food") =>
  createTransaction(u.id, { walletId, kind: "expense", categoryId: u.cat(category), amountMinor, date });
const earn = (u: User, walletId: number, amountMinor: number, date: string, category = "Salary") =>
  createTransaction(u.id, { walletId, kind: "income", categoryId: u.cat(category), amountMinor, date });

const TODAY = "2026-11-25";

describe("getYearReport", () => {
  it("adds up the year, its months and its categories; transfers never count; archived wallets and categories do", async () => {
    const eur = await wallet(alice);
    const savings = await wallet(alice);
    await spend(alice, eur, 1000, "2025-01-05");
    await spend(alice, eur, 500, "2025-01-20", "Transport");
    await spend(alice, eur, 3000, "2025-03-01", "Bills");
    await spend(alice, eur, 200, "2025-12-31");
    await earn(alice, eur, 10_000, "2025-03-15");
    await earn(alice, eur, 400, "2025-07-01", "Refund");
    await createTransfer(alice.id, { fromWalletId: eur, toWalletId: savings, amountMinor: 7777, date: "2025-03-02" });
    // Outside the year.
    await spend(alice, eur, 9999, "2026-01-01");
    // An archived wallet and an archived category still count.
    const old = await wallet(alice);
    await spend(alice, old, 50, "2025-06-10", "Groceries");
    await archiveWallet(alice.id, old);
    await archiveCategory(alice.id, alice.cat("Groceries"));
    // Another user's entries are invisible.
    await spend(bob, await wallet(bob), 123_456, "2025-01-05");

    const r = await getYearReport(alice.id, { year: "2025", currency: "EUR", today: TODAY });
    expect(r.totals).toEqual({ incomeMinor: 10_400, expenseMinor: 4750, netMinor: 5650 });
    expect(r.months).toHaveLength(12);
    expect(r.months[0]).toEqual({ month: "2025-01", incomeMinor: 0, expenseMinor: 1500, netMinor: -1500 });
    expect(r.months[2]).toEqual({ month: "2025-03", incomeMinor: 10_000, expenseMinor: 3000, netMinor: 7000 });
    expect(r.months[11].expenseMinor).toBe(200);
    expect(r.expenseCategories.map((c) => [c.name, c.totalMinor, c.archived])).toEqual([
      ["Bills", 3000, false],
      ["Food", 1200, false],
      ["Transport", 500, false],
      ["Groceries", 50, true],
    ]);
    expect(r.expenseCategories[1].months).toEqual([1000, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 200]);
    expect(r.incomeCategories.map((c) => [c.name, c.totalMinor])).toEqual([
      ["Salary", 10_000],
      ["Refund", 400],
    ]);
    // The category rows add up to the month figures.
    for (let m = 0; m < 12; m++) {
      expect(r.expenseCategories.reduce((s, c) => s + c.months[m], 0)).toBe(r.months[m].expenseMinor);
    }
    expect(r.missingCurrencies).toBeUndefined();
    // Bob sees only his own.
    expect((await getYearReport(bob.id, { year: "2025", currency: "EUR", today: TODAY })).totals.expenseMinor).toBe(123_456);
  });

  it("counts only wallets of the currency without convert", async () => {
    await spend(alice, await wallet(alice, "EUR"), 1000, "2025-02-01");
    await spend(alice, await wallet(alice, "USD"), 5000, "2025-02-01");
    const r = await getYearReport(alice.id, { year: "2025", currency: "USD", today: TODAY });
    expect(r.totals.expenseMinor).toBe(5000);
    expect((await getYearReport(alice.id, { year: "2025", currency: "JPY", today: TODAY })).totals.expenseMinor).toBe(0);
  });

  it("compares a past year with the whole previous year", async () => {
    const eur = await wallet(alice);
    await spend(alice, eur, 1000, "2024-12-31");
    await spend(alice, eur, 2000, "2024-01-01");
    await earn(alice, eur, 500, "2024-06-01");
    await spend(alice, eur, 3000, "2025-05-05");
    const r = await getYearReport(alice.id, { year: "2025", currency: "EUR", today: TODAY });
    expect(r.comparison).toEqual({
      previousYear: "2024",
      through: null,
      current: { incomeMinor: 0, expenseMinor: 3000, netMinor: -3000 },
      previous: { incomeMinor: 500, expenseMinor: 3000, netMinor: -2500 },
    });
  });

  it("compares the current year with the same period of the previous year", async () => {
    const eur = await wallet(alice);
    await spend(alice, eur, 100, "2025-11-25"); // the same day a year ago: counted
    await spend(alice, eur, 200, "2025-11-26"); // after it: not counted
    await spend(alice, eur, 400, "2025-12-31");
    await spend(alice, eur, 1000, "2026-11-25"); // today
    await spend(alice, eur, 5000, "2026-12-05"); // dated after today: in the year's totals, not in the comparison
    const r = await getYearReport(alice.id, { year: "2026", currency: "EUR", today: TODAY });
    expect(r.totals.expenseMinor).toBe(6000);
    expect(r.months[11].expenseMinor).toBe(5000);
    expect(r.comparison.through).toEqual({ current: "2026-11-25", previous: "2025-11-25" });
    expect(r.comparison.current.expenseMinor).toBe(1000);
    expect(r.comparison.previous.expenseMinor).toBe(100);
  });

  it("narrows to a wallet group", async () => {
    const work = await createWalletGroup(alice.id, { name: "Work" });
    await spend(alice, await wallet(alice), 1000, "2025-04-01");
    await spend(alice, await wallet(alice, "EUR", work.id), 300, "2025-04-02", "Transport");
    const r = await getYearReport(alice.id, { year: "2025", currency: "EUR", today: TODAY, groupId: work.id });
    expect(r.totals.expenseMinor).toBe(300);
    expect(r.expenseCategories.map((c) => c.name)).toEqual(["Transport"]);
    // Bob's id as a group: like an empty group.
    const bobsGroup = await createWalletGroup(bob.id, { name: "Bob's" });
    expect((await getYearReport(alice.id, { year: "2025", currency: "EUR", today: TODAY, groupId: bobsGroup.id })).totals.expenseMinor).toBe(0);
  });

  describe("convert", () => {
    // Per 1 EUR. A weekend uses the Friday before.
    const rates: DailyRates = {
      base: "EUR",
      days: [
        { date: "2024-06-03", rates: { USD: 2 } },
        { date: "2025-03-07", rates: { USD: 2 } },
        { date: "2025-03-10", rates: { USD: 4 } },
      ],
    };

    it("converts each day's sums at that day's rate and lists a currency without a rate", async () => {
      const eur = await wallet(alice);
      const usd = await wallet(alice, "USD");
      const chf = await wallet(alice, "CHF");
      await spend(alice, eur, 100, "2025-03-08");
      await spend(alice, usd, 1000, "2025-03-08"); // Saturday: Friday's 2 → 500
      await spend(alice, usd, 1000, "2025-03-10", "Bills"); // 4 → 250
      await earn(alice, usd, 2000, "2025-03-10"); // → 500
      await spend(alice, usd, 400, "2024-06-10"); // previous year → 200
      await spend(alice, chf, 9000, "2025-03-10"); // no rate: left out
      const r = await getYearReport(alice.id, { year: "2025", currency: "EUR", today: TODAY, convert: { rates } });
      expect(r.totals).toEqual({ incomeMinor: 500, expenseMinor: 850, netMinor: -350 });
      expect(r.months[2].expenseMinor).toBe(850);
      expect(r.expenseCategories.map((c) => [c.name, c.totalMinor])).toEqual([
        ["Food", 600],
        ["Bills", 250],
      ]);
      expect(r.comparison.previous.expenseMinor).toBe(200);
      expect(r.missingCurrencies).toEqual(["CHF"]);
    });

    it("without any rate, counts only the target currency and lists the others", async () => {
      await spend(alice, await wallet(alice), 100, "2025-03-08");
      await spend(alice, await wallet(alice, "USD"), 1000, "2025-03-08");
      const r = await getYearReport(alice.id, { year: "2025", currency: "EUR", today: TODAY, convert: { rates: null } });
      expect(r.totals.expenseMinor).toBe(100);
      expect(r.missingCurrencies).toEqual(["USD"]);
    });
  });

  it("rejects an invalid year, currency or today", async () => {
    const reject = async (opts: Parameters<typeof getYearReport>[1], field: string) => {
      const err = await getYearReport(alice.id, opts).catch((e) => e);
      expect(err).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).field).toBe(field);
    };
    await reject({ year: "25", currency: "EUR", today: TODAY }, "year");
    await reject({ year: "1899", currency: "EUR", today: TODAY }, "year");
    await reject({ year: "2025", currency: "eur", today: TODAY }, "currency");
    await reject({ year: "2025", currency: "EUR", today: "2025-13-01" }, "date");
  });

  it("issues one database query for the whole year", async () => {
    const eur = await wallet(alice);
    for (let m = 1; m <= 12; m++) await spend(alice, eur, 100 * m, `2025-${String(m).padStart(2, "0")}-15`);
    const spy = vi.spyOn(db, "select");
    await getYearReport(alice.id, { year: "2025", currency: "EUR", today: TODAY });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("pickDefaultCurrencyBetween", () => {
  it("picks the currency with the most entries in the range", async () => {
    const eur = await wallet(alice);
    const usd = await wallet(alice, "USD");
    await spend(alice, eur, 100, "2025-01-01");
    await spend(alice, usd, 100, "2025-02-01");
    await spend(alice, usd, 100, "2025-12-31");
    await spend(alice, eur, 100, "2026-01-01");
    await spend(alice, eur, 100, "2026-01-02");
    expect(await pickDefaultCurrencyBetween(alice.id, "2025-01-01", "2025-12-31")).toBe("USD");
    expect(await pickDefaultCurrencyBetween(alice.id, "2026-01-01", "2026-12-31")).toBe("EUR");
  });
});

describe("rates for a year", () => {
  /** A fake Frankfurter: every Monday–Friday of the asked range, USD = 1.1. */
  const provider = () =>
    vi.fn<(url: string) => Promise<Response>>(async (url) => {
      const m = /\/v1\/(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})\?base=EUR$/.exec(url)!;
      const rates: Record<string, Record<string, number>> = {};
      for (let d = m[1]; d <= m[2]; d = addDays(d, 1)) {
        const wd = new Date(`${d}T00:00:00Z`).getUTCDay();
        if (wd !== 0 && wd !== 6) rates[d] = { USD: 1.1 };
      }
      return new Response(JSON.stringify({ base: "EUR", rates }), { status: 200 });
    });

  it("is one provider request for the two years the page needs, and none once they are stored", async () => {
    resetExchangeRatesCache();
    vi.stubEnv("EXCHANGE_RATES", "true");
    const fetchMock = provider();
    vi.stubGlobal("fetch", fetchMock);
    const now = new Date(2026, 10, 25, 12).getTime();
    const conv = await getConversion(alice.id, "2025-01-01", "2026-12-31", now);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/v1\/2024-12-25\.\.2026-11-25\?base=EUR$/);
    expect(conv.rates?.days.length).toBeGreaterThan(480);
    // A past year whose days are all stored and final: no request.
    await getConversion(alice.id, "2025-01-01", "2025-12-31", now + 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("helpers", () => {
  it("year in the URL, links and months", () => {
    expect(isValidYear("2025")).toBe(true);
    expect(isValidYear("1899")).toBe(false);
    expect(isValidYear("20255")).toBe(false);
    expect(isValidYear(["2025"])).toBe(false);
    expect(resolveReportYear("2024", "2026")).toBe("2024");
    expect(resolveReportYear("2030", "2026")).toBe("2026");
    expect(resolveReportYear("nope", "2026")).toBe("2026");
    expect(resolveReportYear(undefined, "2026")).toBe("2026");
    expect(yearMonths("2025")).toEqual([
      "2025-01", "2025-02", "2025-03", "2025-04", "2025-05", "2025-06",
      "2025-07", "2025-08", "2025-09", "2025-10", "2025-11", "2025-12",
    ]);
    expect(reportsHref("2026", null, "2026")).toBe("/reports");
    expect(reportsHref("2025", "USD", "2026", "only")).toBe("/reports?year=2025&currency=USD&view=only");
  });

  it("the comparison period and wording", () => {
    expect(comparisonThrough("2025", TODAY)).toBeNull();
    expect(comparisonThrough("2026", TODAY)).toEqual({ current: TODAY, previous: "2025-11-25" });
    expect(comparisonThrough("2028", "2028-02-29")).toEqual({ current: "2028-02-29", previous: "2027-02-28" });
    expect(periodLabel("2026-11-25")).toBe("1 Jan – 25 Nov");
    expect(periodLabel("2026-01-01")).toBe("1 Jan");
    expect(percentChange(112, 100)).toBe(12);
    expect(percentChange(50, 100)).toBe(-50);
    expect(percentChange(5, 0)).toBeNull();
    const base = { previousYear: "2025", currency: "EUR", through: null };
    expect(comparisonSub({ ...base, measure: "expense", total: 11_200, current: 11_200, previous: 10_000 })).toBe("vs €100.00 in 2025 · +12%");
    expect(comparisonSub({ ...base, measure: "income", total: 100, current: 100, previous: 0 })).toBe("nothing in 2025");
    expect(comparisonSub({ ...base, measure: "net", total: -500, current: -500, previous: 900 })).toBe("vs +€9.00 in 2025");
    expect(comparisonSub({ ...base, measure: "net", total: 5, current: 5, previous: 0 })).toBe("vs €0.00 in 2025");
    expect(comparisonSub({ ...base, measure: "net", total: 5, current: 5, previous: 0, previousEmpty: true })).toBe("nothing in 2025");
    expect(
      comparisonSub({ ...base, through: TODAY, measure: "expense", total: 6000, current: 1000, previous: 1000 }),
    ).toBe("€10.00 by 25 Nov vs €10.00 in 2025 · ±0%");
  });

  it("compact amounts", () => {
    expect(wholeUnits(123_456, "EUR")).toBe("1,235");
    expect(wholeUnits(-49, "EUR")).toBe("0");
    expect(wholeUnits(1500, "JPY")).toBe("1,500");
    expect(wholeUnits(1_234_567, "KWD")).toBe("1,235");
    expect(compactMoney(123_456, "EUR")).toBe("€1.2K");
    expect(compactMoney(35_000, "EUR")).toBe("€350");
    expect(compactMoney(-35_000, "EUR", { signed: true })).toBe("-€350");
    expect(compactMoney(35_000, "EUR", { signed: true })).toBe("+€350");
  });
});
