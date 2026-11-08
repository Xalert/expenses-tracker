// Pure helpers for the wallet pages (`/wallets` cards and the `/wallets/[id]` month chart). No React, no DB.

import type { DayBar } from "@/components/charts/day-bars";
import { pickScale } from "./chart-scale";
import { formatMoney } from "./money";
import { monthLength } from "./overview";

/** Room above the highest and below the lowest balance, as a share of the month's range. */
export const BALANCE_HEADROOM = 0.15;

/**
 * The vertical range of a balance line: the lowest and highest of the opening balance and the day closings, widened
 * by `BALANCE_HEADROOM` of that range on both sides. A month in which the balance never moved gets a range around it
 * (10% of its size, at least 1 unit of 100 minor) so the line sits in the middle instead of on an edge.
 */
export function balanceRange(openingMinor: number, closings: number[]): { min: number; max: number } {
  const all = [openingMinor, ...closings];
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const span = hi - lo;
  const pad = span > 0 ? span * BALANCE_HEADROOM : Math.max(Math.abs(hi) * 0.1, 100);
  return { min: lo - pad, max: hi + pad };
}

/** True when the balance never moved: every closing equals the opening (no entries, or none yet). */
export function isFlat(openingMinor: number, closings: number[]): boolean {
  return closings.every((c) => c === openingMinor);
}

/**
 * The `points` of a small balance line (the /wallets cards): the opening balance on the left edge, then each day's
 * closing so far, spread over the whole `width` and scaled to the lowest and highest of them (`pad` px from the top
 * and bottom). A month in which the balance never moved is a straight line through the middle.
 */
export function sparklinePoints(
  openingMinor: number,
  closings: number[],
  { width = 120, height = 40, pad = 3 }: { width?: number; height?: number; pad?: number } = {},
): string {
  const values = [openingMinor, ...closings];
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo;
  const slots = Math.max(closings.length, 1);
  const x = (i: number) => +((i / slots) * width).toFixed(2);
  const y = (v: number) => +(span > 0 ? pad + (1 - (v - lo) / span) * (height - 2 * pad) : height / 2).toFixed(2);
  return values.map((v, i) => `${x(i)},${y(v)}`).join(" ");
}

/** "+€2,890.90 this month" / "-€12.00 in October" / "No change this month". */
export function changeLabel(changeMinor: number, currency: string, when = "this month"): string {
  return changeMinor === 0 ? `No change ${when}` : `${formatMoney(changeMinor, currency, { signed: true })} ${when}`;
}

/** "27 entries", "1 entry", "No entries yet". */
export function entryCountLabel(n: number): string {
  return n === 0 ? "No entries yet" : `${n} ${n === 1 ? "entry" : "entries"}`;
}

/** Share of the chart box the tallest ordinary bar reaches (the balance line uses the whole box). */
export const WALLET_BAR_SHARE = 0.6;

export type WalletDay = { date: string; inMinor: number; outMinor: number; closingMinor: number };

/**
 * The bars of a wallet's month chart: one stacked bar per calendar day — money out at the bottom (accent), money in
 * on top (income), transfers included. Days with no data yet (after day N) are `future` stubs. The scale is
 * `pickScale` over each day's in + out, so one very large day (a salary, a rent) is capped and labelled ("In
 * €3,000.00" / "Out €1,150.00", the larger side) instead of flattening the rest; `max` is then divided by
 * `WALLET_BAR_SHARE` so ordinary bars stay in the lower part of the box, under the balance line.
 */
export function walletBars(
  month: string,
  days: WalletDay[],
  currency: string,
): { bars: DayBar[]; max: number; cap?: { date: string; label: string } } {
  const length = monthLength(month);
  const byDate = new Map(days.map((d) => [d.date, d]));
  const bars: DayBar[] = [];
  for (let i = 1; i <= length; i++) {
    const date = `${month}-${String(i).padStart(2, "0")}`;
    const d = byDate.get(date);
    if (!d) {
      bars.push({ date, value: 0, tone: "future" });
      continue;
    }
    bars.push({
      date,
      value: d.inMinor + d.outMinor,
      tone: d.inMinor > 0 ? "income" : "accent",
      base: d.outMinor > 0 && d.inMinor > 0 ? { value: d.outMinor, tone: "accent" } : undefined,
    });
  }
  const scale = pickScale(bars);
  let cap: { date: string; label: string } | undefined;
  if (scale.cappedDate) {
    const d = byDate.get(scale.cappedDate);
    if (d) {
      cap = {
        date: scale.cappedDate,
        label: d.inMinor >= d.outMinor ? `In ${formatMoney(d.inMinor, currency)}` : `Out ${formatMoney(d.outMinor, currency)}`,
      };
    }
  }
  return { bars, max: scale.max / WALLET_BAR_SHARE, cap };
}
