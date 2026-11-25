// Pure helpers for /reports (the year view): the year in the URL, its links, the comparison wording and the compact
// amounts of the category table. No React, no DB, so they are unit-tested directly.

import { MONTH_LABELS } from "./calendar";
import { addMonths, formatDate } from "./dates";
import { currencyDecimals, formatMoney } from "./money";
import type { OverviewView } from "./overview";

/** The years /reports accepts: four digits, 1900 or later (the date pickers' range starts there too). */
export function isValidYear(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}$/.test(value) && Number(value) >= 1900;
}

/**
 * The year shown: a valid `?year=` up to the current one (`maxYear`, the user's today); a later year is clamped to it,
 * anything else is the current year.
 */
export function resolveReportYear(requested: unknown, maxYear: string): string {
  if (!isValidYear(requested)) return maxYear;
  return requested > maxYear ? maxYear : requested;
}

/** The twelve `YYYY-MM` months of a year. */
export function yearMonths(year: string): string[] {
  return MONTH_LABELS.map((_, i) => `${year}-${String(i + 1).padStart(2, "0")}`);
}

/**
 * `/reports?year=…&currency=…&view=only`; the current year (`maxYear`) leaves `year` out, a null currency leaves it
 * out, the default view `all` leaves `view` out (the same shape as `overviewHref`).
 */
export function reportsHref(year: string, currency: string | null, maxYear: string, view: OverviewView = "all"): string {
  const params = new URLSearchParams();
  if (year !== maxYear) params.set("year", year);
  if (currency) params.set("currency", currency);
  if (view === "only") params.set("view", "only");
  const qs = params.toString();
  return qs ? `/reports?${qs}` : "/reports";
}

/**
 * The day the year's comparison runs to: `today` for the current year (the previous year then runs to the same date a
 * year earlier, 29 Feb → 28 Feb), null for a past year (whole years are compared).
 */
export function comparisonThrough(year: string, today: string): { current: string; previous: string } | null {
  if (year !== today.slice(0, 4)) return null;
  return { current: today, previous: addMonths(today, -12) };
}

/** "1 Jan – 25 Nov" for a date of the year, the year left out. */
export function periodLabel(through: string): string {
  const end = formatDate(through).replace(/ \d{4}$/, "");
  return end === "1 Jan" ? "1 Jan" : `1 Jan – ${end}`;
}

/**
 * Change from `previous` to `current` in whole percent, or null when there is nothing to compare with (previous 0).
 * Rounded half away from zero.
 */
export function percentChange(current: number, previous: number): number | null {
  if (previous === 0) return null;
  const p = ((current - previous) / Math.abs(previous)) * 100;
  return Math.sign(p) * Math.round(Math.abs(p));
}

/**
 * The line under a year total: "vs €9,100.00 in 2025 · +12%" (net: "vs +€900.00 in 2025", no percentage, a change of
 * a net amount reads badly), "nothing in 2025" when the previous figure is 0. `current` is the figure compared
 * (through the same date for the current year); when it differs from the shown `total` (entries dated after today)
 * the line says so: "€8,800.00 by 25 Nov vs …".
 */
export function comparisonSub(opts: {
  measure: "income" | "expense" | "net";
  total: number;
  current: number;
  previous: number;
  previousYear: string;
  currency: string;
  /** The compared period's last day this year (the current year), else null. */
  through: string | null;
  /** The previous period had no income and no expense at all (the net then reads "nothing in 2025" too). */
  previousEmpty?: boolean;
}): string {
  const signed = opts.measure === "net";
  const money = (m: number) => formatMoney(m, opts.currency, { signed });
  const head =
    opts.through && opts.current !== opts.total
      ? `${money(opts.current)} by ${formatDate(opts.through).replace(/ \d{4}$/, "")} `
      : "";
  if (opts.previous === 0 && (opts.measure !== "net" || opts.previousEmpty)) return `${head}${head ? "· " : ""}nothing in ${opts.previousYear}`;
  const pct = signed ? null : percentChange(opts.current, opts.previous);
  const pctText = pct === null ? "" : ` · ${pct > 0 ? "+" : pct < 0 ? "−" : "±"}${Math.abs(pct)}%`;
  return `${head}vs ${money(opts.previous)} in ${opts.previousYear}${pctText}`;
}

/**
 * A table cell's amount in whole units of the currency, grouped, no symbol ("1,235" for €1,234.56; "¥1,500"
 * → "1,500"). Rounded half away from zero; 0 stays "0". The table's caption names the currency, the cell's link label
 * has the exact amount.
 */
export function wholeUnits(minor: number, currency: string): string {
  const major = minor / 10 ** currencyDecimals(currency);
  const rounded = Math.sign(major) * Math.round(Math.abs(major));
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(rounded === 0 ? 0 : rounded);
}

/** A short money label for the chart ("€1.2K", "-€350", "¥15K"): en-US compact notation with the narrow symbol. */
export function compactMoney(minor: number, currency: string, opts: { signed?: boolean } = {}): string {
  const major = minor / 10 ** currencyDecimals(currency);
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      currencyDisplay: "narrowSymbol",
      notation: "compact",
      maximumFractionDigits: Math.abs(major) < 1000 ? 0 : 1,
      signDisplay: opts.signed ? "exceptZero" : "auto",
    }).format(major);
  } catch {
    return formatMoney(minor, currency, opts);
  }
}
