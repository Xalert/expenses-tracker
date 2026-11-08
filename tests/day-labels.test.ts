import { describe, expect, it } from "vitest";
import { dayHeaderLabel, dayMonthLabel, dayNetLabel, groupByDate } from "@/lib/day-labels";

const TODAY = "2026-11-08"; // a Sunday

describe("dayHeaderLabel", () => {
  it("names today and yesterday with the weekday", () => {
    expect(dayHeaderLabel("2026-11-08", TODAY)).toBe("Today · Sunday 8");
    expect(dayHeaderLabel("2026-11-07", TODAY)).toBe("Yesterday · Saturday 7");
    expect(dayHeaderLabel("2026-10-31", "2026-11-01")).toBe("Yesterday · Saturday 31");
  });

  it("gives the full weekday and day within today's month", () => {
    expect(dayHeaderLabel("2026-11-03", TODAY)).toBe("Tuesday 3");
  });

  it("adds the month in another month of the year, and the year in another year", () => {
    expect(dayHeaderLabel("2026-10-03", TODAY)).toBe("Sat 3 Oct");
    expect(dayHeaderLabel("2025-11-04", TODAY)).toBe("Tue 4 Nov 2025");
    expect(dayHeaderLabel("2026-11-20", TODAY)).toBe("Friday 20");
  });
});

describe("day helpers", () => {
  it("dayNetLabel joins every currency's signed net", () => {
    const label = dayNetLabel([
      { currency: "EUR", netMinor: -3921 },
      { currency: "RON", netMinor: 149000 },
    ]);
    // Intl puts a no-break space between "lei" and the number.
    expect(label.replace(/\s/g, " ")).toBe("-€39.21 · +lei 1,490.00");
    expect(dayNetLabel([{ currency: "EUR", netMinor: 0 }])).toBe("€0.00");
  });

  it("groupByDate keeps the order", () => {
    const groups = groupByDate([
      { date: "2026-11-08", id: 3 },
      { date: "2026-11-08", id: 2 },
      { date: "2026-11-05", id: 1 },
    ]);
    expect(groups.map((g) => [g.date, g.items.map((i) => i.id)])).toEqual([
      ["2026-11-08", [3, 2]],
      ["2026-11-05", [1]],
    ]);
  });

  it("dayMonthLabel", () => {
    expect(dayMonthLabel("2026-11-03")).toBe("3 November");
  });
});
