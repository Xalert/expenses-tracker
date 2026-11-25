import { describe, expect, it } from "vitest";
import { addDays, currentMonth, formatDate, isValidDate, isValidMonth, monthRange, shiftMonth, todayInZone, todayISO } from "@/lib/dates";

describe("dates", () => {
  it("formats today and month from local time", () => {
    const d = new Date(2026, 0, 5, 23, 30);
    expect(todayISO(d)).toBe("2026-01-05");
    expect(currentMonth(d)).toBe("2026-01");
  });
  describe("todayInZone", () => {
    const at = (iso: string) => new Date(iso);
    it("turns over at midnight in a zone east of UTC (Auckland, UTC+13 in November)", () => {
      expect(todayInZone("Pacific/Auckland", at("2026-11-24T10:59:59Z"))).toBe("2026-11-24");
      expect(todayInZone("Pacific/Auckland", at("2026-11-24T11:00:00Z"))).toBe("2026-11-25");
      // Already tomorrow there while it is still today in UTC, and a new year first.
      expect(todayInZone("Pacific/Auckland", at("2026-12-31T11:30:00Z"))).toBe("2027-01-01");
    });
    it("turns over at midnight in a zone west of UTC (Los Angeles, UTC-8 in November)", () => {
      expect(todayInZone("America/Los_Angeles", at("2026-11-25T07:59:59Z"))).toBe("2026-11-24");
      expect(todayInZone("America/Los_Angeles", at("2026-11-25T08:00:00Z"))).toBe("2026-11-25");
      // Still the previous day there just after midnight UTC.
      expect(todayInZone("America/Los_Angeles", at("2026-12-01T00:30:00Z"))).toBe("2026-11-30");
    });
    it("follows the zone's DST change", () => {
      // Los Angeles leaves DST on 1 Nov 2026: that day starts at UTC-7, the next one at UTC-8.
      expect(todayInZone("America/Los_Angeles", at("2026-11-01T06:59:59Z"))).toBe("2026-10-31");
      expect(todayInZone("America/Los_Angeles", at("2026-11-01T07:00:00Z"))).toBe("2026-11-01");
      expect(todayInZone("America/Los_Angeles", at("2026-11-02T07:59:59Z"))).toBe("2026-11-01");
      expect(todayInZone("America/Los_Angeles", at("2026-11-02T08:00:00Z"))).toBe("2026-11-02");
      // Auckland enters DST on 27 Sep 2026: that day starts at UTC+12, the next one at UTC+13.
      expect(todayInZone("Pacific/Auckland", at("2026-09-26T11:59:59Z"))).toBe("2026-09-26");
      expect(todayInZone("Pacific/Auckland", at("2026-09-26T12:00:00Z"))).toBe("2026-09-27");
      expect(todayInZone("Pacific/Auckland", at("2026-09-27T10:59:59Z"))).toBe("2026-09-27");
      expect(todayInZone("Pacific/Auckland", at("2026-09-27T11:00:00Z"))).toBe("2026-09-28");
    });
    it("UTC is the UTC date", () => {
      expect(todayInZone("UTC", at("2026-11-24T23:59:59Z"))).toBe("2026-11-24");
      expect(todayInZone("UTC", at("2026-11-25T00:00:00Z"))).toBe("2026-11-25");
    });
    it("falls back to the server's local date without a zone or with one the runtime does not know", () => {
      const d = new Date(2026, 0, 5, 23, 30); // local time, like todayISO's test
      expect(todayInZone(null, d)).toBe("2026-01-05");
      expect(todayInZone(undefined, d)).toBe("2026-01-05");
      expect(todayInZone("", d)).toBe("2026-01-05");
      expect(todayInZone("Mars/Olympus_Mons", d)).toBe("2026-01-05");
      expect(todayInZone("Mars/Olympus_Mons", d)).toBe(todayISO(d));
    });
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
