// The pure exchange-rate maths and wording (src/lib/fx.ts, the notes in src/lib/overview.ts). The database-backed
// rate cache is in exchange-rates.test.ts, the user's own rates in manual-rates.test.ts.
import { describe, expect, it } from "vitest";
import {
  convertMinor,
  convertedTotal,
  currenciesNeedingRates,
  parseRateInput,
  tableFor,
  tableOn,
  type Conversion,
  type DailyRates,
  type RateTable,
} from "@/lib/fx";
import {
  monthConversionNotes,
  overviewHref,
  ratesHref,
  ratesNeeded,
  ratesStateOf,
  resolveOverviewView,
  walletsTotalNotes,
} from "@/lib/overview";
import { parseRatesResponse } from "@/server/exchange-rates";

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

describe("tableFor (provider rates, then the user's own)", () => {
  const daily: DailyRates = {
    base: "EUR",
    days: [
      { date: "2026-11-02", rates: { USD: 1.25, RON: 5 } },
      { date: "2026-11-09", rates: { USD: 1.5, RON: 5, KWD: 0.5 } },
    ],
  };
  // 1 KWD = 3.2 EUR from 1 Nov, 4 EUR from 6 Nov; 1 ARS = 0.002 USD from 1 Nov; 1 XAF = 0.01 ARS (a chain).
  const manual = [
    { currency: "KWD", base: "EUR", effectiveDate: "2026-11-01", rate: 3.2 },
    { currency: "KWD", base: "EUR", effectiveDate: "2026-11-06", rate: 4 },
    { currency: "ARS", base: "USD", effectiveDate: "2026-11-01", rate: 0.002 },
    { currency: "XAF", base: "ARS", effectiveDate: "2026-11-01", rate: 0.01 },
  ];
  const conv: Conversion = { rates: daily, manual };

  it("is the provider's table when there are no own rates", () => {
    expect(tableFor({ rates: daily }, "2026-11-03")).toEqual({ base: "EUR", date: "2026-11-02", rates: daily.days[0].rates });
    expect(tableFor(null, "2026-11-03")).toBeNull();
    expect(tableFor({ rates: null, manual: [] }, "2026-11-03")).toBeNull();
  });

  it("fills in a currency the provider has none for, with the latest own rate on or before the date", () => {
    const t = tableFor(conv, "2026-11-03")!;
    expect(t.rates.KWD).toBeCloseTo(1 / 3.2);
    expect(t.manual?.KWD).toBe("2026-11-01");
    expect(tableFor(conv, "2026-11-07")!.rates.KWD).toBeCloseTo(1 / 4);
    // 100 KWD → 320 EUR on 3 Nov.
    expect(convertMinor(100000, "KWD", "EUR", t)).toBe(32000);
  });

  it("never overrides the provider: on a day it quotes the currency, its rate wins", () => {
    const t = tableFor(conv, "2026-11-10")!;
    expect(t.rates.KWD).toBe(0.5);
    expect(t.manual?.KWD).toBeUndefined();
  });

  it("is nothing before the first effective date", () => {
    expect(tableFor(conv, "2026-10-31")?.rates.KWD).toBeUndefined();
  });

  it("goes through the rate's own currency, and through another own rate", () => {
    const t = tableFor(conv, "2026-11-03")!;
    // 1 ARS = 0.002 USD and 1 EUR = 1.25 USD → 1 EUR = 625 ARS.
    expect(t.rates.ARS).toBeCloseTo(625);
    expect(t.rates.XAF).toBeCloseTo(62500);
    expect(convertMinor(62500, "XAF", "EUR", t)).toBe(100); // XAF has no minor units: 62500 XAF → 1.00 EUR
  });

  it("works without provider rates for rates against EUR only", () => {
    const t = tableFor({ rates: null, manual }, "2026-11-03")!;
    expect(t).toMatchObject({ base: "EUR", date: "" });
    expect(t.rates.KWD).toBeCloseTo(1 / 3.2);
    expect(t.rates.ARS).toBeUndefined(); // its USD has no rate without the provider
  });

  it("convertedTotal names the currencies converted at an own rate", () => {
    const t = tableFor(conv, "2026-11-03");
    const total = convertedTotal(
      [
        { id: 1, currency: "EUR", balanceMinor: 1000 },
        { id: 2, currency: "KWD", balanceMinor: 1000 },
        { id: 3, currency: "USD", balanceMinor: 125 },
      ],
      "EUR",
      t,
    );
    expect(total.totalMinor).toBe(1000 + 320 + 100);
    expect(total.manual).toEqual(["KWD"]);
  });
});

