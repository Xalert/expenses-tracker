import { describe, expect, it } from "vitest";
import { hasFilters, listHref, parseListParams } from "@/components/transactions/list-params";
import { safeReturnTo } from "@/lib/return-to";

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
    expect(p).toEqual({ wallet: 2, kind: "transfer", category: 7, from: "2026-10-01", to: "2026-10-31", q: "rent", page: 3 });
    expect(hasFilters(p)).toBe(true);
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
    });
    expect(p).toEqual({ page: 1, wallet: undefined, kind: undefined, category: undefined, from: undefined, to: undefined, q: undefined });
    expect(hasFilters(p)).toBe(false);
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
