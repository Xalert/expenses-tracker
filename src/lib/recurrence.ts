// The date maths of repeating entries (src/server/recurring.ts). Pure: no clock, no DB. Dates are `YYYY-MM-DD`.
//
// Occurrence k (k = 0, 1, 2…) of a schedule is `startDate` moved by k × `interval` days / weeks / months / years. Months
// and years are counted from `startDate` itself, never from the previous occurrence, so a rule that starts on the 31st
// lands on the last day of a shorter month and goes back to the 31st in the next long one, and 29 February (yearly)
// lands on 28 February in other years. Occurrence 0 is `startDate`; nothing falls after `endDate` (inclusive) or after
// the last date the app accepts (2999-12-31).

export const RECURRING_FREQUENCY_VALUES = ["daily", "weekly", "monthly", "yearly"] as const;
export type Frequency = (typeof RECURRING_FREQUENCY_VALUES)[number];

/** Largest "every N" the form and the service accept. */
export const MAX_RECURRING_INTERVAL = 99;

/** At most this many entries are created per rule in one run; the rest follow on the next request. */
export const MAX_OCCURRENCES_PER_RUN = 300;

const LAST_DATE = "2999-12-31";

export type Schedule = {
  frequency: Frequency;
  interval: number;
  startDate: string;
  /** Inclusive; null = no end. */
  endDate: string | null;
};

export function isFrequency(value: unknown): value is Frequency {
  return typeof value === "string" && (RECURRING_FREQUENCY_VALUES as readonly string[]).includes(value);
}

const pad = (n: number, len = 2) => String(n).padStart(len, "0");

function parts(date: string): [number, number, number] {
  const [y, m, d] = date.split("-").map(Number);
  return [y, m, d];
}

function fromUtc(ms: number): string {
  const dt = new Date(ms);
  return `${pad(dt.getUTCFullYear(), 4)}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

const DAY_MS = 86_400_000;

function dayNumber(date: string): number {
  const [y, m, d] = parts(date);
  return Date.UTC(y, m - 1, d) / DAY_MS;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** `date`'s year and month moved by `months`, its day clamped to the length of the month it lands in. */
function addMonthsClamped(date: string, months: number): string {
  const [y, m, d] = parts(date);
  const idx = y * 12 + (m - 1) + months;
  const year = Math.floor(idx / 12);
  const month = (idx % 12) + 1;
  return `${pad(year, 4)}-${pad(month)}-${pad(Math.min(d, daysInMonth(year, month)))}`;
}

/** Occurrence `k` (0 = the start date), ignoring the end date. */
export function occurrence(s: Pick<Schedule, "frequency" | "interval" | "startDate">, k: number): string {
  const step = k * s.interval;
  switch (s.frequency) {
    case "daily":
      return fromUtc((dayNumber(s.startDate) + step) * DAY_MS);
    case "weekly":
      return fromUtc((dayNumber(s.startDate) + step * 7) * DAY_MS);
    case "monthly":
      return addMonthsClamped(s.startDate, step);
    case "yearly":
      return addMonthsClamped(s.startDate, step * 12);
  }
}

/** The smallest k whose occurrence may be on or after `date` (a lower bound; the caller steps forward from it). */
function firstIndexFrom(s: Schedule, date: string): number {
  if (date <= s.startDate) return 0;
  const [sy, sm] = parts(s.startDate);
  const [y, m] = parts(date);
  let units: number;
  switch (s.frequency) {
    case "daily":
      units = dayNumber(date) - dayNumber(s.startDate);
      break;
    case "weekly":
      units = (dayNumber(date) - dayNumber(s.startDate)) / 7;
      break;
    case "monthly":
      units = (y - sy) * 12 + (m - sm);
      break;
    case "yearly":
      units = y - sy;
      break;
  }
  // One step back is always safe for the clamped month / year cases; the loop below moves forward.
  return Math.max(0, Math.floor(units / s.interval) - 1);
}

/** True when `date` is past the schedule's end (or the last date the app accepts). */
function pastEnd(s: Schedule, date: string): boolean {
  return date > LAST_DATE || (s.endDate !== null && date > s.endDate);
}

/** The first occurrence on or after `date`, or null when the schedule has ended by then. */
export function firstOccurrenceOnOrAfter(s: Schedule, date: string): string | null {
  for (let k = firstIndexFrom(s, date); ; k++) {
    const d = occurrence(s, k);
    if (pastEnd(s, d)) return null;
    if (d >= date) return d;
  }
}

/** The first occurrence strictly after `date`, or null when there is none. */
export function occurrenceAfter(s: Schedule, date: string): string | null {
  for (let k = firstIndexFrom(s, date); ; k++) {
    const d = occurrence(s, k);
    if (pastEnd(s, d)) return null;
    if (d > date) return d;
  }
}

/**
 * The occurrences from `from` (inclusive) to `to` (inclusive), at most `limit`, in order; plus the first occurrence
 * after the last one returned (null when the schedule has ended), which is where the next run continues.
 */
export function occurrencesBetween(
  s: Schedule,
  from: string,
  to: string,
  limit = MAX_OCCURRENCES_PER_RUN,
): { dates: string[]; next: string | null } {
  const dates: string[] = [];
  let next = firstOccurrenceOnOrAfter(s, from);
  while (next !== null && next <= to && dates.length < limit) {
    dates.push(next);
    next = occurrenceAfter(s, next);
  }
  return { dates, next };
}

/**
 * How many occurrences fall after `after` (exclusive) up to `to` (inclusive): the Add form's "N more entries will be
 * added for the dates up to today". Counts at most `cap` (then returns `cap`).
 */
export function countOccurrencesAfter(s: Schedule, after: string, to: string, cap = 10_000): number {
  let n = 0;
  for (let d = occurrenceAfter(s, after); d !== null && d <= to && n < cap; d = occurrenceAfter(s, d)) n++;
  return n;
}

const UNIT: Record<Frequency, [string, string]> = {
  daily: ["day", "days"],
  weekly: ["week", "weeks"],
  monthly: ["month", "months"],
  yearly: ["year", "years"],
};

/** "day" / "days", for the "every N" control. */
export function unitLabel(frequency: Frequency, interval: number): string {
  return UNIT[frequency][interval === 1 ? 0 : 1];
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

/**
 * The schedule in words, anchored on its start date: "Every day", "Every 3 days", "Every week on Monday", "Every 2
 * months on the 31st", "Every year on 29 February".
 */
export function describeSchedule(s: Pick<Schedule, "frequency" | "interval" | "startDate">): string {
  const [y, m, d] = parts(s.startDate);
  const every = s.interval === 1 ? `Every ${UNIT[s.frequency][0]}` : `Every ${s.interval} ${UNIT[s.frequency][1]}`;
  switch (s.frequency) {
    case "daily":
      return every;
    case "weekly":
      return `${every} on ${WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}`;
    case "monthly":
      return `${every} on the ${ordinal(d)}`;
    case "yearly":
      return `${every} on ${d} ${MONTHS[m - 1]}`;
  }
}
