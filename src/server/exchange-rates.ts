import "server-only";
import { and, asc, desc, eq, gte, lt, lte, max, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { exchangeRateDays, exchangeRates } from "@/db/schema";
import { exchangeRatesEnabled } from "@/lib/config";
import { addDays, todayISO } from "@/lib/dates";
import { RATES_BASE, type Conversion, type DailyRates, type RateTable } from "@/lib/fx";
import { manualRatesFor } from "./manual-rates";

// Daily reference rates from Frankfurter (https://frankfurter.dev, European Central Bank data, no API key), kept in
// the database for every user and every process: `exchange_rates` holds each published day's rates,
// `exchange_rate_days` each calendar day the provider has been asked about (so a weekend or holiday is not asked
// about again). A request looks up the database first and fetches only the days it has no current answer for; a
// day's answer is final once it was fetched after that day ended (UTC), else it is refreshed after REFRESH_MS.
// When the provider cannot be reached, the most recent stored day on or before each date stands in, the result is
// marked `incomplete` (the notes say "rates from <date>"), and the next try waits RETRY_MS (in memory, per process),
// so an outage never slows down every page load. Only rates are stored, never a converted amount.

export const RATES_BASE_URL = "https://api.frankfurter.dev/v1/";
export const RATES_SOURCE = "European Central Bank, via Frankfurter";
const REFRESH_MS = 6 * 60 * 60 * 1000;
const RETRY_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 4000;
/** Days fetched before `from`, so that a range starting on a weekend or holiday has an earlier rate to use. */
const LOOKBACK_DAYS = 7;
const INSERT_CHUNK = 2000;

let lastFailureAt = 0;
const inFlight = new Map<string, Promise<boolean>>();

/** Parses one Frankfurter day (`latest`, or one entry of a time series); null when it is not one. */
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

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Every calendar date from `from` to `to`, both included. */
function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** True when [from, to] has a Monday–Friday (a range of only weekend days may rightly come back empty). */
function hasWeekday(from: string, to: string): boolean {
  return datesBetween(from, to).some((d) => {
    const wd = new Date(`${d}T00:00:00Z`).getUTCDay();
    return wd !== 0 && wd !== 6;
  });
}

/** Calendar days of [from, to] the database has no current answer for, in order. */
async function daysToFetch(from: string, to: string, now: number): Promise<string[]> {
  const rows = await (await getDb())
    .select({ date: exchangeRateDays.date, fetchedAt: exchangeRateDays.fetchedAt })
    .from(exchangeRateDays)
    .where(and(eq(exchangeRateDays.base, RATES_BASE), gte(exchangeRateDays.date, from), lte(exchangeRateDays.date, to)));
  const fetched = new Map(rows.map((r) => [r.date, r.fetchedAt.getTime()]));
  return datesBetween(from, to).filter((d) => {
    const at = fetched.get(d);
    return at === undefined || (utcDay(at) <= d && now - at >= REFRESH_MS);
  });
}

/** Fetches [from, to] from the provider and stores it (rates and the days asked about) in one transaction. */
async function fetchAndStore(from: string, to: string, now: number): Promise<boolean> {
  const url = `${RATES_BASE_URL}${from}..${to}?base=${RATES_BASE}`;
  try {
    const res = await fetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const daily = parseSeriesResponse(await res.json());
    if (!daily || daily.base !== RATES_BASE) throw new Error("unexpected response");
    if (daily.days.length === 0 && hasWeekday(from, to)) throw new Error("no rates in the response");
    const fetchedAt = new Date(now);
    const rows = daily.days.flatMap((d) =>
      Object.entries(d.rates).map(([quote, rate]) => ({
        base: RATES_BASE,
        quote,
        rateDate: d.date,
        // The shortest decimal that reads back as the same number: what the provider's JSON said.
        rate: String(rate),
        fetchedAt,
      })),
    );
    const days = datesBetween(from, to).map((date) => ({ base: RATES_BASE, date, fetchedAt }));
    await (await getDb()).transaction(async (tx) => {
      for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
        await tx
          .insert(exchangeRates)
          .values(rows.slice(i, i + INSERT_CHUNK))
          .onConflictDoUpdate({
            target: [exchangeRates.base, exchangeRates.quote, exchangeRates.rateDate],
            set: { rate: sql`excluded.rate`, fetchedAt: sql`excluded.fetched_at` },
          });
      }
      await tx
        .insert(exchangeRateDays)
        .values(days)
        .onConflictDoUpdate({
          target: [exchangeRateDays.base, exchangeRateDays.date],
          set: { fetchedAt: sql`excluded.fetched_at` },
        });
    });
    return true;
  } catch (err) {
    lastFailureAt = now;
    console.warn(`[exchange-rates] could not load rates from ${url}: ${(err as Error).message}`);
    return false;
  }
}

