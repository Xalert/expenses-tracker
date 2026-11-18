// The one category order (src/lib/category-order.ts): lower-cased names by code point, then id, never the database
// collation. The services list in it; the Overview's top-category tie-break and the split use the same name rule.
import { beforeEach, describe, expect, it } from "vitest";
import type { DB } from "@/db";
import { compareCategories, compareCategoryNames, sortCategories } from "@/lib/category-order";
import { spendingSplit } from "@/lib/category-split";
import { archiveCategory, createCategory, listCategories, listCategoriesWithUsage } from "@/server/categories";
import { pickTopCategory } from "@/server/insights";
import { makeUser, useFreshDb } from "./helpers";

describe("compareCategoryNames", () => {
  it("ignores case and compares by code point (not by locale)", () => {
    expect(compareCategoryNames("food", "FOOD")).toBe(0);
    expect(compareCategoryNames("apple", "Banana")).toBeLessThan(0);
    // By code point "é" (U+00E9) comes after "z"; `localeCompare` would put it next to "e".
    expect(compareCategoryNames("Éclair", "Zoo")).toBeGreaterThan(0);
    expect(compareCategoryNames("Bar", "Barn")).toBeLessThan(0);
    expect(compareCategoryNames("Barn", "Bar")).toBeGreaterThan(0);
    // Astral characters by code point, not by UTF-16 unit: U+1F600 comes after U+FF5E.
    expect(compareCategoryNames("😀", "～")).toBeGreaterThan(0);
  });

  it("orders lists expense first, active before archived, then name, then id", () => {
    const at = new Date("2026-01-01T00:00:00Z");
    const rows = [
      { id: 5, name: "salary", kind: "income" as const, archivedAt: null },
      { id: 4, name: "Zed", kind: "expense" as const, archivedAt: at },
      { id: 3, name: "food", kind: "expense" as const, archivedAt: null },
      { id: 2, name: "Food", kind: "expense" as const, archivedAt: null },
      { id: 1, name: "Bills", kind: "expense" as const, archivedAt: null },
    ];
    expect(sortCategories(rows).map((r) => r.id)).toEqual([1, 2, 3, 4, 5]);
    expect(compareCategories(rows[2], rows[3])).toBeGreaterThan(0);
  });

  it("the top category and the split break ties with the same rule", () => {
    const top = pickTopCategory([
      { categoryId: 1, categoryName: "Zoo", amountMinor: 100 },
      { categoryId: 2, categoryName: "Éclair", amountMinor: 100 },
    ]);
    expect(top?.categoryId).toBe(1);
    const split = spendingSplit([
      { id: 1, name: "Éclair", kind: "expense", monthAmountMinor: 100 },
      { id: 2, name: "Zoo", kind: "expense", monthAmountMinor: 100 },
    ]);
    expect(split.segments.map((s) => s.name)).toEqual(["Zoo", "Éclair"]);
  });
});

describe("category services list in that order", () => {
  let db: DB;
  beforeEach(async () => {
    db = await useFreshDb();
  });

  it("listCategories and listCategoriesWithUsage agree with sortCategories", async () => {
    const user = await makeUser(db, "order@example.com");
    for (const name of ["Éclair", "zoo", "Apple", "Ärger"]) await createCategory(user.id, { name, kind: "expense" });
    const old = await createCategory(user.id, { name: "Aardvark", kind: "expense" });
    await archiveCategory(user.id, old.id);
    const listed = await listCategories(user.id, undefined, { includeArchived: true });
    expect(listed).toEqual(sortCategories(listed));
    const expense = listed.filter((c) => c.kind === "expense").map((c) => c.name);
    expect(expense.slice(0, 2)).toEqual(["Apple", "Bills"]);
    expect(expense.slice(-4)).toEqual(["zoo", "Ärger", "Éclair", "Aardvark"]);
    const withUsage = await listCategoriesWithUsage(user.id);
    expect(withUsage.map((c) => c.id)).toEqual(listed.map((c) => c.id));
  });
});
