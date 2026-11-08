// Pure scale helpers for the hand-built charts (per-day bars + running-total lines). No React, no DB.

/** A single day dwarfs the rest when it is more than this many times the median of the non-zero days. */
export const CAP_FACTOR = 3;
/** When a day is capped, the other bars are scaled to the largest of them times this (room above the tallest). */
export const CAP_HEADROOM = 1.2;

/** Median of a list of numbers (the mean of the middle two for an even count); 0 for an empty list. */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * The scale for a row of per-day bars. Normally `max` is the largest value. One very large day — more than
 * `CAP_FACTOR` × the median of the non-zero days, and taller than the next day × `CAP_HEADROOM` (otherwise capping
 * would change nothing) — is capped instead: it is drawn at full height (`cappedDate`, the earliest on a tie) and
 * `max` becomes the largest other day × `CAP_HEADROOM`, so the ordinary days stay readable. `max` is 0 when every
 * value is 0.
 */
export function pickScale(days: { date: string; value: number }[]): { max: number; cappedDate?: string } {
  const nonZero = days.filter((d) => d.value > 0);
  if (nonZero.length === 0) return { max: 0 };
  let top = nonZero[0];
  for (const d of nonZero) if (d.value > top.value) top = d;
  const rest = nonZero.filter((d) => d !== top);
  const second = rest.reduce((m, d) => Math.max(m, d.value), 0);
  if (second > 0 && top.value > CAP_FACTOR * median(nonZero.map((d) => d.value)) && top.value > second * CAP_HEADROOM) {
    return { max: second * CAP_HEADROOM, cappedDate: top.date };
  }
  return { max: top.value };
}

/** Running totals: `[1, 2, 3]` → `[1, 3, 6]`. */
export function cumulative(values: number[]): number[] {
  let sum = 0;
  return values.map((v) => (sum += v));
}

export type AxisTick = { day: number; label: string };

/**
 * Axis labels under a month chart: "1 Nov", 15, 22 and the last day, plus "<N> · today" for the current month
 * (`today` = day N, else null). A fixed label closer than `MIN_GAP` days to today's is dropped; when that drops the
 * first one, today's label carries the month instead ("2 Nov · today").
 */
export function axisTicks(monthShort: string, length: number, today: number | null): AxisTick[] {
  const MIN_GAP = 4;
  const fixed = [1, 15, 22, length].filter((d, i, all) => d <= length && all.indexOf(d) === i);
  const ticks: AxisTick[] = [];
  let firstDropped = false;
  for (const day of fixed) {
    if (today !== null && day !== today && Math.abs(day - today) < MIN_GAP) {
      if (day === 1) firstDropped = true;
      continue;
    }
    if (today !== null && day === today) continue;
    ticks.push({ day, label: day === 1 ? `1 ${monthShort}` : String(day) });
  }
  if (today !== null) {
    const withMonth = today === 1 || firstDropped;
    ticks.push({ day: today, label: `${today}${withMonth ? ` ${monthShort}` : ""} · today` });
  }
  return ticks.sort((a, b) => a.day - b.day);
}
