// The provider rates kept in the database (src/server/exchange-rates.ts). `fetch` is a stub standing in for
// Frankfurter: no test reaches the network.
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DB } from "@/db";
import { exchangeRates } from "@/db/schema";
import { addDays } from "@/lib/dates";
import { tableOn } from "@/lib/fx";
import {
  RATES_BASE_URL,
  getDailyRates,
  getProviderCurrencies,
  parseRatesResponse,
  parseSeriesResponse,
  resetExchangeRatesCache,
} from "@/server/exchange-rates";
import { useFreshDb } from "./helpers";

let db: DB;

/** A fake Frankfurter: every Monday–Friday of the asked range, USD = 1 + day-of-month / 100, KWD only in 2025. */
function provider() {
  return vi.fn<(url: string) => Promise<Response>>(async (url) => {
    const m = /\/v1\/(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})\?base=EUR$/.exec(url);
    if (!m) return new Response("bad", { status: 404 });
    const rates: Record<string, Record<string, number>> = {};
    for (let d = m[1]; d <= m[2]; d = addDays(d, 1)) {
      const wd = new Date(`${d}T00:00:00Z`).getUTCDay();
      if (wd === 0 || wd === 6) continue;
      rates[d] = { USD: 1 + Number(d.slice(8)) / 100, ...(d < "2026-01-01" ? { KWD: 0.33 } : {}) };
    }
    return new Response(JSON.stringify({ amount: 1, base: "EUR", start_date: m[1], end_date: m[2], rates }), { status: 200 });
  });
}

const failing = () => vi.fn<(url: string) => Promise<Response>>(async () => new Response("down", { status: 503 }));

/** Local noon on a day of November 2026 (todayISO is the server's local date). */
const nov = (day: number, hour = 12) => new Date(2026, 10, day, hour).getTime();
const HOUR = 60 * 60 * 1000;

