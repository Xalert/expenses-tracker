// The /categories spending split (`lib/category-split.ts`): ramp colours by amount rank, shares, legend percents.
import { describe, expect, it } from "vitest";
import {
  RAMP_BG,
  percentLabel,
  rampFor,
  rowShare,
  spendingSplit,
  wholePercents,
  type SplitInput,
} from "@/lib/category-split";

let nextId = 1;
const exp = (name: string, monthAmountMinor: number): SplitInput => ({ id: nextId++, name, kind: "expense", monthAmountMinor });
const inc = (name: string, monthAmountMinor: number): SplitInput => ({ id: nextId++, name, kind: "income", monthAmountMinor });

describe("spendingSplit", () => {
  it("orders the expense categories largest first and gives them ramp 1, 2, 3… regardless of input order", () => {
    const split = spendingSplit([exp("Bills", 2_000), exp("Food", 9_000), exp("Transport", 500), exp("Groceries", 4_000)]);
    expect(split.segments.map((s) => [s.name, s.ramp])).toEqual([
      ["Food", 1],
      ["Groceries", 2],
      ["Bills", 3],
      ["Transport", 4],
    ]);
    expect(split.totalMinor).toBe(15_500);
  });

  it("the 6th and later categories reuse the last ramp colour", () => {
    const split = spendingSplit([60, 50, 40, 30, 20, 10, 5].map((a, i) => exp(`C${i}`, a)));
    expect(split.segments.map((s) => s.ramp)).toEqual([1, 2, 3, 4, 5, 5, 5]);
    expect(rampFor(0)).toBe(1);
    expect(rampFor(4)).toBe(5);
    expect(rampFor(99)).toBe(5);
  });

  it("leaves out categories with nothing this month and income categories", () => {
    const split = spendingSplit([exp("Food", 1_000), exp("Bills", 0), inc("Salary", 500_000), exp("Rent", 3_000)]);
    expect(split.segments.map((s) => s.name)).toEqual(["Rent", "Food"]);
    expect(split.totalMinor).toBe(4_000);
  });

  it("breaks ties by name ignoring case, then id", () => {
    const split = spendingSplit([exp("food", 1_000), exp("Bills", 1_000), exp("Apples", 2_000)]);
    expect(split.segments.map((s) => s.name)).toEqual(["Apples", "Bills", "food"]);
  });

  it("an empty month has no segments and a zero total", () => {
    expect(spendingSplit([exp("Food", 0), inc("Salary", 100)])).toEqual({ totalMinor: 0, segments: [] });
    expect(spendingSplit([])).toEqual({ totalMinor: 0, segments: [] });
  });

  it("fractions add up to 1 and the legend percents to exactly 100", () => {
    for (const amounts of [
      [1, 1, 1],
      [333, 333, 334],
      [9_999, 1, 1, 1],
      [17, 23, 41, 7, 3, 9, 11],
      [115_000, 4_250, 1_999, 12_345, 600],
    ]) {
      const split = spendingSplit(amounts.map((a, i) => exp(`C${i}`, a)));
      const fractions = split.segments.reduce((s, x) => s + x.fraction, 0);
      expect(fractions).toBeCloseTo(1, 10);
      expect(split.segments.reduce((s, x) => s + x.percent, 0)).toBe(100);
      for (const s of split.segments) expect(Math.abs(s.percent - s.fraction * 100)).toBeLessThan(1);
    }
  });
});

describe("wholePercents", () => {
  it("rounds by largest remainder; on equal remainders the earlier value gets the point", () => {
    expect(wholePercents([1, 1, 1], 3)).toEqual([34, 33, 33]);
    expect(wholePercents([50, 25, 25], 100)).toEqual([50, 25, 25]);
    expect(wholePercents([2, 1], 3)).toEqual([67, 33]);
  });

  it("zeros for an empty list or a zero total", () => {
    expect(wholePercents([], 0)).toEqual([]);
    expect(wholePercents([0, 0], 0)).toEqual([0, 0]);
  });
});

describe("percentLabel and rowShare", () => {
  it("shows <1% for a category that spent something but rounds to 0", () => {
    expect(percentLabel(0, 3)).toBe("<1%");
    expect(percentLabel(0, 0)).toBe("0%");
    expect(percentLabel(32, 3)).toBe("32%");
    const split = spendingSplit([exp("Rent", 100_000), exp("Gum", 1)]);
    expect(split.segments.map((s) => percentLabel(s.percent, s.amountMinor))).toEqual(["100%", "<1%"]);
  });

  it("a row gets its segment's ramp colour and share; no segment → no colour and 0", () => {
    const [first, second] = spendingSplit([exp("Food", 1_000), exp("Rent", 3_000)]).segments;
    expect(rowShare(first)).toEqual({ swatchClass: RAMP_BG[1], fraction: 0.75, percentLabel: "75%" });
    expect(rowShare(second)).toEqual({ swatchClass: "bg-chart-ramp-2", fraction: 0.25, percentLabel: "25%" });
    expect(rowShare(undefined)).toEqual({ swatchClass: "", fraction: 0, percentLabel: "0%" });
  });
});