describe("parseRateInput", () => {
  it("accepts positive decimals, with a decimal comma, and normalises them", () => {
    expect(parseRateInput("3.25")).toBe("3.25");
    expect(parseRateInput(" 0,000087 ")).toBe("0.000087");
    expect(parseRateInput("007.500")).toBe("7.5");
    expect(parseRateInput("1")).toBe("1");
    expect(parseRateInput("1.0")).toBe("1");
  });
  it("refuses zero, signs, exponents, thousands separators and junk", () => {
    for (const bad of ["0", "0.000", "-1", "+1", "1e3", "1,000.5", "1.2.3", "", "abc", ".5", "1234567890123"]) {
      expect(parseRateInput(bad)).toBeNull();
    }
    expect(parseRateInput(3.25)).toBeNull();
  });
});

describe("currenciesNeedingRates", () => {
  it("lists held currencies the provider does not quote, plus those with own rates, never EUR", () => {
    const quoted = new Set(["EUR", "USD", "RON"]);
    expect(currenciesNeedingRates(["EUR", "KWD", "USD", "ARS"], quoted, [])).toEqual(["ARS", "KWD"]);
    expect(currenciesNeedingRates(["EUR", "USD"], quoted, ["USD"])).toEqual(["USD"]);
    // Nothing quoted (rates off, or never loaded): every held currency but EUR.
    expect(currenciesNeedingRates(["EUR", "USD"], new Set(), [])).toEqual(["USD"]);
  });
});

describe("conversion notes", () => {
  const daily: DailyRates = { base: "EUR", days: [{ date: "2026-11-06", rates: { USD: 1.25 } }] };

  it("say the provider could not be reached, with the date of the rates used", () => {
    expect(
      walletsTotalNotes({ currency: "EUR", missing: [], ratesDate: "2026-11-06", source: "ECB", ratesState: "loaded", stale: true }),
    ).toEqual(["Exchange rates could not be updated: rates from 6 Nov 2026 · ECB"]);
    const notes = monthConversionNotes({
      currency: "EUR",
      conv: { rates: { ...daily, incomplete: true } },
      lastDate: "2026-11-18",
      held: ["EUR", "USD"],
      missing: [],
      ratesOn: true,
      source: "ECB",
    });
    expect(notes).toEqual([
      "All wallets, converted at each day's rate · ECB",
      "Exchange rates could not be updated: rates from 6 Nov 2026 stand in for later days.",
    ]);
  });

  it("name the currencies converted at the user's own rate, and what was left out", () => {
    const notes = monthConversionNotes({
      currency: "EUR",
      conv: { rates: daily, manual: [{ currency: "KWD", base: "EUR", effectiveDate: "2026-11-01", rate: 3 }] },
      lastDate: "2026-11-18",
      held: ["EUR", "USD", "KWD", "ARS"],
      missing: ["ARS"],
      ratesOn: true,
      source: "ECB",
    });
    expect(notes).toEqual([
      "All wallets, converted at each day's rate · ECB",
      "KWD: your own rate.",
      "No exchange rate for ARS. Not included: wallets in ARS.",
    ]);
  });

  it("with rates switched off, own rates still convert", () => {
    const notes = monthConversionNotes({
      currency: "EUR",
      conv: { rates: null, manual: [{ currency: "USD", base: "EUR", effectiveDate: "2026-11-01", rate: 0.8 }] },
      lastDate: "2026-11-18",
      held: ["EUR", "USD", "RON"],
      missing: ["RON"],
      ratesOn: false,
      source: "ECB",
    });
    expect(notes).toEqual([
      "All wallets, converted at your own rates",
      "Exchange rates are switched off. Not included: wallets in RON.",
    ]);
  });

  it("ratesStateOf and ratesNeeded tell a missing target from missing wallets", () => {
    const provider = tableOn(daily, "2026-11-18");
    expect(ratesStateOf(false, provider, provider, "USD")).toBe("off");
    expect(ratesStateOf(true, null, null, "USD")).toBe("unavailable");
    expect(ratesStateOf(true, provider, provider, "KWD")).toBe("no-target");
    expect(ratesStateOf(true, provider, provider, "USD")).toBe("loaded");
    expect(ratesNeeded("KWD", ["EUR", "USD"], { rates: daily }, "2026-11-18")).toEqual(["KWD"]);
    expect(ratesNeeded("USD", ["ARS", "EUR"], { rates: daily }, "2026-11-18")).toEqual(["ARS"]);
    expect(ratesNeeded("USD", [], { rates: daily }, "2026-11-18")).toEqual([]);
  });

  it("ratesHref carries a safe way back only", () => {
    expect(ratesHref("/?month=2026-10")).toBe("/rates?returnTo=%2F%3Fmonth%3D2026-10");
    expect(ratesHref("//evil.example")).toBe("/rates");
    expect(ratesHref()).toBe("/rates");
  });
});
