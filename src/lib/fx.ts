// Exchange-rate maths for the converted ("All in <currency>") views: Overview, the /transactions day strip and
// /categories. Pure (no fetch, no DB), so it is unit-tested directly; the provider's rates come from
// `src/server/exchange-rates.ts`, the user's own ones from `src/server/manual-rates.ts`.

import { currencyDecimals } from "./money";

/** The provider's base: every provider rate is units of a currency for one EUR, cross rates go through it. */
export const RATES_BASE = "EUR";

/**
 * Units of each currency for one unit of `base` (the base itself is 1). `date` is the provider's rate date ("" when
 * the table holds only the user's own rates). `manual`: the currencies whose rate is the user's own, with the
 * effective date of the rate used.
 */
export type RateTable = { date: string; base: string; rates: Record<string, number>; manual?: Record<string, string> };

/** The rate of `code` against the table's base, or null when the provider does not quote it. */
function rateOf(table: RateTable, code: string): number | null {
  if (code === table.base) return 1;
  const r = table.rates[code];
  return typeof r === "number" && Number.isFinite(r) && r > 0 ? r : null;
}

/**
 * `minor` units of `from` in minor units of `to`, rounded half away from zero to `to`'s decimals. Null when either
 * currency has no rate. Same currency → the amount unchanged (no rate needed).
 */
export function convertMinor(minor: number, from: string, to: string, table: RateTable | null): number | null {
  if (from === to) return minor;
  if (!table) return null;
  const rFrom = rateOf(table, from);
  const rTo = rateOf(table, to);
  if (rFrom === null || rTo === null) return null;
  const major = (minor / 10 ** currencyDecimals(from)) * (rTo / rFrom);
  const scaled = major * 10 ** currencyDecimals(to);
  return Math.sign(scaled) * Math.round(Math.abs(scaled));
}

export type ConvertedTotal = {
  currency: string;
  /** Sum of every wallet that could be converted (each wallet rounded once, then added). */
  totalMinor: number;
  /** Converted balance per wallet id, only for wallets in another currency that could be converted. */
  converted: Map<number, number>;
  /** Currencies (sorted) whose wallets are left out of the total because there is no rate for them. */
  missing: string[];
  /** True when at least one wallet in another currency was converted. */
  usedRates: boolean;
  /** Currencies (sorted) converted with the user's own rate (the target included, when its rate is one). */
  manual: string[];
};

/** The total of `wallets` in `currency`. With no `table`, only wallets already in `currency` are counted. */
export function convertedTotal(
  wallets: readonly { id: number; currency: string; balanceMinor: number }[],
  currency: string,
  table: RateTable | null,
): ConvertedTotal {
  const converted = new Map<number, number>();
  const missing = new Set<string>();
  const manual = new Set<string>();
  let totalMinor = 0;
  for (const w of wallets) {
    const value = convertMinor(w.balanceMinor, w.currency, currency, table);
    if (value === null) {
      missing.add(w.currency);
      continue;
    }
    totalMinor += value;
    if (w.currency !== currency) {
      converted.set(w.id, value);
      for (const c of [w.currency, currency]) if (table?.manual?.[c]) manual.add(c);
    }
  }
  return {
    currency,
    totalMinor,
    converted,
    missing: [...missing].sort(),
    usedRates: converted.size > 0,
    manual: [...manual].sort(),
  };
}

/**
 * One rate table per business day, sorted by date (the provider publishes none on weekends and holidays).
 * `incomplete`: the provider could not be reached for some of the days asked for, so the latest stored day stands in
 * for them (its date is the last entry of `days`).
 */
export type DailyRates = { base: string; days: { date: string; rates: Record<string, number> }[]; incomplete?: boolean };

/**
 * The rate table that applies on `date`: the latest day on or before it (a Saturday uses Friday's rates); a date
 * before the first day uses the first day. Null when there are no days.
 */
