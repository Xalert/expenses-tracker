// The /transactions amount range (`?min=` / `?max=`): pure rules shared by the list, the services and the CSV export.
//
// A bound is in major units ("12.50", "12,5", "1 000") and is compared with each entry in that entry's own currency:
// `amount_minor` against the bound scaled by the currency's decimals (JPY 0, EUR 2, KWD 3). Nothing is converted.
// Bounds are inclusive. A bound with more decimals than a currency has rounds inwards for that currency (min 12.5
// matches ¥13 and up, max 12.5 matches up to ¥12), which is exactly "amount ≥ 12.5" / "amount ≤ 12.5".

import { splitDecimalInput } from "./money";

/** The most decimals a bound may have: the most any currency has (KWD, BHD, …). */
export const MAX_BOUND_DECIMALS = 3;
/** Longest bound text kept from the URL. */
export const MAX_BOUND_LENGTH = 32;

/** A valid bound: its value × 10^MAX_BOUND_DECIMALS, exact. */
export type AmountBound = { scaled: bigint; text: string };

export type AmountRange = { min?: AmountBound; max?: AmountBound };

export type AmountRangeErrors = { min?: string; max?: string };

const LIMIT = BigInt(Number.MAX_SAFE_INTEGER);

/** One bound, or the message for its field. Empty / blank input is "no bound" (`null`). */
export function parseAmountBound(raw: string | undefined, side: "min" | "max"): AmountBound | null | { error: string } {
  const text = raw?.trim() ?? "";
  if (text === "") return null;
  const word = side === "min" ? "minimum" : "maximum";
  const d = text.length > MAX_BOUND_LENGTH ? null : splitDecimalInput(text);
  if (!d) return { error: `Enter the ${word} as an amount, like 12.50.` };
  if (d.negative && /[1-9]/.test(d.whole + d.frac)) return { error: `The ${word} cannot be negative.` };
  if (d.frac.length > MAX_BOUND_DECIMALS) {
    return { error: `Enter the ${word} with at most ${MAX_BOUND_DECIMALS} decimals.` };
  }
  const scaled = BigInt(d.whole + d.frac.padEnd(MAX_BOUND_DECIMALS, "0"));
  if (scaled > LIMIT) return { error: `That ${word} is too large.` };
  return { scaled, text };
}

const isError = (v: AmountBound | null | { error: string }): v is { error: string } => v !== null && "error" in v;

/**
 * Both bounds: the valid ones and the errors (field `min` / `max`). A maximum below the minimum is an error on `max`
 * (nothing could match). An invalid bound is left out of `range`.
 */
export function parseAmountRange(min: string | undefined, max: string | undefined): { range: AmountRange; errors: AmountRangeErrors } {
  const lo = parseAmountBound(min, "min");
  const hi = parseAmountBound(max, "max");
  const range: AmountRange = {};
  const errors: AmountRangeErrors = {};
  if (isError(lo)) errors.min = lo.error;
  else if (lo) range.min = lo;
  if (isError(hi)) errors.max = hi.error;
  else if (hi) {
    if (range.min && hi.scaled < range.min.scaled) errors.max = "The maximum is below the minimum.";
    else range.max = hi;
  }
  return { range, errors };
}

/**
 * The bound in minor units of a currency with `decimals` decimals: rounded up for a minimum, down for a maximum (so
 * an integer amount compares exactly as the decimal bound would).
 */
export function boundToMinor(bound: AmountBound, decimals: number, side: "min" | "max"): number {
  const shift = MAX_BOUND_DECIMALS - decimals;
  if (shift <= 0) return Number(bound.scaled * BigInt(10) ** BigInt(-shift));
  const unit = BigInt(10) ** BigInt(shift);
  const q = bound.scaled / unit;
  const exact = q * unit === bound.scaled;
  return Number(side === "min" && !exact ? q + BigInt(1) : q);
}

/** The amount chip's text: "10 – 50", "≥ 10", "≤ 50" (the bounds as typed); undefined without a bound. */
export function amountRangeLabel(min: string | undefined, max: string | undefined): string | undefined {
  const lo = min?.trim();
  const hi = max?.trim();
  if (lo && hi) return `${lo} – ${hi}`;
  if (lo) return `≥ ${lo}`;
  if (hi) return `≤ ${hi}`;
  return undefined;
}