/** The stored days of [from, to], plus the latest stored day before `from` (the stand-in during an outage). */
async function readStored(from: string, to: string): Promise<DailyRates | null> {
  const db = await getDb();
  const [before] = await db
    .select({ date: max(exchangeRates.rateDate) })
    .from(exchangeRates)
    .where(and(eq(exchangeRates.base, RATES_BASE), lt(exchangeRates.rateDate, from)));
  const start = before?.date ?? from;
  const rows = await db
    .select({ date: exchangeRates.rateDate, quote: exchangeRates.quote, rate: exchangeRates.rate })
    .from(exchangeRates)
    .where(and(eq(exchangeRates.base, RATES_BASE), gte(exchangeRates.rateDate, start), lte(exchangeRates.rateDate, to)))
    .orderBy(asc(exchangeRates.rateDate));
  if (rows.length === 0) return null;
  const days: DailyRates["days"] = [];
  for (const r of rows) {
    let day = days.at(-1);
    if (day?.date !== r.date) days.push((day = { date: r.date, rates: {} }));
    day.rates[r.quote] = Number(r.rate);
  }
  return { base: RATES_BASE, days };
}

/**
 * The provider's rate table of every business day in [from, to] (plus up to a week before `from`; `to` is capped at
 * today), for converting a day's amounts at that day's rate (`tableOn`). From the database, fetching only what it is
 * missing; `incomplete` when part of it could not be fetched now. Null when rates are switched off or nothing is
 * stored. Never throws for a provider failure.
 */
export async function getDailyRates(from: string, to: string, now: number = Date.now()): Promise<DailyRates | null> {
  if (!exchangeRatesEnabled()) return null;
  const today = todayISO(new Date(now));
  const end = to > today ? today : to;
  const start = addDays(from, -LOOKBACK_DAYS);
  if (start > end) return null;
  const missing = await daysToFetch(start, end, now);
  let incomplete = false;
  if (missing.length > 0) {
    if (now - lastFailureAt < RETRY_MS) incomplete = true;
    else {
      const key = `${missing[0]}..${missing.at(-1)}`;
      let pending = inFlight.get(key);
      if (!pending) {
        pending = fetchAndStore(missing[0], missing.at(-1)!, now).finally(() => inFlight.delete(key));
        inFlight.set(key, pending);
      }
      incomplete = !(await pending);
    }
  }
  const daily = await readStored(start, end);
  return daily && incomplete ? { ...daily, incomplete } : daily;
}

/**
 * Everything a converted view of [from, to] needs for `userId`: the provider's daily tables and the user's own rates
 * (which apply also when the provider is switched off or unreachable).
 */
export async function getConversion(
  userId: number,
  from: string,
  to: string,
  now: number = Date.now(),
): Promise<Conversion> {
  return { rates: await getDailyRates(from, to, now), manual: await manualRatesFor(userId) };
}

/**
 * The currencies the provider quotes, from its latest stored day on or before today (fetching today's when it is
 * due), the base included; null when rates are switched off or none are stored.
 */
export async function getProviderCurrencies(now: number = Date.now()): Promise<{ date: string; currencies: Set<string> } | null> {
  if (!exchangeRatesEnabled()) return null;
  const today = todayISO(new Date(now));
  await getDailyRates(today, today, now);
  const db = await getDb();
  const [latest] = await db
    .select({ date: exchangeRates.rateDate })
    .from(exchangeRates)
    .where(and(eq(exchangeRates.base, RATES_BASE), lte(exchangeRates.rateDate, today)))
    .orderBy(desc(exchangeRates.rateDate))
    .limit(1);
  if (!latest) return null;
  const rows = await db
    .select({ quote: exchangeRates.quote })
    .from(exchangeRates)
    .where(and(eq(exchangeRates.base, RATES_BASE), eq(exchangeRates.rateDate, latest.date)));
  return { date: latest.date, currencies: new Set([RATES_BASE, ...rows.map((r) => r.quote)]) };
}

/** Tests only: forget the last failure and the requests in flight (the stored rates live in the database). */
export function resetExchangeRatesCache(): void {
  lastFailureAt = 0;
  inFlight.clear();
}
