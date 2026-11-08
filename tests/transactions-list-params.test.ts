import { describe, expect, it } from "vitest";
import {
  dayHref,
  exportCsvHref,
  hasFilters,
  listFilters,
  listHref,
  monthHref,
  parseListParams,
  resolveView,
  stripMonth,
  viewLabel,
} from "@/components/transactions/list-params";
import { safeReturnTo } from "@/lib/return-to";

const NOV = "2026-11";

describe("parseListParams", () => {
  it("parses valid filters", () => {
    const p = parseListParams({
      wallet: "2",
      kind: "transfer",
      category: "7",
      from: "2026-10-01",
      to: "2026-10-31",
      q: "  rent ",
      page: "3",
    });
    expect(p).toEqual({
      month: undefined,
      wallet: 2,
      kind: "transfer",
      category: 7,
      from: "2026-10-01",
      to: "2026-10-31",
      q: "rent",
      currency: undefined,
      page: 3,
    });
    expect(hasFilters(p, NOV)).toBe(true);
  });

  it("ignores invalid values instead of throwing", () => {
    const p = parseListParams({
      wallet: "abc",
      kind: "transfer_out",
      category: "-1",
      from: "2026-02-30",
      to: "yesterday",
      q: "   ",
      page: "0",
      month: "2026-13",
      currency: "eur",
    });
    expect(p).toEqual({
      page: 1,
      month: undefined,
      wallet: undefined,
      kind: undefined,
      category: undefined,
      from: undefined,
      to: undefined,
      q: undefined,
      currency: undefined,
    });
    expect(hasFilters(p, NOV)).toBe(false);
    expect(parseListParams({ page: "1e3", wallet: "1.5" })).toMatchObject({ page: 1, wallet: undefined });
    expect(parseListParams({ wallet: ["4", "5"] }).wallet).toBe(4);
  });
});

describe("listHref", () => {
  it("omits empty values and page 1", () => {
    expect(listHref({ page: 1 })).toBe("/transactions");
    expect(listHref({ page: 1, wallet: 2, q: "a b&c" })).toBe("/transactions?wallet=2&q=a+b%26c");
    expect(listHref({ page: 1, kind: "income" }, { page: 2 })).toBe("/transactions?kind=income&page=2");
  });

  it("produces hrefs that pass the returnTo guard", () => {
    const href = listHref({ page: 4, wallet: 1, from: "2026-10-01", q: "x y" });
    expect(safeReturnTo(href)).toBe(href);
  });
});

