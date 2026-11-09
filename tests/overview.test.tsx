import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DayBars, RunningLine, linePoints } from "@/components/charts";
import { CurrencySwitch, InsightCard } from "@/components/ui";
import { axisTicks, cumulative, median, pickScale } from "@/lib/chart-scale";
import {
  monthName,
  overviewHref,
  paceSummary,
  resolveOverviewCurrency,
  shortDateLabel,
  toneOf,
} from "@/lib/overview";

const days = (values: number[], month = "2026-11") =>
  values.map((value, i) => ({ date: `${month}-${String(i + 1).padStart(2, "0")}`, value }));

describe("pickScale (the cap rule)", () => {
  it("caps one day that dwarfs the median of the non-zero days", () => {
    // The demo month: rent on the 2nd, ordinary days around €50.
    const scale = pickScale(days([4900, 115000, 6420, 1450, 8990, 2999, 0, 13385]));
    expect(scale.cappedDate).toBe("2026-11-02");
    expect(scale.max).toBeCloseTo(13385 * 1.2);
  });

  it("does not cap a month without an outlier", () => {
    expect(pickScale(days([1000, 2000, 2500, 0, 1800]))).toEqual({ max: 2500 });
  });

  it("does not cap when the top day is only slightly above the next one", () => {
    // Above 3× the median, but capping would leave the other big day as tall as the capped one.
    expect(pickScale(days([100, 100, 100, 1000, 1100]))).toEqual({ max: 1100 });
  });

  it("does not cap two tied outliers", () => {
    expect(pickScale(days([10, 10, 10, 500, 500])).cappedDate).toBeUndefined();
  });

  it("handles empty, all-zero and single-day months", () => {
    expect(pickScale([])).toEqual({ max: 0 });
    expect(pickScale(days([0, 0, 0]))).toEqual({ max: 0 });
    expect(pickScale(days([0, 5000, 0]))).toEqual({ max: 5000 });
  });

  it("uses the median of non-zero days only", () => {
    expect(median([1, 3, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBe(0);
    // Zero days do not drag the median down: 400 is not more than 3× the median of [200, 300, 400].
    expect(pickScale(days([0, 0, 0, 0, 200, 300, 400])).cappedDate).toBeUndefined();
  });
});

describe("chart helpers", () => {
  it("cumulative", () => {
    expect(cumulative([1, 0, 2, 3])).toEqual([1, 1, 3, 6]);
    expect(cumulative([])).toEqual([]);
  });

  it("axis ticks for the current month put today in and drop crowded fixed ticks", () => {
    expect(axisTicks("Nov", 30, 8).map((t) => t.label)).toEqual(["1 Nov", "8 · today", "15", "22", "30"]);
    expect(axisTicks("Nov", 30, 14).map((t) => t.label)).toEqual(["1 Nov", "14 · today", "22", "30"]);
    expect(axisTicks("Nov", 30, 2).map((t) => t.label)).toEqual(["2 Nov · today", "15", "22", "30"]);
    expect(axisTicks("Nov", 30, 1).map((t) => t.label)).toEqual(["1 Nov · today", "15", "22", "30"]);
    expect(axisTicks("Nov", 30, 30).map((t) => t.label)).toEqual(["1 Nov", "15", "22", "30 · today"]);
    expect(axisTicks("Feb", 28, null).map((t) => t.label)).toEqual(["1 Feb", "15", "22", "28"]);
  });

  it("line points start at zero on the left edge and are cut to the month's days", () => {
    expect(linePoints([0, 100, 200], 200, 3)).toBe("0,200 10,200 30,100 50,0");
    expect(linePoints([50, 50, 50, 50], 100, 2)).toBe("0,200 10,100 30,100");
    expect(linePoints([10], 0, 30)).toBe("0,200 10,200");
  });
});

describe("pace wording", () => {
  it("current month: less spent is negative and in the income colour", () => {
    expect(
      paceSummary({ day: 8, thisMonthMinor: 140139, previousMonthMinor: 143405, previousMonth: "2026-10", isCurrentMonth: true }),
    ).toEqual({ deltaMinor: -3266, tone: "income", sub: "less spent than by 8 Oct" });
  });

  it("current month: more spent is positive and in the expense colour", () => {
    expect(
      paceSummary({ day: 8, thisMonthMinor: 2000, previousMonthMinor: 1000, previousMonth: "2026-10", isCurrentMonth: true }),
    ).toMatchObject({ deltaMinor: 1000, tone: "expense", sub: "more spent than by 8 Oct" });
  });

  it("equal is neutral", () => {
    expect(
      paceSummary({ day: 3, thisMonthMinor: 500, previousMonthMinor: 500, previousMonth: "2026-10", isCurrentMonth: true }),
    ).toEqual({ deltaMinor: 0, tone: "default", sub: "the same as by 3 Oct" });
  });

  it("past month: the whole month when it covers the previous one, else the last compared day", () => {
    // October (31 days) against September (30): every day of September is compared.
    expect(
      paceSummary({ day: 31, thisMonthMinor: 1, previousMonthMinor: 2, previousMonth: "2026-09", isCurrentMonth: false }).sub,
    ).toBe("less spent over the whole month");
    // November (30 days) against October (31): only through 30 October.
    expect(
      paceSummary({ day: 30, thisMonthMinor: 2, previousMonthMinor: 1, previousMonth: "2026-10", isCurrentMonth: false }).sub,
    ).toBe("more spent than by 30 Oct");
    // March (31) against February (28).
    expect(
      paceSummary({ day: 31, thisMonthMinor: 1, previousMonthMinor: 1, previousMonth: "2026-02", isCurrentMonth: false }).sub,
    ).toBe("the same over the whole month");
  });

  it("toneOf and month names", () => {
    expect([toneOf(5), toneOf(-5), toneOf(0)]).toEqual(["income", "expense", "default"]);
    expect(monthName("2026-10")).toBe("October");
  });
});

describe("Overview currency and links", () => {
  const held = ["EUR", "JPY", "RON", "USD"];

  it("uses ?currency= when the user holds a wallet in it", async () => {
    const pick = vi.fn(() => "EUR");
    expect(await resolveOverviewCurrency("RON", held, pick)).toEqual({ currency: "RON", explicit: true });
    expect(pick).not.toHaveBeenCalled();
  });

  it("falls back to pickDefaultCurrency for an unknown, malformed, unheld or missing currency", async () => {
    for (const requested of ["XXX", "ron", "GBP", "", undefined, ["RON"]]) {
      const pick = vi.fn(() => "EUR");
      expect(await resolveOverviewCurrency(requested, held, pick)).toEqual({ currency: "EUR", explicit: false });
      expect(pick).toHaveBeenCalledOnce();
    }
    expect(await resolveOverviewCurrency(undefined, [], () => null)).toEqual({ currency: null, explicit: false });
  });

  it("builds /?month=&currency= links, leaving out the current month", () => {
    expect(overviewHref("2026-11", "EUR", "2026-11")).toBe("/?currency=EUR");
    expect(overviewHref("2026-10", "RON", "2026-11")).toBe("/?month=2026-10&currency=RON");
    expect(overviewHref("2026-11", null, "2026-11")).toBe("/");
  });

  it("labels recent dates", () => {
    expect(shortDateLabel("2026-11-08", "2026-11-08")).toBe("Today");
    expect(shortDateLabel("2026-11-07", "2026-11-08")).toBe("Yesterday");
    expect(shortDateLabel("2026-10-31", "2026-11-01")).toBe("Yesterday");
    expect(shortDateLabel("2026-11-03", "2026-11-08")).toBe("3 Nov");
    expect(shortDateLabel("2025-12-24", "2026-11-08")).toBe("24 Dec 2025");
  });
});

describe("chart and card components", () => {
  const bars = [
    { date: "2026-11-01", value: 100 },
    { date: "2026-11-02", value: 5000 },
    { date: "2026-11-03", value: 0, tone: "future" as const },
  ];

  it("DayBars without links is hidden from assistive technology", () => {
    const html = renderToStaticMarkup(<DayBars days={bars} ariaLabelFor={() => "x"} />);
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain("<a");
    expect(html).toContain("repeat(3, minmax(0, 1fr))");
    expect(html).toContain("bg-chart-future");
  });

  it("DayBars with hrefFor renders labelled links and marks the selected day", () => {
    const html = renderToStaticMarkup(
      <DayBars
        days={bars}
        selectedDate="2026-11-02"
        hrefFor={(d) => `/transactions?from=${d}&to=${d}`}
        ariaLabelFor={(d, v) => `${d}: ${v} spent`}
      />,
    );
    expect(html).not.toContain('aria-hidden="true"');
    expect(html).toContain('aria-label="2026-11-01: 100 spent"');
    expect(html).toContain('href="/transactions?from=2026-11-02&amp;to=2026-11-02"');
    expect(html).toContain('aria-current="date"');
  });

  it("DayBars draws the capped day at full height with its label", () => {
    const html = renderToStaticMarkup(
      <DayBars days={bars} max={120} cap={{ date: "2026-11-02", label: "Rent €50.00" }} ariaLabelFor={() => ""} />,
    );
    expect(html).toContain("Rent €50.00");
    expect(html).toContain("height:max(100%, 3px)");
    expect(html).toContain("height:max(83.33333333333334%, 3px)");
  });

  it("RunningLine is an image with its summary", () => {
    const html = renderToStaticMarkup(
      <RunningLine days={3} max={10} ariaLabel="Summary" series={[{ values: [1, 2], tone: "muted", dashed: true }]} />,
    );
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Summary"');
    expect(html).toContain('viewBox="0 0 60 200"');
    expect(html).toContain('stroke-dasharray="5 5"');
    expect(html).toContain('vector-effect="non-scaling-stroke"');
  });

  it("CurrencySwitch marks the value and adds it when it is not among the active currencies", () => {
    const html = renderToStaticMarkup(
      <CurrencySwitch currencies={["EUR", "USD"]} value="CHF" hrefFor={(c) => `/?currency=${c}`} />,
    );
    expect(html.match(/<a /g)).toHaveLength(3);
    expect(html.match(/<a[^>]*>CHF<\/a>/)?.[0]).toContain('aria-current="true"');
    expect(html.match(/<a[^>]*>EUR<\/a>/)?.[0]).not.toContain("aria-current");
    expect(html.indexOf("CHF")).toBeLessThan(html.indexOf("EUR"));
  });

  it("InsightCard colours the value by tone", () => {
    const html = renderToStaticMarkup(<InsightCard title="Net" value="+€1.00" sub="In · out" tone="income" />);
    expect(html).toContain("text-income");
    expect(html).toContain("In · out");
  });
});
