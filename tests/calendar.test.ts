import { describe, expect, it } from "vitest";
import {
  MONTH_LABELS,
  WEEKDAY_LABELS,
  calendarWeeks,
  clampTo,
  dateInMonth,
  dateLabel,
  monthOf,
  moveDate,
  moveMonth,
  weekdayIndex,
} from "@/lib/calendar";
import { addMonths } from "@/lib/dates";

describe("calendar labels", () => {
  it("is Monday-first with twelve short month names", () => {
    expect(WEEKDAY_LABELS).toEqual(["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"]);
    expect(MONTH_LABELS).toHaveLength(12);
    expect(MONTH_LABELS[0]).toBe("Jan");
    expect(MONTH_LABELS[11]).toBe("Dec");
  });

  it("gives the month of a date, the weekday index and a full spoken date", () => {
    expect(monthOf("2026-11-05")).toBe("2026-11");
    expect(weekdayIndex("2026-06-01")).toBe(0); // Monday
    expect(weekdayIndex("2026-11-01")).toBe(6); // Sunday
    expect(dateLabel("2026-11-05")).toMatch(/^Thursday,? 5 November 2026$/);
  });
});

describe("calendarWeeks", () => {
  const check = (weeks: string[][]) => {
    expect(weeks).toHaveLength(6);
    for (const w of weeks) {
      expect(w).toHaveLength(7);
      expect(weekdayIndex(w[0])).toBe(0);
    }
  };

  it("starts on the 1st when the month starts on a Monday", () => {
    const weeks = calendarWeeks("2026-06");
    check(weeks);
    expect(weeks[0][0]).toBe("2026-06-01");
    expect(weeks[4][1]).toBe("2026-06-30");
    expect(weeks[5][6]).toBe("2026-07-12");
  });

  it("puts a month starting on a Sunday in the last column, after six days of the previous month", () => {
    const weeks = calendarWeeks("2026-11");
    check(weeks);
    expect(weeks[0]).toEqual(["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01"]);
    expect(weeks[5][0]).toBe("2026-11-30");
    expect(weeks[5][6]).toBe("2026-12-06");
  });

  it("includes 29 February in a leap year", () => {
    const weeks = calendarWeeks("2024-02");
    check(weeks);
    expect(weeks[0][0]).toBe("2024-01-29");
    expect(weeks.flat()).toContain("2024-02-29");
    expect(weeks.flat().filter((d) => d.startsWith("2024-02"))).toHaveLength(29);
  });

  it("wraps December into January of the next year", () => {
    const weeks = calendarWeeks("2026-12");
    check(weeks);
    expect(weeks[0][0]).toBe("2026-11-30");
    expect(weeks.flat()).toContain("2026-12-31");
    expect(weeks[5][6]).toBe("2027-01-10");
  });

  it("rejects an invalid month", () => {
    expect(() => calendarWeeks("2026-13")).toThrow();
  });
});