describe("the month view", () => {
  it("defaults to the current month when neither month, from nor to is given", () => {
    const p = parseListParams({});
    expect(resolveView(p, NOV)).toEqual({ type: "month", month: NOV });
    expect(listFilters(p, NOV)).toMatchObject({ month: NOV, from: undefined, to: undefined });
    expect(viewLabel(resolveView(p, NOV), NOV)).toBe("November 2026");
    expect(stripMonth(resolveView(p, NOV))).toEqual({ month: NOV });
  });

  it("month=all is all time: no month sent to the service, no strip", () => {
    const p = parseListParams({ month: "all" });
    expect(p.month).toBe("all");
    expect(resolveView(p, NOV)).toEqual({ type: "all" });
    expect(listFilters(p, NOV).month).toBeUndefined();
    expect(viewLabel({ type: "all" }, NOV)).toBe("All time");
    expect(stripMonth({ type: "all" })).toBeNull();
  });

  it("explicit from / to override the month, and the label shows the real range", () => {
    const p = parseListParams({ month: "2026-10", from: "2026-11-05", to: "2026-11-12" });
    const view = resolveView(p, NOV);
    expect(view).toEqual({ type: "range", from: "2026-11-05", to: "2026-11-12" });
    expect(listFilters(p, NOV)).toMatchObject({ month: undefined, from: "2026-11-05", to: "2026-11-12" });
    expect(viewLabel(view, NOV)).toBe("5 Nov – 12 Nov");
    expect(viewLabel({ type: "range", from: "2025-12-30", to: "2026-01-02" }, NOV)).toBe("30 Dec 2025 – 2 Jan");
    expect(viewLabel({ type: "range", from: "2026-11-05" }, NOV)).toBe("From 5 Nov");
    expect(viewLabel({ type: "range", to: "2026-11-12" }, NOV)).toBe("Until 12 Nov");
    expect(stripMonth(view)).toBeNull();
  });

  it("a single day keeps the strip of its month with that day selected", () => {
    const view = resolveView(parseListParams({ from: "2026-10-03", to: "2026-10-03" }), NOV);
    expect(viewLabel(view, NOV)).toBe("3 Oct");
    expect(stripMonth(view)).toEqual({ month: "2026-10", selectedDate: "2026-10-03" });
  });

  it("hasFilters ignores the default month (absent or spelled out) but counts another month and all time", () => {
    expect(hasFilters(parseListParams({}), NOV)).toBe(false);
    expect(hasFilters(parseListParams({ month: NOV }), NOV)).toBe(false);
    expect(hasFilters(parseListParams({ month: "2026-10" }), NOV)).toBe(true);
    expect(hasFilters(parseListParams({ month: "all" }), NOV)).toBe(true);
    expect(hasFilters(parseListParams({ currency: "RON", page: "2" }), NOV)).toBe(false);
  });
});

describe("hrefs", () => {
  const p = parseListParams({ wallet: "4", currency: "RON", page: "3" });

  it("listHref keeps the month and the currency", () => {
    expect(listHref({ page: 1, month: "all" })).toBe("/transactions?month=all");
    expect(listHref(p)).toBe("/transactions?wallet=4&currency=RON&page=3");
  });

  it("monthHref leaves the current month out of the URL and drops from / to and the page", () => {
    const ranged = { ...p, from: "2026-10-03", to: "2026-10-03" };
    expect(monthHref(ranged, NOV, NOV)).toBe("/transactions?wallet=4&currency=RON");
    expect(monthHref(ranged, "2026-10", NOV)).toBe("/transactions?month=2026-10&wallet=4&currency=RON");
    expect(monthHref(ranged, "all", NOV)).toBe("/transactions?month=all&wallet=4&currency=RON");
  });

  it("dayHref narrows to one day and keeps a past month so clearing the day returns to it", () => {
    expect(dayHref(p, "2026-10", "2026-10-03", NOV)).toBe(
      "/transactions?month=2026-10&wallet=4&from=2026-10-03&to=2026-10-03&currency=RON",
    );
    expect(dayHref(p, NOV, "2026-11-03", NOV)).toBe("/transactions?wallet=4&from=2026-11-03&to=2026-11-03&currency=RON");
    expect(dayHref({ ...p, from: "2026-10-03", to: "2026-10-03" }, "2026-10", null, NOV)).toBe(
      "/transactions?month=2026-10&wallet=4&currency=RON",
    );
  });

  it("exportCsvHref carries every filter and the month shown, never the page or the currency", () => {
    expect(exportCsvHref(parseListParams({}), NOV)).toBe("/api/export/transactions?month=2026-11");
    expect(exportCsvHref(p, NOV)).toBe("/api/export/transactions?month=2026-11&wallet=4");
    expect(exportCsvHref(parseListParams({ month: "all", q: "rent" }), NOV)).toBe("/api/export/transactions?q=rent");
    expect(exportCsvHref(parseListParams({ month: "2026-10", from: "2026-10-05", to: "2026-10-12" }), NOV)).toBe(
      "/api/export/transactions?from=2026-10-05&to=2026-10-12",
    );
    // The export route parses the same params; a month in its URL reaches the service.
    expect(parseListParams({ month: "2026-11", wallet: "4" })).toMatchObject({ month: "2026-11", wallet: 4 });
  });
});