export function tableOn(daily: DailyRates | null, date: string): RateTable | null {
  if (!daily || daily.days.length === 0) return null;
  let lo = 0;
  let hi = daily.days.length - 1;
  let found = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (daily.days[mid].date <= date) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  const day = daily.days[found];
  return { base: daily.base, date: day.date, rates: day.rates };
}

/**
 * A user's own rate: 1 `currency` = `rate` `base`, from `effectiveDate` on. The latest one on or before a date
 * applies; before the first one there is none.
 */
export type ManualRate = { currency: string; base: string; effectiveDate: string; rate: number };

/** What a converted view converts with: the provider's daily tables and the user's own rates. */
export type Conversion = { rates: DailyRates | null; manual?: readonly ManualRate[] };

/**
 * The rate table for `date`: the provider's (`tableOn`), plus the user's own rate for each currency the provider has
 * none for that day. A manual rate's `base` must itself have a rate that day (the provider's base, a provider rate,
 * or another manual rate), else it is skipped. Without provider rates the table's base is EUR and holds only manual
 * rates. Null when there is nothing at all.
 */
export function tableFor(conv: Conversion | null | undefined, date: string): RateTable | null {
  if (!conv) return null;
  const provider = tableOn(conv.rates, date);
  const latest = new Map<string, ManualRate>();
  for (const m of conv.manual ?? []) {
    if (m.effectiveDate > date || !(m.rate > 0)) continue;
    const seen = latest.get(m.currency);
    if (!seen || m.effectiveDate > seen.effectiveDate) latest.set(m.currency, m);
  }
  if (latest.size === 0) return provider;
  const base = provider?.base ?? RATES_BASE;
  const rates: Record<string, number> = { ...provider?.rates };
  const manual: Record<string, string> = {};
  let pending = [...latest.values()].filter((m) => m.currency !== base && rates[m.currency] === undefined);
  // A manual rate may be against another manual currency: resolve until nothing more resolves.
  for (let progress = true; pending.length > 0 && progress; ) {
    progress = false;
    pending = pending.filter((m) => {
      const baseRate = m.base === base ? 1 : rates[m.base];
      if (baseRate === undefined) return true;
      rates[m.currency] = baseRate / m.rate;
      manual[m.currency] = m.effectiveDate;
      progress = true;
      return false;
    });
  }
  if (!provider && Object.keys(manual).length === 0) return null;
  return { base, date: provider?.date ?? "", rates, manual };
}

/**
 * The currencies the /rates page offers a rate for: those held (archived wallets included) that the provider does
 * not quote (`quoted`: the latest provider table's currencies, its base included; empty when rates are off or none
 * were ever stored), plus any that already have a rate of the user's own. Never the provider's base. Sorted.
 */
export function currenciesNeedingRates(
  held: readonly string[],
  quoted: ReadonlySet<string>,
  withManual: readonly string[],
): string[] {
  const out = new Set<string>();
  for (const c of held) if (!quoted.has(c)) out.add(c);
  for (const c of withManual) out.add(c);
  out.delete(RATES_BASE);
  return [...out].sort();
}

/** Up to 12 digits before and 12 after the decimal point: room for 1 IDR in EUR as much as 1 EUR in IDR. */
const RATE_INPUT = /^(\d{1,12})(?:\.(\d{1,12}))?$/;

/**
 * A rate typed by the user ("3.25", "0,000087", " 1 ") as a normalised decimal string ("3.25", "0.000087", "1"), or
 * null when it is not a positive decimal number. Stored as `numeric`, so it is kept exactly as written.
 */
export function parseRateInput(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = RATE_INPUT.exec(value.trim().replace(",", "."));
  if (!m) return null;
  const whole = m[1].replace(/^0+(?=\d)/, "");
  const fraction = (m[2] ?? "").replace(/0+$/, "");
  const out = fraction ? `${whole}.${fraction}` : whole;
  return Number(out) > 0 ? out : null;
}
