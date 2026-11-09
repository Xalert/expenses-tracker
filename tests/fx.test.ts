import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exchangeRatesEnabled } from "@/lib/config";
import { convertMinor, convertedTotal, tableOn, type DailyRates, type RateTable } from "@/lib/fx";
import { overviewHref, resolveOverviewView, walletsTotalNotes } from "@/lib/overview";
import {
  RATES_URL,
  getDailyRates,
  getExchangeRates,
  parseRatesResponse,
  resetExchangeRatesCache,
} from "@/server/exchange-rates";

// Synthetic rates per 1 EUR.
const table: RateTable = { base: "EUR", date: "2026-11-06", rates: { RON: 5, USD: 1.25, JPY: 160, KWD: 0.4 } };

describe("convertMinor", () => {
  it("keeps the amount for the same currency, with or without rates", () => {
    expect(convertMinor(1234, "EUR", "EUR", null)).toBe(1234);
  });
  it("converts through the base and rounds to the target's decimals", () => {
    expect(convertMinor(10000, "RON", "EUR", table)).toBe(2000); // 100 RON → 20 EUR
    expect(convertMinor(2000, "EUR", "RON", table)).toBe(10000);
    expect(convertMinor(1000, "USD", "RON", table)).toBe(4000); // 10 USD → 8 EUR → 40 RON
    expect(convertMinor(1, "EUR", "JPY", table)).toBe(2); // 0.01 EUR → 1.6 JPY → 2 (JPY has no decimals)
    expect(convertMinor(1000, "JPY", "KWD", table)).toBe(2500); // 1000 JPY → 6.25 EUR → 2.500 KWD
  });
  it("rounds negative balances half away from zero", () => {
    expect(convertMinor(-1, "EUR", "JPY", table)).toBe(-2);
  });
  it("returns null without a table or without a rate for either side", () => {
    expect(convertMinor(100, "RON", "EUR", null)).toBeNull();
    expect(convertMinor(100, "CHF", "EUR", table)).toBeNull();
    expect(convertMinor(100, "EUR", "CHF", table)).toBeNull();
  });
});

describe("convertedTotal", () => {
  const wallets = [
    { id: 1, currency: "EUR", balanceMinor: 50000 },
    { id: 2, currency: "RON", balanceMinor: 100000 },
    { id: 3, currency: "CHF", balanceMinor: 1000 },
    { id: 4, currency: "USD", balanceMinor: -2500 },
  ];
  it("adds every wallet it can convert and lists the currencies it cannot", () => {
    const t = convertedTotal(wallets, "EUR", table);
    expect(t.totalMinor).toBe(50000 + 20000 - 2000);
    expect([...t.converted]).toEqual([
      [2, 20000],
      [4, -2000],
    ]);
    expect(t.missing).toEqual(["CHF"]);
    expect(t.usedRates).toBe(true);
  });
  it("without rates counts only the wallets already in the currency", () => {
    const t = convertedTotal(wallets, "EUR", null);
    expect(t.totalMinor).toBe(50000);
    expect(t.missing).toEqual(["CHF", "RON", "USD"]);
    expect(t.usedRates).toBe(false);
  });
});

describe("parseRatesResponse", () => {
  it("reads a Frankfurter latest response and drops bad entries", () => {
    expect(
      parseRatesResponse({ amount: 1, base: "EUR", date: "2026-11-06", rates: { RON: 5.08, usd: 1, XXX: -1, JPY: "1" } }),
    ).toEqual({ base: "EUR", date: "2026-11-06", rates: { RON: 5.08 } });
  });
  it("refuses anything else", () => {
    expect(parseRatesResponse(null)).toBeNull();
    expect(parseRatesResponse({ base: "EUR", rates: {} })).toBeNull();
    expect(parseRatesResponse({ base: "EUR", date: "2026-11-06" })).toBeNull();
  });
});

