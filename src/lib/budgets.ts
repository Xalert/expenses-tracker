// Pure helpers for showing budgets (src/server/budgets.ts computes them): shares, the Overview's pick, the text
// lines. No React, no DB, so they are unit-tested directly.

import { formatMoney } from "./money";

/** What the helpers need of a budget's month (`BudgetProgress` has it all). */
export type BudgetFigures = {
  categoryId: number | null;
  currency: string;
  amountMinor: number;
  spentMinor: number;
  remainingMinor: number;
};

/** How far through the current month today is (`MonthBudgets.elapsed`). */
export type Elapsed = { day: number; days: number } | null;

/** Spent ÷ budget: 0 when nothing was spent, above 1 when over. */
export function budgetShare(b: Pick<BudgetFigures, "spentMinor" | "amountMinor">): number {
  return b.amountMinor > 0 ? b.spentMinor / b.amountMinor : 0;
}

/** Whole percent spent, rounded down so "100%" means the limit is reached ("<1%" never shows: 0 is 0). */
export function budgetPercent(b: Pick<BudgetFigures, "spentMinor" | "amountMinor">): number {
  return Math.floor(budgetShare(b) * 100);
}

/** True once the month's spending is above the limit (reaching it exactly is not over). */
export function isOver(b: Pick<BudgetFigures, "remainingMinor">): boolean {
  return b.remainingMinor < 0;
}

/**
 * The fill of the bar (0–1, capped) and, for the current month, where today sits on it (0–1): the "pace" tick. Above
 * the tick the month's spending is ahead of an even spread over the month.
 */
export function budgetBar(b: Pick<BudgetFigures, "spentMinor" | "amountMinor">, elapsed: Elapsed) {
  return {
    fill: Math.min(1, budgetShare(b)),
    pace: elapsed && elapsed.days > 0 ? Math.min(1, elapsed.day / elapsed.days) : null,
  };
}

/** "€120.00 of €300.00". */
export function spentOfLine(b: BudgetFigures): string {
  return `${formatMoney(b.spentMinor, b.currency)} of ${formatMoney(b.amountMinor, b.currency)}`;
}

/** "€180.00 left", "€20.00 over" or "Limit reached". */
export function leftLine(b: BudgetFigures): string {
  if (b.remainingMinor > 0) return `${formatMoney(b.remainingMinor, b.currency)} left`;
  if (b.remainingMinor === 0) return "Limit reached";
  return `${formatMoney(-b.remainingMinor, b.currency)} over`;
}

/** "40% spent · day 10 of 30" for the current month, "40% spent" for a past one. */
export function paceLine(b: BudgetFigures, elapsed: Elapsed): string {
  const spent = `${budgetPercent(b)}% spent`;
  return elapsed ? `${spent} · day ${elapsed.day} of ${elapsed.days}` : spent;
}

/** "RON not counted: no exchange rate" / "RON and USD not counted: no exchange rates"; "" when nothing is missing. */
export function missingLine(missing: readonly string[]): string {
  if (missing.length === 0) return "";
  const list = missing.length === 1 ? missing[0] : `${missing.slice(0, -1).join(", ")} and ${missing.at(-1)}`;
  return `${list} not counted: no exchange rate${missing.length === 1 ? "" : "s"}`;
}

/**
 * Of the category budgets (the overall one is left out), the `limit` closest to or over their limit: largest share
 * spent first, ties in the given order (the category order). The Overview's Budgets card.
 */
export function closestToLimit<T extends BudgetFigures>(budgets: readonly T[], limit = 3): T[] {
  return budgets
    .map((b, i) => ({ b, i }))
    .filter(({ b }) => b.categoryId !== null)
    .sort((x, y) => budgetShare(y.b) - budgetShare(x.b) || x.i - y.i)
    .slice(0, limit)
    .map(({ b }) => b);
}
