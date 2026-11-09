import "server-only";
import { exchangeRatesEnabled } from "@/lib/config";
import type { RateTable } from "@/lib/fx";

// Daily reference rates from Frankfurter (https://frankfurter.dev, European Central Bank data, no API key).
// One request serves every user: the table is kept in memory and refreshed at most every REFRESH_MS. When a refresh
// fails, the last good table is kept (its `date` shows how old it is) and the next try waits RETRY_MS, so a
// provider outage never slows down every Overview load. Nothing is stored in the database.

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

/** Tests only: forget the cached table and the last failure. */
export function resetExchangeRatesCache(): void {
  cached = null;
  lastFailureAt = 0;
  inFlight = null;
}
