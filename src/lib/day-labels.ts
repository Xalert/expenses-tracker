// Pure helpers for the day-grouped transaction list (no React, no DB).

import { MONTH_LABELS, WEEKDAY_NAMES, weekdayIndex } from "./calendar";
import { addDays, isValidDate } from "./dates";
import { formatMoney } from "./money";
import { monthName } from "./overview";

const SHORT_WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

/**
 * A day header: "Today · Sunday 8", "Yesterday · Saturday 7", "Tuesday 3" (in today's month), "Tue 3 Nov" (in
 * today's year), "Tue 3 Nov 2025" (another year). `today` is the user's (`todayInZone`).
 */
export function dayHeaderLabel(date: string, today: string): string {
  if (!isValidDate(date)) return date;
  const day = Number(date.slice(8, 10));
  const weekday = weekdayIndex(date);
  const long = `${WEEKDAY_NAMES[weekday]} ${day}`;
  if (date === today) return `Today · ${long}`;
  if (date === addDays(today, -1)) return `Yesterday · ${long}`;
  if (date.slice(0, 7) === today.slice(0, 7)) return long;
  const short = `${SHORT_WEEKDAYS[weekday]} ${day} ${MONTH_LABELS[Number(date.slice(5, 7)) - 1]}`;
  return date.slice(0, 4) === today.slice(0, 4) ? short : `${short} ${date.slice(0, 4)}`;
}

/** A day's net per currency, signed: "-€39.21 · +lei 1,490.00" (a zero net shows unsigned, "€0.00"). */
export function dayNetLabel(totals: { currency: string; netMinor: number }[]): string {
  return totals.map((t) => formatMoney(t.netMinor, t.currency, { signed: true })).join(" · ");
}

/** Group date-ordered items by their `date`, keeping the order. */
export function groupByDate<T extends { date: string }>(items: T[]): { date: string; items: T[] }[] {
  const groups: { date: string; items: T[] }[] = [];
  for (const item of items) {
    const last = groups.at(-1);
    if (last && last.date === item.date) last.items.push(item);
    else groups.push({ date: item.date, items: [item] });
  }
  return groups;
}

/** "3 November" for a day bar's label. */
export function dayMonthLabel(date: string): string {
  return `${Number(date.slice(8, 10))} ${monthName(date.slice(0, 7))}`;
}

/** A wallet page's day header: "Balance after €1,234.56" (the wallet's balance at the end of that day). */
export function balanceAfterLabel(closingMinor: number, currency: string, { projected = false } = {}): string {
  return `Balance after ${formatMoney(closingMinor, currency)}${projected ? " · projected" : ""}`;
}

/**
 * The right side of a wallet page's day header: the balance after that day from `getWalletMonth().days`, or for a
 * day after today the projected one from `projectedDays` ("Balance after €1,234.56 · projected"). Null otherwise.
 */
export function walletDayAside(
  date: string,
  closings: ReadonlyMap<string, number>,
  projected: ReadonlyMap<string, number>,
  currency: string,
): string | null {
  const closing = closings.get(date);
  if (closing !== undefined) return balanceAfterLabel(closing, currency);
  const ahead = projected.get(date);
  return ahead === undefined ? null : balanceAfterLabel(ahead, currency, { projected: true });
}
