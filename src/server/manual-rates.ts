import "server-only";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { manualRates, wallets } from "@/db/schema";
import { isValidCurrency } from "@/lib/currencies";
import { ServiceError } from "@/lib/errors";
import { RATES_BASE, parseRateInput, type ManualRate } from "@/lib/fx";
import { assertDate, isPgId } from "./_validate";

// A user's own exchange rates (the /rates page): "1 KWD = 3.25 EUR from 1 Nov 2026 on". They fill in where the
// provider has no rate for a currency on a date and are never used where it has one (`tableFor` in src/lib/fx.ts).
// One rate per currency and effective date: setting one again for the same date replaces it.

export type ManualRateView = {
  id: number;
  currency: string;
  base: string;
  effectiveDate: string;
  /** Exact decimal as stored ("3.25"). */
  rate: string;
};

const columns = {
  id: manualRates.id,
  currency: manualRates.currency,
  base: manualRates.base,
  effectiveDate: manualRates.effectiveDate,
  rate: manualRates.rate,
};

/** The user's rates by currency, newest effective date first. */
export async function listManualRates(userId: number): Promise<ManualRateView[]> {
  return (await getDb())
    .select(columns)
    .from(manualRates)
    .where(eq(manualRates.userId, userId))
    .orderBy(asc(manualRates.currency), desc(manualRates.effectiveDate));
}

/** The user's rates as numbers, for the conversion (`Conversion.manual`). */
export async function manualRatesFor(userId: number): Promise<ManualRate[]> {
  return (await listManualRates(userId)).map((r) => ({
    currency: r.currency,
    base: r.base,
    effectiveDate: r.effectiveDate,
    rate: Number(r.rate),
  }));
}

/** Currencies of the user's wallets, archived included. */
async function heldCurrencies(userId: number): Promise<Set<string>> {
  const rows = await (await getDb())
    .selectDistinct({ currency: wallets.currency })
    .from(wallets)
    .where(eq(wallets.userId, userId));
  return new Set(rows.map((r) => r.currency));
}

/**
 * Set "1 `currency` = `rate` `base`" from `effectiveDate` on. `currency` must be one the user holds a wallet in
 * (archived included) and not the provider's base (EUR, always 1); `base` is EUR or another held currency. `rate`
 * is a positive decimal as typed ("3.25", "0,0087"). Replaces the rate of the same currency and date.
 */
export async function setManualRate(
  userId: number,
  input: { currency: unknown; base: unknown; effectiveDate: unknown; rate: unknown },
): Promise<ManualRateView> {
  const held = await heldCurrencies(userId);
  const currency = input.currency;
  if (typeof currency !== "string" || !isValidCurrency(currency) || !held.has(currency)) {
    throw new ServiceError("VALIDATION", "Choose a currency of one of your wallets.", "currency");
  }
  if (currency === RATES_BASE) {
    throw new ServiceError("VALIDATION", `${RATES_BASE} needs no rate: it is what the other rates are counted in.`, "currency");
  }
  const base = input.base;
  if (typeof base !== "string" || !isValidCurrency(base) || (base !== RATES_BASE && !held.has(base))) {
    throw new ServiceError("VALIDATION", `Choose ${RATES_BASE} or a currency of one of your wallets.`, "base");
  }
  if (base === currency) throw new ServiceError("VALIDATION", "Choose a different currency.", "base");
  const effectiveDate = assertDate(input.effectiveDate, "effectiveDate");
  const rate = parseRateInput(input.rate);
  if (rate === null) {
    throw new ServiceError("VALIDATION", "Enter a rate greater than zero, such as 3.25.", "rate");
  }
  const [row] = await (await getDb())
    .insert(manualRates)
    .values({ userId, currency, base, effectiveDate, rate })
    .onConflictDoUpdate({
      target: [manualRates.userId, manualRates.currency, manualRates.effectiveDate],
      set: { base: sql`excluded.base`, rate: sql`excluded.rate` },
    })
    .returning(columns);
  return row;
}

/** Remove one of the user's rates; NOT_FOUND for a missing one or another user's. */
export async function deleteManualRate(userId: number, rateId: unknown): Promise<void> {
  if (!isPgId(rateId)) throw new ServiceError("NOT_FOUND", "Rate not found.");
  const deleted = await (await getDb())
    .delete(manualRates)
    .where(and(eq(manualRates.id, rateId), eq(manualRates.userId, userId)))
    .returning({ id: manualRates.id });
  if (deleted.length === 0) throw new ServiceError("NOT_FOUND", "Rate not found.");
}
