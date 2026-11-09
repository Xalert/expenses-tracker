// Pure helpers for the Overview page (`src/app/(app)/page.tsx`): URL state, the currency fallback and the
// wording of the insight cards. No React, no DB, so they are unit-tested directly.

import { MONTH_LABELS } from "./calendar";
import { isValidCurrency } from "./currencies";
import { formatDate, isValidMonth, monthRange } from "./dates";

/** "October" for "2026-10". */
export function monthName(month: string): string {
  if (!isValidMonth(month)) return month;
  return new Intl.DateTimeFormat("en-GB", { month: "long", timeZone: "UTC" }).format(
    new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1)),
  );
}

/** "Oct" for "2026-10". */
export function monthShortName(month: string): string {
  return MONTH_LABELS[Number(month.slice(5, 7)) - 1] ?? month;
}

/** Number of days in a valid `YYYY-MM` month. */
export function monthLength(month: string): number {
  return Number(monthRange(month).to.slice(8));
}

/**
 * The currency the Overview shows. A `?currency=` that is a valid code of a wallet the user holds (archived ones
 * included) wins and is `explicit`; anything else — absent, malformed, or a currency the user has no wallet in — falls
 * back to `pickDefault()` (`pickDefaultCurrency` for the month). `null` means the user has no active wallet.
 */
export function resolveOverviewCurrency(
  requested: unknown,
  held: readonly string[],
  pickDefault: () => string | null,
): { currency: string | null; explicit: boolean } {
  if (typeof requested === "string" && isValidCurrency(requested) && held.includes(requested)) {
    return { currency: requested, explicit: true };
  }
  return { currency: pickDefault(), explicit: false };
}

/**
 * What the Overview's Wallets card shows: `all` (default) — every active wallet, with the total converted into the
 * selected currency at today's rates; `only` — just the wallets in the selected currency, nothing converted.
 */
export type OverviewView = "all" | "only";

/** `?view=only` → `only`; anything else → `all`. */
export function resolveOverviewView(requested: unknown): OverviewView {
  return requested === "only" ? "only" : "all";
}

/**
 * `/?month=…&currency=…&view=only`; the current month (`maxMonth`) leaves `month` out, a null currency leaves it
 * out, the default view `all` leaves `view` out. `basePath` serves other month + currency pages (`/categories`).
 */
export function overviewHref(
  month: string,
  currency: string | null,
  maxMonth: string,
  basePath = "/",
  view: OverviewView = "all",
): string {
  const params = new URLSearchParams();
  if (month !== maxMonth) params.set("month", month);
  if (currency) params.set("currency", currency);
  if (view === "only") params.set("view", "only");
  const qs = params.toString();
  return qs ? `${basePath}?${qs}` : basePath;
}

export type InsightTone = "default" | "income" | "expense";

/** Tone of a signed amount: income when positive, expense when negative. */
export function toneOf(minor: number): InsightTone {
  return minor > 0 ? "income" : minor < 0 ? "expense" : "default";
}

/**
 * The "Pace vs <previous month>" card: `deltaMinor` = this month − the previous month through day N (negative = less
 * spent, shown in the income colour). `sub` says what it was compared with: "less spent than by 8 Oct" for the
 * current month; for a past month "less spent over the whole month" when day N covers the whole previous month, else
 * the previous month's last compared day ("…than by 30 Oct" for November against October).
 */
export function paceSummary(opts: {
  day: number;
  thisMonthMinor: number;
  previousMonthMinor: number;
  previousMonth: string;
  isCurrentMonth: boolean;
}): { deltaMinor: number; tone: InsightTone; sub: string } {
  const deltaMinor = opts.thisMonthMinor - opts.previousMonthMinor;
  const tone: InsightTone = deltaMinor < 0 ? "income" : deltaMinor > 0 ? "expense" : "default";
  const previousLength = monthLength(opts.previousMonth);
  const comparedDay = Math.min(opts.day, previousLength);
  const wholeMonth = !opts.isCurrentMonth && comparedDay === previousLength;
  const byDay = `by ${comparedDay} ${monthShortName(opts.previousMonth)}`;
  let sub: string;
  if (deltaMinor === 0) sub = wholeMonth ? "the same over the whole month" : `the same as ${byDay}`;
  else {
    const word = deltaMinor < 0 ? "less" : "more";
    sub = wholeMonth ? `${word} spent over the whole month` : `${word} spent than ${byDay}`;
  }
  return { deltaMinor, tone, sub };
}

/** "Today", "Yesterday", "6 Nov", or "6 Nov 2025" outside the current year — for the Latest list. */
export function shortDateLabel(date: string, today: string): string {
  if (date === today) return "Today";
  const t = new Date(`${today}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() - 1);
  if (date === t.toISOString().slice(0, 10)) return "Yesterday";
  const label = `${Number(date.slice(8, 10))} ${monthShortName(date.slice(0, 7))}`;
  return date.slice(0, 4) === today.slice(0, 4) ? label : `${label} ${date.slice(0, 4)}`;
}

/**
 * The lines under the Wallets card's total. `ratesDate` is the rate table's date when a rate was used (null when no
 * wallet was converted); `missing` are the currencies left out of the total; `ratesState` says why: rates switched
 * off, not loaded, or loaded but without a rate for `currency` itself (`no-target`) or for the `missing` ones.
 */
export function walletsTotalNotes(opts: {
  currency: string;
  missing: readonly string[];
  ratesDate: string | null;
  source: string;
  ratesState: "loaded" | "no-target" | "unavailable" | "off";
}): string[] {
  const notes: string[] = [];
  if (opts.ratesDate) notes.push(`Rates of ${formatDate(opts.ratesDate)} · ${opts.source}`);
  if (opts.missing.length > 0) {
    const list = opts.missing.join(", ");
    const reason = {
      off: "Exchange rates are switched off",
      unavailable: "Exchange rates are not available now",
      "no-target": `No exchange rate for ${opts.currency}`,
      loaded: `No exchange rate for ${list}`,
    }[opts.ratesState];
    notes.push(`${reason}. Not included: wallets in ${list}.`);
  }
  return notes;
}
