import { describe, expect, it } from "vitest";
import {
  countOccurrencesAfter,
  describeSchedule,
  firstOccurrenceOnOrAfter,
  occurrence,
  occurrenceAfter,
  occurrencesBetween,
  type Schedule,
} from "@/lib/recurrence";

const s = (over: Partial<Schedule>): Schedule => ({
  frequency: "monthly",
  interval: 1,
  startDate: "2026-01-31",
  endDate: null,
  ...over,
});

const dates = (sch: Schedule, from: string, to: string, limit?: number) => occurrencesBetween(sch, from, to, limit).dates;

describe("occurrences", () => {
  it("monthly from the 31st lands on each month's last day and returns to the 31st", () => {
    expect(dates(s({}), "2026-01-01", "2026-05-31")).toEqual([
      "2026-01-31",
      "2026-02-28",
      "2026-03-31",
      "2026-04-30",
      "2026-05-31",
    ]);
  });

  it("monthly from the 30th: 29 February in a leap year", () => {
    expect(dates(s({ startDate: "2027-12-30" }), "2028-01-01", "2028-03-31")).toEqual([
      "2028-01-30",
      "2028-02-29",
      "2028-03-30",
    ]);
  });

  it("yearly from 29 February lands on 28 February in other years", () => {
    const leap = s({ frequency: "yearly", startDate: "2024-02-29" });
    expect(dates(leap, "2024-01-01", "2028-12-31")).toEqual([
      "2024-02-29",
      "2025-02-28",
      "2026-02-28",
      "2027-02-28",
      "2028-02-29",
    ]);
  });

  it("daily and weekly with intervals cross month and year ends", () => {
    expect(dates(s({ frequency: "daily", interval: 3, startDate: "2026-12-29" }), "2026-12-01", "2027-01-08")).toEqual([
      "2026-12-29",
      "2027-01-01",
      "2027-01-04",
      "2027-01-07",
    ]);
    expect(dates(s({ frequency: "weekly", interval: 2, startDate: "2026-11-25" }), "2026-12-01", "2027-01-10")).toEqual([
      "2026-12-09",
      "2026-12-23",
      "2027-01-06",
    ]);
  });

  it("every 2 months, every 3 years", () => {
    expect(dates(s({ interval: 2 }), "2026-01-01", "2026-12-31")).toEqual([
      "2026-01-31",
      "2026-03-31",
      "2026-05-31",
      "2026-07-31",
      "2026-09-30",
      "2026-11-30",
    ]);
    expect(dates(s({ frequency: "yearly", interval: 3, startDate: "2020-02-29" }), "2020-01-01", "2032-12-31")).toEqual([
      "2020-02-29",
      "2023-02-28",
      "2026-02-28",
      "2029-02-28",
      "2032-02-29",
    ]);
  });

  it("stops at the inclusive end date and reports no next", () => {
    const sch = s({ startDate: "2026-01-15", endDate: "2026-03-15" });
    expect(occurrencesBetween(sch, "2026-01-01", "2026-12-31")).toEqual({
      dates: ["2026-01-15", "2026-02-15", "2026-03-15"],
      next: null,
    });
    expect(occurrenceAfter(sch, "2026-03-15")).toBeNull();
    expect(firstOccurrenceOnOrAfter(sch, "2026-03-16")).toBeNull();
    expect(firstOccurrenceOnOrAfter(s({ startDate: "2026-01-15", endDate: "2026-03-14" }), "2026-03-01")).toBeNull();
  });

  it("respects the limit and hands back where to continue", () => {
    const daily = s({ frequency: "daily", startDate: "2026-01-01" });
    const run = occurrencesBetween(daily, "2026-01-01", "2026-12-31", 5);
    expect(run.dates).toEqual(["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04", "2026-01-05"]);
    expect(run.next).toBe("2026-01-06");
  });

  it("finds the first occurrence on or after a date far from the start", () => {
    const sch = s({});
    expect(firstOccurrenceOnOrAfter(sch, "2031-02-01")).toBe("2031-02-28");
    expect(firstOccurrenceOnOrAfter(sch, "2031-02-28")).toBe("2031-02-28");
    expect(occurrenceAfter(sch, "2031-02-28")).toBe("2031-03-31");
    expect(firstOccurrenceOnOrAfter(sch, "2025-06-01")).toBe("2026-01-31");
    expect(firstOccurrenceOnOrAfter(s({ frequency: "weekly", startDate: "2026-11-02" }), "2026-11-25")).toBe("2026-11-30");
    expect(firstOccurrenceOnOrAfter(s({ frequency: "daily", interval: 7, startDate: "2000-01-01" }), "2026-11-25")).toBe(
      "2026-11-28", // 1 Jan 2000 was a Saturday
    );
  });

  it("an off-schedule date snaps forward to the schedule", () => {
    expect(firstOccurrenceOnOrAfter(s({ startDate: "2026-01-10" }), "2026-03-11")).toBe("2026-04-10");
  });

  it("never goes past 2999-12-31", () => {
    expect(occurrenceAfter(s({ frequency: "yearly", startDate: "2999-06-01" }), "2999-06-01")).toBeNull();
  });

  it("occurrence k counts from the start", () => {
    expect(occurrence(s({}), 0)).toBe("2026-01-31");
    expect(occurrence(s({}), 13)).toBe("2027-02-28");
  });
});

describe("countOccurrencesAfter", () => {
  it("counts the dates after the first entry up to today", () => {
    expect(countOccurrencesAfter(s({ startDate: "2026-09-25" }), "2026-09-25", "2026-11-25")).toBe(2);
    expect(countOccurrencesAfter(s({ startDate: "2026-09-25" }), "2026-09-25", "2026-11-24")).toBe(1);
    expect(countOccurrencesAfter(s({ startDate: "2026-11-25" }), "2026-11-25", "2026-11-25")).toBe(0);
    expect(countOccurrencesAfter(s({ startDate: "2026-09-25", endDate: "2026-10-01" }), "2026-09-25", "2026-11-25")).toBe(0);
    expect(countOccurrencesAfter(s({ frequency: "daily", startDate: "2026-01-01" }), "2026-01-01", "2026-12-31", 50)).toBe(50);
  });
});

describe("describeSchedule", () => {
  it("says the schedule in words", () => {
    expect(describeSchedule({ frequency: "daily", interval: 1, startDate: "2026-11-25" })).toBe("Every day");
    expect(describeSchedule({ frequency: "daily", interval: 3, startDate: "2026-11-25" })).toBe("Every 3 days");
    expect(describeSchedule({ frequency: "weekly", interval: 1, startDate: "2026-11-25" })).toBe("Every week on Wednesday");
    expect(describeSchedule({ frequency: "monthly", interval: 2, startDate: "2026-01-31" })).toBe("Every 2 months on the 31st");
    expect(describeSchedule({ frequency: "monthly", interval: 1, startDate: "2026-01-12" })).toBe("Every month on the 12th");
    expect(describeSchedule({ frequency: "monthly", interval: 1, startDate: "2026-01-22" })).toBe("Every month on the 22nd");
    expect(describeSchedule({ frequency: "yearly", interval: 1, startDate: "2024-02-29" })).toBe("Every year on 29 February");
  });
});