describe("moveDate", () => {
  it("moves by a day with Left / Right, across month and year ends", () => {
    expect(moveDate("2026-11-05", "ArrowLeft")).toBe("2026-11-04");
    expect(moveDate("2026-11-05", "ArrowRight")).toBe("2026-11-06");
    expect(moveDate("2026-12-31", "ArrowRight")).toBe("2027-01-01");
    expect(moveDate("2026-01-01", "ArrowLeft")).toBe("2025-12-31");
  });

  it("moves by a week with Up / Down", () => {
    expect(moveDate("2026-11-05", "ArrowUp")).toBe("2026-10-29");
    expect(moveDate("2026-11-05", "ArrowDown")).toBe("2026-11-12");
    expect(moveDate("2024-02-26", "ArrowDown")).toBe("2024-03-04");
  });

  it("jumps to Monday / Sunday of the week with Home / End", () => {
    expect(moveDate("2026-11-05", "Home")).toBe("2026-11-02");
    expect(moveDate("2026-11-05", "End")).toBe("2026-11-08");
    expect(moveDate("2026-11-02", "Home")).toBe("2026-11-02");
    expect(moveDate("2026-11-01", "Home")).toBe("2026-10-26");
    expect(moveDate("2026-11-30", "End")).toBe("2026-12-06");
  });

  it("pages by a month, or by a year with Shift, clamping the day", () => {
    expect(moveDate("2026-11-05", "PageUp")).toBe("2026-10-05");
    expect(moveDate("2026-11-05", "PageDown")).toBe("2026-12-05");
    expect(moveDate("2026-01-31", "PageDown")).toBe("2026-02-28");
    expect(moveDate("2026-03-31", "PageUp")).toBe("2026-02-28");
    expect(moveDate("2026-12-15", "PageDown")).toBe("2027-01-15");
    expect(moveDate("2026-11-05", "PageUp", true)).toBe("2025-11-05");
    expect(moveDate("2026-11-05", "PageDown", true)).toBe("2027-11-05");
    expect(moveDate("2024-02-29", "PageDown", true)).toBe("2025-02-28");
  });

  it("ignores other keys and stops at the supported years", () => {
    expect(moveDate("2026-11-05", "Enter")).toBeNull();
    expect(moveDate("2026-11-05", "a")).toBeNull();
    expect(moveDate("1900-01-01", "ArrowLeft")).toBeNull();
    expect(moveDate("2999-12-31", "ArrowRight")).toBeNull();
    expect(moveDate("2999-06-01", "PageDown", true)).toBeNull();
    expect(moveDate("not-a-date", "ArrowLeft")).toBeNull();
  });
});

describe("moveMonth", () => {
  it("moves through the 3 × 4 month grid, wrapping into neighbouring years", () => {
    expect(moveMonth("2026-11", "ArrowLeft")).toBe("2026-10");
    expect(moveMonth("2026-12", "ArrowRight")).toBe("2027-01");
    expect(moveMonth("2026-01", "ArrowLeft")).toBe("2025-12");
    expect(moveMonth("2026-05", "ArrowUp")).toBe("2026-02");
    expect(moveMonth("2026-02", "ArrowUp")).toBe("2025-11");
    expect(moveMonth("2026-11", "ArrowDown")).toBe("2027-02");
    expect(moveMonth("2026-07", "Home")).toBe("2026-01");
    expect(moveMonth("2026-07", "End")).toBe("2026-12");
    expect(moveMonth("2026-07", "PageUp")).toBe("2025-07");
    expect(moveMonth("2026-07", "PageDown")).toBe("2027-07");
  });

  it("ignores other keys and stops at the supported years", () => {
    expect(moveMonth("2026-07", "Enter")).toBeNull();
    expect(moveMonth("1900-01", "ArrowLeft")).toBeNull();
    expect(moveMonth("2999-12", "PageDown")).toBeNull();
  });
});

describe("clampTo and dateInMonth", () => {
  it("clamps into optional bounds", () => {
    expect(clampTo("2026-12", undefined, "2026-11")).toBe("2026-11");
    expect(clampTo("2026-01", "2026-03")).toBe("2026-03");
    expect(clampTo("2026-05-05", "2026-01-01", "2026-12-31")).toBe("2026-05-05");
  });

  it("keeps the day of the month in another month, clamped", () => {
    expect(dateInMonth("2026-01-31", "2026-02")).toBe("2026-02-28");
    expect(dateInMonth("2026-11-05", "2020-03")).toBe("2020-03-05");
    expect(dateInMonth("2026-11-30", "2027-11")).toBe("2027-11-30");
  });
});

describe("addMonths", () => {
  it("shifts by months and clamps the day to the month's length", () => {
    expect(addMonths("2026-11-05", 1)).toBe("2026-12-05");
    expect(addMonths("2026-12-05", 1)).toBe("2027-01-05");
    expect(addMonths("2026-01-05", -1)).toBe("2025-12-05");
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2024-01-31", 1)).toBe("2024-02-29");
    expect(addMonths("2024-02-29", 12)).toBe("2025-02-28");
    expect(addMonths("2026-05-31", -1)).toBe("2026-04-30");
    expect(addMonths("2026-05-15", -24)).toBe("2024-05-15");
  });

  it("rejects an invalid date", () => {
    expect(() => addMonths("2026-02-30", 1)).toThrow();
  });
});
