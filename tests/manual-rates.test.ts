// The user's own exchange rates (src/server/manual-rates.ts), how the converted month figures use them, the
// converted /categories amounts. No network: `fetch` is stubbed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DB } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { manualRates } from "@/db/schema";
import { ServiceError } from "@/lib/errors";
import type { DailyRates } from "@/lib/fx";
import { getConversion, resetExchangeRatesCache } from "@/server/exchange-rates";
import { getCategoryMonthAmounts, getMonthInsights } from "@/server/insights";
import { deleteManualRate, listManualRates, manualRatesFor, setManualRate } from "@/server/manual-rates";
import { createTransaction } from "@/server/transactions";
import { createWallet } from "@/server/wallets";
import { makeUser, useFreshDb } from "./helpers";

let db: DB;
let alice: Awaited<ReturnType<typeof makeUser>>;
let bob: Awaited<ReturnType<typeof makeUser>>;

beforeEach(async () => {
  db = await useFreshDb();
  resetExchangeRatesCache();
  alice = await makeUser(db, "alice@example.com");
  bob = await makeUser(db, "bob@example.com");
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

type User = typeof alice;
const wallet = async (u: User, currency: string, initialBalanceMinor = 0) =>
  (await createWallet(u.id, { name: `${currency} wallet`, currency, initialBalanceMinor })).id;
const spend = (u: User, walletId: number, amountMinor: number, date: string, category = "Food") =>
  createTransaction(u.id, { walletId, kind: "expense", categoryId: u.cat(category), amountMinor, date });

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

describe("setManualRate / listManualRates / deleteManualRate", () => {
  beforeEach(async () => {
    await wallet(alice, "EUR");
    await wallet(alice, "KWD");
    await wallet(alice, "USD");
  });

  it("stores the rate exactly as typed, and the same date again replaces it", async () => {
    const saved = await setManualRate(alice.id, { currency: "KWD", base: "EUR", effectiveDate: "2026-11-01", rate: "3,25" });
    expect(saved).toMatchObject({ currency: "KWD", base: "EUR", effectiveDate: "2026-11-01", rate: "3.25" });
    await setManualRate(alice.id, { currency: "KWD", base: "USD", effectiveDate: "2026-11-01", rate: "3.5" });
    await setManualRate(alice.id, { currency: "KWD", base: "EUR", effectiveDate: "2026-10-01", rate: "0.000087" });
    const list = await listManualRates(alice.id);
    expect(list.map((r) => [r.effectiveDate, r.base, r.rate])).toEqual([
      ["2026-11-01", "USD", "3.5"],
      ["2026-10-01", "EUR", "0.000087"],
    ]);
    expect((await manualRatesFor(alice.id))[1].rate).toBe(0.000087);
  });

  it("refuses a currency the user holds no wallet in, EUR, a bad base, a bad rate or date", async () => {
    const ok = { currency: "KWD", base: "EUR", effectiveDate: "2026-11-01", rate: "3.25" };
    await expectServiceError(() => setManualRate(alice.id, { ...ok, currency: "ARS" }), "VALIDATION", "currency");
    await expectServiceError(() => setManualRate(alice.id, { ...ok, currency: "kwd" }), "VALIDATION", "currency");
    await expectServiceError(() => setManualRate(alice.id, { ...ok, currency: "EUR" }), "VALIDATION", "currency");
    await expectServiceError(() => setManualRate(alice.id, { ...ok, base: "GBP" }), "VALIDATION", "base");
    await expectServiceError(() => setManualRate(alice.id, { ...ok, base: "KWD" }), "VALIDATION", "base");
    await expectServiceError(() => setManualRate(alice.id, { ...ok, rate: "0" }), "VALIDATION", "rate");
    await expectServiceError(() => setManualRate(alice.id, { ...ok, rate: "-1" }), "VALIDATION", "rate");
    await expectServiceError(() => setManualRate(alice.id, { ...ok, effectiveDate: "2026-02-30" }), "VALIDATION", "effectiveDate");
    // Bob holds no KWD wallet.
    await expectServiceError(() => setManualRate(bob.id, ok), "VALIDATION", "currency");
    expect(await listManualRates(alice.id)).toEqual([]);
  });

  it("keeps rates per user: another user's rate cannot be seen or removed", async () => {
    const saved = await setManualRate(alice.id, { currency: "KWD", base: "EUR", effectiveDate: "2026-11-01", rate: "3.25" });
    expect(await listManualRates(bob.id)).toEqual([]);
    await expectServiceError(() => deleteManualRate(bob.id, saved.id), "NOT_FOUND");
    await expectServiceError(() => deleteManualRate(alice.id, 99999999999), "NOT_FOUND");
    await deleteManualRate(alice.id, saved.id);
    expect(await listManualRates(alice.id)).toEqual([]);
  });

  it("goes with the account (cascade) and the database refuses a bad row", async () => {
    const [carol] = await db.insert(users).values({ username: "carol", passwordHash: "x" }).returning();
    await db.insert(manualRates).values({ userId: carol.id, currency: "KWD", base: "EUR", effectiveDate: "2026-11-01", rate: "3" });
    await expect(
      db.insert(manualRates).values({ userId: carol.id, currency: "KWD", base: "EUR", effectiveDate: "2026-11-02", rate: "0" }),
    ).rejects.toThrow();
    await expect(
      db.insert(manualRates).values({ userId: carol.id, currency: "KWD", base: "KWD", effectiveDate: "2026-11-02", rate: "1" }),
    ).rejects.toThrow();
    await db.delete(users).where(eq(users.id, carol.id));
    expect(await db.select().from(manualRates).where(eq(manualRates.userId, carol.id))).toEqual([]);
  });
});

describe("own rates in the converted month figures", () => {
  // 1 EUR = 1.25 USD on every day; KWD is never quoted.
  const daily: DailyRates = {
    base: "EUR",
    days: [
      { date: "2026-02-27", rates: { USD: 1.25 } },
      { date: "2026-03-02", rates: { USD: 1.25 } },
    ],
  };

  it("fill in a currency the provider does not quote, from the rate's date on", async () => {
    const eur = await wallet(alice, "EUR");
    const kwd = await wallet(alice, "KWD");
    await wallet(alice, "USD");
    await spend(alice, eur, 1000, "2026-03-03");
    await spend(alice, kwd, 1000, "2026-03-04"); // 1.000 KWD
    await spend(alice, kwd, 2000, "2026-03-20"); // 2.000 KWD
    await setManualRate(alice.id, { currency: "KWD", base: "EUR", effectiveDate: "2026-03-10", rate: "3" });
    const convert = { rates: daily, manual: await manualRatesFor(alice.id) };
    const i = await getMonthInsights(alice.id, { today: "2026-11-25", month: "2026-03", currency: "EUR", convert });
    // 10.00 EUR + 2 KWD × 3 = 6.00 EUR; the 4 Mar entry predates the rate and is left out.
    expect(i.expenseMinor).toBe(1000 + 600);
    expect(i.missingCurrencies).toEqual(["KWD"]);
    await setManualRate(alice.id, { currency: "KWD", base: "USD", effectiveDate: "2026-03-01", rate: "2.5" });
    const all = await getMonthInsights(alice.id, {
      today: "2026-11-25",
      month: "2026-03",
      currency: "EUR",
      convert: { rates: daily, manual: await manualRatesFor(alice.id) },
    });
    // 4 Mar: 1 KWD = 2.5 USD = 2 EUR; 20 Mar: the 10 Mar rate (3 EUR) is the latest.
    expect(all.expenseMinor).toBe(1000 + 200 + 600);
    expect(all.missingCurrencies).toEqual([]);
  });

  it("getConversion brings the user's own rates even with the provider switched off", async () => {
    vi.stubEnv("EXCHANGE_RATES", "false");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await wallet(alice, "KWD");
    await setManualRate(alice.id, { currency: "KWD", base: "EUR", effectiveDate: "2026-01-01", rate: "3" });
    const conv = await getConversion(alice.id, "2026-03-01", "2026-03-31");
    expect(conv.rates).toBeNull();
    expect(conv.manual).toEqual([{ currency: "KWD", base: "EUR", effectiveDate: "2026-01-01", rate: 3 }]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await getConversion(bob.id, "2026-03-01", "2026-03-31")).manual).toEqual([]);
  });
});

describe("getCategoryMonthAmounts (/categories, All in <currency>)", () => {
  it("adds every currency per category at each day's rate, and lists what has no rate", async () => {
    const eur = await wallet(alice, "EUR");
    const usd = await wallet(alice, "USD");
    const ron = await wallet(alice, "RON");
    await spend(alice, eur, 1000, "2026-03-03");
    await spend(alice, usd, 2500, "2026-03-03"); // 25 USD = 20 EUR
    await spend(alice, usd, 1250, "2026-03-05", "Transport"); // 10 EUR
    await spend(alice, ron, 5000, "2026-03-05", "Transport"); // no rate
    await spend(alice, eur, 999, "2026-04-01"); // another month
    const rates: DailyRates = { base: "EUR", days: [{ date: "2026-03-02", rates: { USD: 1.25 } }] };
    const r = await getCategoryMonthAmounts(alice.id, { month: "2026-03", currency: "EUR", convert: { rates } });
    expect(r.amounts.get(alice.cat("Food"))).toBe(1000 + 2000);
    expect(r.amounts.get(alice.cat("Transport"))).toBe(1000);
    expect(r.missingCurrencies).toEqual(["RON"]);
    // Without convert: only EUR wallets.
    const plain = await getCategoryMonthAmounts(alice.id, { month: "2026-03", currency: "EUR" });
    expect(plain.amounts.get(alice.cat("Food"))).toBe(1000);
    expect(plain.amounts.has(alice.cat("Transport"))).toBe(false);
    expect((await getCategoryMonthAmounts(bob.id, { month: "2026-03", currency: "EUR", convert: { rates } })).amounts.size).toBe(0);
  });
});
