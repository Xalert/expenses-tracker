import "server-only";
import { exchangeRatesEnabled } from "@/lib/config";
import { addDays, todayISO } from "@/lib/dates";
import type { DailyRates, RateTable } from "@/lib/fx";

// Daily reference rates from Frankfurter (https://frankfurter.dev, European Central Bank data, no API key).
// One request serves every user: the latest table is kept in memory and refreshed at most every REFRESH_MS. When a
// refresh fails, the last good table is kept (its `date` shows how old it is) and the next try waits RETRY_MS, so a
// provider outage never slows down every Overview load. Nothing is stored in the database. `getDailyRates` does the
// same for a date range (the month charts): a range that ends before today never changes and is kept until it is
// pushed out of a small cache.

export const RATES_URL = "https://api.frankfurter.dev/v1/latest?base=EUR";
export const RATES_SOURCE = "European Central Bank, via Frankfurter";
const REFRESH_MS = 6 * 60 * 60 * 1000;
const RETRY_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 4000;

let cached: { table: RateTable; fetchedAt: number } | null = null;
let lastFailureAt = 0;
let inFlight: Promise<RateTable | null> | null = null;

/** Parses a Frankfurter `latest` response; null when it is not one. */
export function parseRatesResponse(body: unknown): RateTable | null {
  if (!body || typeof body !== "object") return null;
  const { base, date, rates } = body as Record<string, unknown>;
  if (typeof base !== "string" || !/^[A-Z]{3}$/.test(base)) return null;
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  if (!rates || typeof rates !== "object") return null;
  const clean: Record<string, number> = {};
  for (const [code, value] of Object.entries(rates as Record<string, unknown>)) {
    if (/^[A-Z]{3}$/.test(code) && typeof value === "number" && Number.isFinite(value) && value > 0) {
      clean[code] = value;
    }
  }
  return { base, date, rates: clean };
}

async function fetchRates(now: number): Promise<RateTable | null> {
  try {
    const res = await fetch(RATES_URL, {
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const table = parseRatesResponse(await res.json());
    if (!table) throw new Error("unexpected response");
    cached = { table, fetchedAt: now };
    return table;
  } catch (err) {
    lastFailureAt = now;
    console.warn(`[exchange-rates] could not load rates from ${RATES_URL}: ${(err as Error).message}`);
    return cached?.table ?? null;
  }
}

/**
 * Today's rate table, or null when rates are switched off (`EXCHANGE_RATES=false`) or none could be loaded yet.
 * Never throws.
 */
export async function getExchangeRates(now: number = Date.now()): Promise<RateTable | null> {
  if (!exchangeRatesEnabled()) return null;
  if (cached && now - cached.fetchedAt < REFRESH_MS) return cached.table;
  if (now - lastFailureAt < RETRY_MS) return cached?.table ?? null;
  inFlight ??= fetchRates(now).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

export const RATES_BASE_URL = "https://api.frankfurter.dev/v1/";
/** Days fetched before `from`, so that a range starting on a weekend or holiday has an earlier rate to use. */
const LOOKBACK_DAYS = 7;
const MAX_RANGES = 24;

/** Parses a Frankfurter time-series response (`/v1/<from>..<to>`); null when it is not one. */
export function parseSeriesResponse(body: unknown): DailyRates | null {
  if (!body || typeof body !== "object") return null;
  const { base, rates } = body as Record<string, unknown>;
  if (typeof base !== "string" || !/^[A-Z]{3}$/.test(base)) return null;
  if (!rates || typeof rates !== "object") return null;
  const days: DailyRates["days"] = [];
  for (const [date, table] of Object.entries(rates as Record<string, unknown>)) {
    const parsed = parseRatesResponse({ base, date, rates: table });
    if (parsed) days.push({ date, rates: parsed.rates });
  }
  days.sort((a, b) => (a.date < b.date ? -1 : 1));
  return { base, days };
}

type RangeEntry = { daily: DailyRates | null; fetchedAt: number; failedAt: number; final: boolean };
const ranges = new Map<string, RangeEntry>();
const rangesInFlight = new Map<string, Promise<DailyRates | null>>();

async function fetchSeries(key: string, url: string, final: boolean, now: number): Promise<DailyRates | null> {
  const previous = ranges.get(key);
  try {
    const res = await fetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const daily = parseSeriesResponse(await res.json());
    if (!daily || daily.days.length === 0) throw new Error("unexpected response");
    ranges.delete(key);
    ranges.set(key, { daily, fetchedAt: now, failedAt: 0, final });
    while (ranges.size > MAX_RANGES) ranges.delete(ranges.keys().next().value!);
    return daily;
  } catch (err) {
    console.warn(`[exchange-rates] could not load rates from ${url}: ${(err as Error).message}`);
    ranges.set(key, { daily: previous?.daily ?? null, fetchedAt: previous?.fetchedAt ?? 0, failedAt: now, final });
    return previous?.daily ?? null;
  }
}

/**
 * The provider's rate table of every business day in [from, to] (plus up to a week before `from`; `to` is capped
 * at today), for converting a day's amounts at that day's rate (`tableOn`). Null when rates are switched off or
 * nothing could be loaded. Never throws.
 */
export async function getDailyRates(from: string, to: string, now: number = Date.now()): Promise<DailyRates | null> {
  if (!exchangeRatesEnabled()) return null;
  const today = todayISO(new Date(now));
  const end = to > today ? today : to;
  const start = addDays(from, -LOOKBACK_DAYS);
  if (start > end) return null;
  const key = `${start}..${end}`;
  const entry = ranges.get(key);
  if (entry?.daily && (entry.final || now - entry.fetchedAt < REFRESH_MS)) return entry.daily;
  if (entry && now - entry.failedAt < RETRY_MS) return entry.daily;
  let pending = rangesInFlight.get(key);
  if (!pending) {
    pending = fetchSeries(key, `${RATES_BASE_URL}${key}?base=EUR`, end < today, now).finally(() =>
      rangesInFlight.delete(key),
    );
    rangesInFlight.set(key, pending);
  }
  return pending;
}

/** Tests only: forget the cached tables and the last failures. */
export function resetExchangeRatesCache(): void {
  cached = null;
  lastFailureAt = 0;
  inFlight = null;
  ranges.clear();
  rangesInFlight.clear();
}
