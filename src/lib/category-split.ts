// Pure helpers for the /categories "Spending split": which ramp colour each expense category gets and its share of
// the month's expenses. No React, no DB, so they are unit-tested directly.

/** Number of `--chart-ramp-*` tokens; the 6th and later categories reuse the last one. */
export const RAMP_SIZE = 5;

export type RampStep = 1 | 2 | 3 | 4 | 5;

/** Static class names, so Tailwind sees every one of them. */
export const RAMP_BG: Record<RampStep, string> = {
  1: "bg-chart-ramp-1",
  2: "bg-chart-ramp-2",
  3: "bg-chart-ramp-3",
  4: "bg-chart-ramp-4",
  5: "bg-chart-ramp-5",
};

export type SplitInput = { id: number; name: string; kind: "expense" | "income"; monthAmountMinor: number };

export type SplitSegment = {
  id: number;
  name: string;
  amountMinor: number;
  /** 1 for the largest category, then 2, 3, 4, and 5 for the fifth and every later one. */
  ramp: RampStep;
  /** Exact share of the month's expenses, 0–1 (bar widths). */
  fraction: number;
  /** Whole-number share for the legend; the segments' percents add up to exactly 100 (largest remainder). */
  percent: number;
};

export type SpendingSplit = { totalMinor: number; segments: SplitSegment[] };

/** Ramp step of the category at `rank` (0 = largest). */
export function rampFor(rank: number): RampStep {
  return Math.min(Math.max(rank, 0) + 1, RAMP_SIZE) as RampStep;
}

/**
 * The month's expense categories with spending, largest first (then by name ignoring case, then id), each with its
 * ramp colour and share. Income categories and categories with nothing this month get no segment; `totalMinor` is the
 * sum of the segments, i.e. the month's expenses in the chosen currency.
 */
export function spendingSplit(categories: readonly SplitInput[]): SpendingSplit {
  const spent = categories
    .filter((c) => c.kind === "expense" && c.monthAmountMinor > 0)
    .sort(
      (a, b) =>
        b.monthAmountMinor - a.monthAmountMinor ||
        a.name.localeCompare(b.name, "en", { sensitivity: "base" }) ||
        a.id - b.id,
    );
  const totalMinor = spent.reduce((s, c) => s + c.monthAmountMinor, 0);
  const percents = wholePercents(spent.map((c) => c.monthAmountMinor), totalMinor);
  return {
    totalMinor,
    segments: spent.map((c, i) => ({
      id: c.id,
      name: c.name,
      amountMinor: c.monthAmountMinor,
      ramp: rampFor(i),
      fraction: totalMinor > 0 ? c.monthAmountMinor / totalMinor : 0,
      percent: percents[i],
    })),
  };
}

/**
 * Whole-number percentages of `total` that add up to exactly 100 (largest-remainder rounding; on equal remainders
 * the earlier value gets the extra point). An empty list or a zero total gives zeros.
 */
export function wholePercents(values: readonly number[], total: number): number[] {
  if (values.length === 0 || total <= 0) return values.map(() => 0);
  const exact = values.map((v) => (v * 100) / total);
  const floors = exact.map(Math.floor);
  let left = 100 - floors.reduce((s, v) => s + v, 0);
  const order = exact.map((v, i) => ({ i, rem: v - floors[i] })).sort((a, b) => b.rem - a.rem || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    floors[i] += 1;
    left -= 1;
  }
  return floors;
}

/** "32%", or "<1%" for a category that spent something but rounds to 0. */
export function percentLabel(percent: number, amountMinor: number): string {
  return percent === 0 && amountMinor > 0 ? "<1%" : `${percent}%`;
}

/** How an expense row is drawn: its ramp swatch and share of the month's expenses (null for income rows). */
export type RowShare = { swatchClass: string; fraction: number; percentLabel: string } | null;

/**
 * An expense row's swatch and share, from its split segment: the same ramp colour as in the bar (by amount rank, not by
 * row order). A category with nothing this month has no segment: no colour (the row draws a hollow swatch) and 0.
 */
export function rowShare(segment: SplitSegment | undefined): NonNullable<RowShare> {
  return segment
    ? { swatchClass: RAMP_BG[segment.ramp], fraction: segment.fraction, percentLabel: percentLabel(segment.percent, segment.amountMinor) }
    : { swatchClass: "", fraction: 0, percentLabel: "0%" };
}
