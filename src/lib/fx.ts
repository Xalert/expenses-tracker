// Exchange-rate maths for the converted wallet total on Overview. Pure (no fetch, no DB), so it is unit-tested
// directly; the rates come from `src/server/exchange-rates.ts`.

import { currencyDecimals } from "./money";

/** Units of each currency for one unit of `base` (the base itself is 1). `date` is the provider's rate date. */
export type RateTable = { date: string; base: string; rates: Record<string, number> };

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
};

/** The total of `wallets` in `currency`. With no `table`, only wallets already in `currency` are counted. */
export function convertedTotal(
  wallets: readonly { id: number; currency: string; balanceMinor: number }[],
  currency: string,
  table: RateTable | null,
): ConvertedTotal {
  const converted = new Map<number, number>();
  const missing = new Set<string>();
  let totalMinor = 0;
  for (const w of wallets) {
    const value = convertMinor(w.balanceMinor, w.currency, currency, table);
    if (value === null) {
      missing.add(w.currency);
      continue;
    }
    totalMinor += value;
    if (w.currency !== currency) converted.set(w.id, value);
  }
  return { currency, totalMinor, converted, missing: [...missing].sort(), usedRates: converted.size > 0 };
}

/** One rate table per business day, sorted by date (the provider publishes none on weekends and holidays). */
export type DailyRates = { base: string; days: { date: string; rates: Record<string, number> }[] };

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