beforeEach(async () => {
  db = await useFreshDb();
  resetExchangeRatesCache();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("parsing", () => {
  it("reads a day and a time series, dropping bad entries", () => {
    expect(
      parseRatesResponse({ amount: 1, base: "EUR", date: "2026-11-06", rates: { RON: 5.08, usd: 1, XXX: -1, JPY: "1" } }),
    ).toEqual({ base: "EUR", date: "2026-11-06", rates: { RON: 5.08 } });
    expect(parseRatesResponse({ base: "EUR", rates: {} })).toBeNull();
    expect(
      parseSeriesResponse({ base: "EUR", rates: { "2026-10-02": { USD: 1.2 }, "2026-09-25": { USD: 1.1, bad: 1 } } }),
    ).toEqual({
      base: "EUR",
      days: [
        { date: "2026-09-25", rates: { USD: 1.1 } },
        { date: "2026-10-02", rates: { USD: 1.2 } },
      ],
    });
    expect(parseSeriesResponse({ base: "EUR" })).toBeNull();
  });
});

describe("getDailyRates (database cache)", () => {
  it("on a miss asks for the range plus a week before, and stores every day as an exact decimal", async () => {
    const fetchMock = provider();
    vi.stubGlobal("fetch", fetchMock);
    const d = await getDailyRates("2026-10-01", "2026-10-31", nov(9));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(`${RATES_BASE_URL}2026-09-24..2026-10-31?base=EUR`);
    expect(d?.days[0]).toEqual({ date: "2026-09-24", rates: { USD: 1.24 } });
    expect(d?.days.at(-1)?.date).toBe("2026-10-30");
    expect(d?.incomplete).toBeUndefined();
    const [row] = await db.select().from(exchangeRates).where(sql`${exchangeRates.rateDate} = '2026-10-15'`);
    expect(row).toMatchObject({ base: "EUR", quote: "USD", rate: "1.15" });
  });

  it("on a hit makes no request, also after a restart (the cache is the database)", async () => {
    const fetchMock = provider();
    vi.stubGlobal("fetch", fetchMock);
    await getDailyRates("2026-10-01", "2026-10-31", nov(9));
    resetExchangeRatesCache(); // a new process
    const again = await getDailyRates("2026-10-01", "2026-10-31", nov(9) + 30 * 24 * HOUR);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(again?.days.find((x) => x.date === "2026-10-15")?.rates.USD).toBe(1.15);
    // A weekend inside the stored range is known to have no rates: not asked about again.
    await getDailyRates("2026-10-17", "2026-10-18", nov(10));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fetches only the days it is missing", async () => {
    const fetchMock = provider();
    vi.stubGlobal("fetch", fetchMock);
    await getDailyRates("2026-10-01", "2026-10-31", nov(9));
    await getDailyRates("2026-10-01", "2026-11-30", nov(9));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe(`${RATES_BASE_URL}2026-11-01..2026-11-09?base=EUR`);
  });

  it("refreshes today after six hours but never a day fetched after it ended", async () => {
    const fetchMock = provider();
    vi.stubGlobal("fetch", fetchMock);
    await getDailyRates("2026-11-01", "2026-11-30", nov(9));
    await getDailyRates("2026-11-01", "2026-11-30", nov(9) + HOUR);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await getDailyRates("2026-11-01", "2026-11-30", nov(9) + 7 * HOUR);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Only today (9 Nov) was not final; the earlier days were fetched after they ended.
    expect(fetchMock.mock.calls[1][0]).toBe(`${RATES_BASE_URL}2026-11-09..2026-11-09?base=EUR`);
  });

  it("serves a past month at that month's own rates (historical dates)", async () => {
    const fetchMock = provider();
    vi.stubGlobal("fetch", fetchMock);
    const d = await getDailyRates("2025-03-01", "2025-03-31", nov(9));
    expect(fetchMock.mock.calls[0][0]).toBe(`${RATES_BASE_URL}2025-02-22..2025-03-31?base=EUR`);
    // 31 Mar 2025 was a Monday.
    expect(tableOn(d, "2025-03-31")).toEqual({ base: "EUR", date: "2025-03-31", rates: { USD: 1.31, KWD: 0.33 } });
  });

  it("during an outage uses the most recent stored day on or before each date, says so, and waits to retry", async () => {
    vi.stubGlobal("fetch", provider());
    await getDailyRates("2026-10-01", "2026-10-31", nov(9));
    resetExchangeRatesCache();
    const down = failing();
    vi.stubGlobal("fetch", down);
    const d = await getDailyRates("2026-11-01", "2026-11-30", nov(9));
    expect(d?.incomplete).toBe(true);
    // The range's own days are missing; the last stored day before it (30 Oct) stands in.
    expect(tableOn(d, "2026-11-05")).toMatchObject({ date: "2026-10-30", rates: { USD: 1.3 } });
    await getDailyRates("2026-11-01", "2026-11-30", nov(9) + 60_000);
    expect(down).toHaveBeenCalledTimes(1);
    await getDailyRates("2026-11-01", "2026-11-30", nov(9) + 11 * 60_000);
    expect(down).toHaveBeenCalledTimes(2);
  });

  it("returns null when the provider fails and nothing is stored", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("offline"))));
    expect(await getDailyRates("2026-10-01", "2026-10-31", nov(9))).toBeNull();
  });

  it("accepts an empty answer for a weekend-only range", async () => {
    vi.stubGlobal("fetch", provider());
    await getDailyRates("2026-11-02", "2026-11-06", nov(9));
    // Only 7–8 Nov 2026 (a weekend) are missing now.
    const empty = vi.fn(async () => new Response(JSON.stringify({ base: "EUR", rates: {} }), { status: 200 }));
    vi.stubGlobal("fetch", empty);
    const d = await getDailyRates("2026-11-07", "2026-11-08", nov(9));
    expect(empty).toHaveBeenCalledTimes(1);
    expect(empty.mock.calls[0]).toEqual([`${RATES_BASE_URL}2026-11-07..2026-11-08?base=EUR`, expect.anything()]);
    expect(d?.incomplete).toBeUndefined();
    expect(tableOn(d, "2026-11-08")?.date).toBe("2026-11-06");
    await getDailyRates("2026-11-07", "2026-11-08", nov(9));
    expect(empty).toHaveBeenCalledTimes(1);
  });

  it("does not call out when EXCHANGE_RATES=false", async () => {
    vi.stubEnv("EXCHANGE_RATES", "false");
    const fetchMock = provider();
    vi.stubGlobal("fetch", fetchMock);
    expect(await getDailyRates("2026-10-01", "2026-10-31", nov(9))).toBeNull();
    expect(await getProviderCurrencies(nov(9))).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("getProviderCurrencies", () => {
  it("lists the latest stored day's currencies, the base included", async () => {
    vi.stubGlobal("fetch", provider());
    const p = await getProviderCurrencies(nov(9));
    expect(p?.date).toBe("2026-11-09");
    expect([...(p?.currencies ?? [])].sort()).toEqual(["EUR", "USD"]);
  });
  it("is null when nothing could be loaded", async () => {
    vi.stubGlobal("fetch", failing());
    expect(await getProviderCurrencies(nov(9))).toBeNull();
  });
});
