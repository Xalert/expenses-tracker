// Pure calendar helpers for the date and month pickers (no React, so they run in the node test environment).
// Dates are `YYYY-MM-DD`, months `YYYY-MM`, as everywhere else (see dates.ts). Weeks start on Monday.

import { addDays, addMonths, isValidDate, isValidMonth, shiftMonth } from "./dates";

/** Column headers of the day grid, Monday first (the app formats everything en-GB). */
export const WEEKDAY_LABELS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"] as const;

/** Full weekday names, Monday first, for the column headers' accessible names. */
export const WEEKDAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;

/** Short month names for the month grid, January first. */
export const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** Columns of the month grid (3 × 4). Up/Down in it move by this many months. */
export const MONTH_GRID_COLUMNS = 3;

/** The `YYYY-MM` month a `YYYY-MM-DD` date falls in. */
export function monthOf(date: string): string {
  return date.slice(0, 7);
}

/**
 * The same day of the month as `date`, in `month` (clamped to that month's length): where the day view lands
 * after picking a month in the month view. "2026-01-31" in "2026-02" → "2026-02-28".
 */
export function dateInMonth(date: string, month: string): string {
  if (!isValidMonth(month)) throw new Error(`Invalid month: ${month}`);
  const index = (m: string) => Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7));
  return addMonths(date, index(month) - index(monthOf(date)));
}

/** Day of the week of a date, 0 = Monday … 6 = Sunday. */
export function weekdayIndex(date: string): number {
  if (!isValidDate(date)) throw new Error(`Invalid date: ${date}`);
  const [y, m, d] = date.split("-").map(Number);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

/**
 * The day grid of a month: always 6 weeks × 7 dates, Monday first, starting with the Monday on or before the
 * 1st, so leading and trailing days of the neighbouring months fill the gaps.
 */
export function calendarWeeks(month: string): string[][] {
  if (!isValidMonth(month)) throw new Error(`Invalid month: ${month}`);
  const first = `${month}-01`;
  const start = addDays(first, -weekdayIndex(first));
  return Array.from({ length: 6 }, (_, w) => Array.from({ length: 7 }, (_, d) => addDays(start, w * 7 + d)));
}

/**
 * Where a key press moves the focused day in the day grid: arrows by a day / a week, Home / End to the start /
 * end of the week, PageUp / PageDown by a month (with Shift by a year, the day clamped to the month's length).
 * `null` for any other key, or when the result falls outside the supported years (1900–2999).
 */
export function moveDate(date: string, key: string, shift = false): string | null {
  if (!isValidDate(date)) return null;
  try {
    let next: string;
    switch (key) {
      case "ArrowLeft":
        next = addDays(date, -1);
        break;
      case "ArrowRight":
        next = addDays(date, 1);
        break;
      case "ArrowUp":
        next = addDays(date, -7);
        break;
      case "ArrowDown":
        next = addDays(date, 7);
        break;
      case "Home":
        next = addDays(date, -weekdayIndex(date));
        break;
      case "End":
        next = addDays(date, 6 - weekdayIndex(date));
        break;
      case "PageUp":
        next = addMonths(date, shift ? -12 : -1);
        break;
      case "PageDown":
        next = addMonths(date, shift ? 12 : 1);
        break;
      default:
        return null;
    }
    return isValidDate(next) ? next : null;
  } catch {
    return null;
  }
}

/**
 * Where a key press moves the focused month in the month grid (3 columns × 4 rows): Left / Right by a month
 * (wrapping into the neighbouring years), Up / Down by a row, Home / End to January / December of the same year,
 * PageUp / PageDown by a year. `null` for any other key or outside the supported years.
 */
export function moveMonth(month: string, key: string): string | null {
  if (!isValidMonth(month)) return null;
  const m = Number(month.slice(5));
  const delta: Record<string, number> = {
    ArrowLeft: -1,
    ArrowRight: 1,
    ArrowUp: -MONTH_GRID_COLUMNS,
    ArrowDown: MONTH_GRID_COLUMNS,
    Home: 1 - m,
    End: 12 - m,
    PageUp: -12,
    PageDown: 12,
  };
  if (!(key in delta)) return null;
  const next = shiftMonth(month, delta[key]);
  return isValidMonth(next) ? next : null;
}

/** Clamp a date or month string (same format for all three) into `[min, max]`; either bound may be omitted. */
export function clampTo(value: string, min?: string, max?: string): string {
  if (min && value < min) return min;
  if (max && value > max) return max;
  return value;
}

const longDate = new Intl.DateTimeFormat("en-GB", {
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

/** The full spoken form of a date for the day buttons' `aria-label`, e.g. "Thursday 5 November 2026". */
export function dateLabel(date: string): string {
  if (!isValidDate(date)) return date;
  const [y, m, d] = date.split("-").map(Number);
  return longDate.format(new Date(Date.UTC(y, m - 1, d)));
}
