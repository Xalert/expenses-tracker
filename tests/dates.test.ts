import { describe, expect, it } from "vitest";
import { addDays, currentMonth, formatDate, isValidDate, isValidMonth, monthRange, shiftMonth, todayISO } from "@/lib/dates";

describe("dates", () => {
  it("formats today and month from local time", () => {
    const d = new Date(2026, 0, 5, 23, 30);
    expect(todayISO(d)).toBe("2026-01-05");
    expect(currentMonth(d)).toBe("2026-01");
  });
  it("validates dates and months", () => {
    expect(isValidDate("2024-02-29")).toBe(true);
    expect(isValidDate("2025-02-29")).toBe(false);
    expect(isValidDate("2025-13-01")).toBe(false);
    expect(isValidDate("2025-1-01")).toBe(false);
    expect(isValidDate(undefined)).toBe(false);
    expect(isValidMonth("2025-12")).toBe(true);
    expect(isValidMonth("2025-00")).toBe(false);
  });
  it("computes month ranges and shifts", () => {
    expect(monthRange("2026-02")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(monthRange("2024-02")).toEqual({ from: "2024-02-01", to: "2024-02-29" });
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2025-12", 1)).toBe("2026-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(formatDate("2026-11-05")).toBe("5 Nov 2026");
  });
});