describe("getExchangeRates", () => {
  const ok = () =>
    new Response(JSON.stringify({ amount: 1, base: "EUR", date: "2026-11-06", rates: { RON: 5 } }), { status: 200 });

  beforeEach(() => {
    resetExchangeRatesCache();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("fetches once and serves the cached table until it is old", async () => {
    const fetchMock = vi.fn<(url: string) => Promise<Response>>(async () => ok());
    vi.stubGlobal("fetch", fetchMock);
    const t0 = Date.now();
    expect((await getExchangeRates(t0))?.rates.RON).toBe(5);
    await getExchangeRates(t0 + 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(RATES_URL);
    await getExchangeRates(t0 + 7 * 60 * 60 * 1000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the last good table when a refresh fails, and waits before trying again", async () => {
    const fetchMock = vi.fn<(url: string) => Promise<Response>>(async () => ok());
    vi.stubGlobal("fetch", fetchMock);
    const t0 = Date.now();
    await getExchangeRates(t0);
    fetchMock.mockImplementation(async () => new Response("down", { status: 503 }));
    const later = t0 + 7 * 60 * 60 * 1000;
    expect((await getExchangeRates(later))?.date).toBe("2026-11-06");
    await getExchangeRates(later + 1000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns null when nothing could be loaded", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("offline"))));
    expect(await getExchangeRates()).toBeNull();
  });

  it("does not call out when EXCHANGE_RATES=false", async () => {
    vi.stubEnv("EXCHANGE_RATES", "false");
    const fetchMock = vi.fn<(url: string) => Promise<Response>>(async () => ok());
    vi.stubGlobal("fetch", fetchMock);
    expect(exchangeRatesEnabled()).toBe(false);
    expect(await getExchangeRates()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Overview view and total notes", () => {
  it("reads ?view=", () => {
    expect(resolveOverviewView("only")).toBe("only");
    expect(resolveOverviewView("all")).toBe("all");
    expect(resolveOverviewView(["only"])).toBe("all");
    expect(resolveOverviewView(undefined)).toBe("all");
  });
  it("writes view=only and leaves the default out", () => {
    expect(overviewHref("2026-11", "EUR", "2026-11", "/", "only")).toBe("/?currency=EUR&view=only");
    expect(overviewHref("2026-11", "EUR", "2026-11", "/", "all")).toBe("/?currency=EUR");
  });
  it("names the rate date and source, and what was left out", () => {
    const base = { currency: "EUR", source: "ECB", missing: [] as string[], ratesDate: null };
    expect(walletsTotalNotes({ ...base, ratesState: "loaded" })).toEqual([]);
    expect(walletsTotalNotes({ ...base, ratesDate: "2026-11-06", ratesState: "loaded" })).toEqual([
      "Rates of 6 Nov 2026 · ECB",
    ]);
    expect(walletsTotalNotes({ ...base, missing: ["CHF"], ratesDate: "2026-11-06", ratesState: "loaded" })).toEqual([
      "Rates of 6 Nov 2026 · ECB",
      "No exchange rate for CHF. Not included: wallets in CHF.",
    ]);
    expect(walletsTotalNotes({ ...base, missing: ["RON", "USD"], ratesState: "unavailable" })).toEqual([
      "Exchange rates are not available now. Not included: wallets in RON, USD.",
    ]);
    expect(walletsTotalNotes({ ...base, currency: "KWD", missing: ["EUR"], ratesState: "no-target" })).toEqual([
      "No exchange rate for KWD. Not included: wallets in EUR.",
    ]);
    expect(walletsTotalNotes({ ...base, missing: ["RON"], ratesState: "off" })).toEqual([
      "Exchange rates are switched off. Not included: wallets in RON.",
    ]);
  });
});

describe("tableOn", () => {
  const daily: DailyRates = {
    base: "EUR",
    days: [
      { date: "2026-11-05", rates: { USD: 1 } },
      { date: "2026-11-06", rates: { USD: 2 } },
      { date: "2026-11-09", rates: { USD: 3 } },
    ],
  };
  it("uses the latest day on or before the date, else the first day", () => {
    expect(tableOn(daily, "2026-11-06")?.rates.USD).toBe(2);
    expect(tableOn(daily, "2026-11-08")).toEqual({ base: "EUR", date: "2026-11-06", rates: { USD: 2 } });
    expect(tableOn(daily, "2026-12-01")?.rates.USD).toBe(3);
    expect(tableOn(daily, "2026-01-01")?.rates.USD).toBe(1);
    expect(tableOn(null, "2026-11-06")).toBeNull();
    expect(tableOn({ base: "EUR", days: [] }, "2026-11-06")).toBeNull();
  });
});

describe("getDailyRates", () => {
  const series = () =>
    new Response(
      JSON.stringify({
        amount: 1,
        base: "EUR",
        start_date: "2026-09-24",
        end_date: "2026-10-30",
        rates: { "2026-10-02": { USD: 1.2 }, "2026-09-25": { USD: 1.1, bad: 1 } },
      }),
      { status: 200 },
    );
  beforeEach(() => {
    resetExchangeRatesCache();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("asks for the range plus a week before, sorts the days, and keeps a past range", async () => {
    const fetchMock = vi.fn<(url: string) => Promise<Response>>(async () => series());
    vi.stubGlobal("fetch", fetchMock);
    const now = new Date(2026, 10, 9, 12).getTime();
    const d = await getDailyRates("2026-10-01", "2026-10-31", now);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.frankfurter.dev/v1/2026-09-24..2026-10-31?base=EUR");
    expect(d?.days.map((x) => x.date)).toEqual(["2026-09-25", "2026-10-02"]);
    expect(d?.days[0].rates).toEqual({ USD: 1.1 });
    await getDailyRates("2026-10-01", "2026-10-31", now + 30 * 24 * 60 * 60 * 1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("caps the end at today and refreshes a range that includes today", async () => {
    const fetchMock = vi.fn<(url: string) => Promise<Response>>(async () => series());
    vi.stubGlobal("fetch", fetchMock);
    const now = new Date(2026, 10, 9, 12).getTime();
    await getDailyRates("2026-10-01", "2026-11-30", now);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.frankfurter.dev/v1/2026-09-24..2026-11-09?base=EUR");
    await getDailyRates("2026-10-01", "2026-11-30", now + 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await getDailyRates("2026-10-01", "2026-11-30", now + 7 * 60 * 60 * 1000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns null when the provider fails and nothing is cached, then waits before trying again", async () => {
    const fetchMock = vi.fn<(url: string) => Promise<Response>>(async () => new Response("x", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const now = new Date(2026, 10, 9, 12).getTime();
    expect(await getDailyRates("2026-10-01", "2026-10-31", now)).toBeNull();
    expect(await getDailyRates("2026-10-01", "2026-10-31", now + 1000)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not call out when EXCHANGE_RATES=false", async () => {
    vi.stubEnv("EXCHANGE_RATES", "false");
    const fetchMock = vi.fn<(url: string) => Promise<Response>>(async () => series());
    vi.stubGlobal("fetch", fetchMock);
    expect(await getDailyRates("2026-10-01", "2026-10-31")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
