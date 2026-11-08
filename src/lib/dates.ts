// Calendar dates are plain `YYYY-MM-DD` strings with no time zone; months are `YYYY-MM`.

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_RE = /^(\d{4})-(\d{2})$/;

const pad = (n: number, len = 2) => String(n).padStart(len, "0");

/** Today in the server's local time zone, as `YYYY-MM-DD`. */
export function todayISO(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Current month in the server's local time zone, as `YYYY-MM`. */
export function currentMonth(now: Date = new Date()): string {
  return todayISO(now).slice(0, 7);
}

/** True for a real calendar date in `YYYY-MM-DD` form (rejects 2025-02-30). */
export function isValidDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1900 || y > 2999 || mo < 1 || mo > 12 || d < 1) return false;
  return d <= daysInMonth(y, mo);
}

/** True for `YYYY-MM`. */
export function isValidMonth(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = MONTH_RE.exec(value);
  if (!m) return false;
  const [y, mo] = [Number(m[1]), Number(m[2])];
  return y >= 1900 && y <= 2999 && mo >= 1 && mo <= 12;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Inclusive first/last day of a `YYYY-MM` month, e.g. "2026-02" → { from: "2026-02-01", to: "2026-02-28" }. */
export function monthRange(month: string): { from: string; to: string } {
  if (!isValidMonth(month)) throw new Error(`Invalid month: ${month}`);
  const [y, m] = month.split("-").map(Number);
  return { from: `${month}-01`, to: `${month}-${pad(daysInMonth(y, m))}` };
}

/** Move a `YYYY-MM` month by `delta` months. */
export function shiftMonth(month: string, delta: number): string {
  if (!isValidMonth(month)) throw new Error(`Invalid month: ${month}`);
  const [y, m] = month.split("-").map(Number);
  const idx = y * 12 + (m - 1) + delta;
  return `${pad(Math.floor(idx / 12), 4)}-${pad((idx % 12) + 1)}`;
}

/** Shift a `YYYY-MM-DD` date by `days`. */
export function addDays(date: string, days: number): string {
  if (!isValidDate(date)) throw new Error(`Invalid date: ${date}`);
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

/**
 * Move a `YYYY-MM-DD` date by `delta` months, keeping the day of the month where it exists and clamping it to
 * the target month's last day otherwise ("2026-01-31" + 1 → "2026-02-28").
 */
export function addMonths(date: string, delta: number): string {
  if (!isValidDate(date)) throw new Error(`Invalid date: ${date}`);
  const month = shiftMonth(date.slice(0, 7), delta);
  const last = Number(monthRange(month).to.slice(8));
  return `${month}-${pad(Math.min(Number(date.slice(8)), last))}`;
}

/** Display a `YYYY-MM-DD` date, e.g. "5 Nov 2026". */
export function formatDate(date: string): string {
  if (!isValidDate(date)) return date;
  const [y, m, d] = date.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

/** Display a `YYYY-MM` month, e.g. "November 2026". */
export function formatMonth(month: string): string {
  if (!isValidMonth(month)) return month;
  const [y, m] = month.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(
    new Date(Date.UTC(y, m - 1, 1)),
  );
}

/**
 * A browser-supplied IANA time zone, checked with `Intl` (canonical spelling, e.g. "Europe/Brussels"). Missing or
 * invalid → "UTC", with `fallback` true when something was supplied but not recognised.
 */
export function resolveTimeZone(value: unknown): { timeZone: string; fallback: boolean } {
  if (typeof value !== "string" || value.trim() === "") return { timeZone: "UTC", fallback: false };
  const v = value.trim();
  if (v.length > 100) return { timeZone: "UTC", fallback: true };
  try {
    return { timeZone: new Intl.DateTimeFormat("en-US", { timeZone: v }).resolvedOptions().timeZone, fallback: false };
  } catch {
    return { timeZone: "UTC", fallback: true };
  }
}

const zoneFormatters = new Map<string, Intl.DateTimeFormat>();

/** The calendar date (`YYYY-MM-DD`) of an instant (ms since the epoch) in a valid IANA time zone. */
export function dateInTimeZone(instant: number, timeZone: string): string {
  let fmt = zoneFormatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", calendar: "gregory", numberingSystem: "latn" });
    zoneFormatters.set(timeZone, fmt);
  }
  const parts = Object.fromEntries(fmt.formatToParts(new Date(instant)).map((p) => [p.type, p.value]));
  return `${String(parts.year).padStart(4, "0")}-${parts.month}-${parts.day}`;
}
