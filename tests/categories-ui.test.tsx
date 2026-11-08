// /categories rendered to HTML (the test environment has no DOM): the split card, the lists' rows and the open row's
// rename / remove forms. Opening rows, Escape, focus after a removal and the confirm() were checked in the browser
// with Playwright (see SPEC "/categories", As built).
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CategoryPanel } from "@/components/categories/category-row";
import { CategorySection } from "@/components/categories/category-section";
import { SpendingSplitCard } from "@/components/categories/spending-split";
import { ExpandableList, ExpandableRow } from "@/components/ui/expandable-row";
import { spendingSplit } from "@/lib/category-split";
import { overviewHref } from "@/lib/overview";
import type { CategoryWithMonthUsage } from "@/server/categories";

vi.mock("@/app/(app)/categories/actions", () => ({
  createCategoryAction: async () => ({}),
  renameCategoryAction: async () => ({}),
  deleteCategoryAction: async () => ({}),
}));

const cat = (
  id: number,
  name: string,
  kind: "expense" | "income",
  monthAmountMinor: number,
  monthCount: number,
  transactionCount: number,
): CategoryWithMonthUsage => ({ id, name, kind, monthAmountMinor, monthCount, transactionCount });

// Service order (by name); Housing spends the most, so it gets ramp 1 although it is not the first row.
const EXPENSE = [
  cat(1, "Bills", "expense", 12_000, 2, 9),
  cat(2, "Food", "expense", 4_000, 5, 40),
  cat(3, "Housing", "expense", 115_000, 1, 6),
  cat(4, "Transport", "expense", 0, 0, 0),
];
const INCOME = [cat(10, "Salary", "income", 320_000, 1, 7), cat(11, "Refund", "income", 0, 0, 0)];
const split = spendingSplit([...EXPENSE, ...INCOME]);

/** The summary of each row: the classes of its swatch and its button text. */
function rows(html: string) {
  return [...html.matchAll(/<button type="button" aria-expanded="false"[^>]*>(.*?)<\/button>/g)].map((m) => ({
    swatch: /<span aria-hidden="true" class="size-2\.5 shrink-0 rounded-full ([^"]*)"/.exec(m[1])?.[1],
    text: m[1].replace(/<[^>]+>/g, ""),
  }));
}

describe("CategorySection", () => {
  it("expense rows: swatch by amount rank, counts, share bar and the month's amount", () => {
    const html = renderToStaticMarkup(
      <CategorySection kind="expense" categories={EXPENSE} currency="EUR" segments={split.segments} />,
    );
    expect(html).toContain('id="expense-categories-heading"');
    expect(html.replace(/<[^>]+>/g, "")).toContain("Expense · 4 categories");
    const r = rows(html);
    expect(r.map((x) => x.swatch)).toEqual([
      "bg-chart-ramp-2",
      "bg-chart-ramp-3",
      "bg-chart-ramp-1",
      "border border-border-strong",
    ]);
    expect(r[0].text).toContain("Bills · 2 this month · 9 in all");
    expect(r[0].text).toContain("€120.00");
    expect(r[2].text).toContain("€1,150.00");
    // Nothing this month: a dash, read out as "nothing in EUR".
    expect(r[3].text).toContain("—nothing in EUR");
    // Share bars: Housing's fill is its share of €1,310.
    expect(html).toMatch(/class="block h-full rounded-full bg-chart-ramp-1" style="width:87\.7\d*%"/);
    expect(html).toContain(", 88% of the month&#x27;s spending");
    // The rows open in place: nothing is open on load.
    expect(html).not.toContain('role="region"');
  });

  it("income rows: a green dot, no share bar, the amount in the income colour", () => {
    const html = renderToStaticMarkup(<CategorySection kind="income" categories={INCOME} currency="EUR" segments={[]} />);
    expect(rows(html).map((x) => x.swatch)).toEqual(["bg-income", "bg-income"]);
    expect(html).not.toContain("h-full rounded-full");
    expect(html).toContain('class="min-w-14 shrink-0 text-right font-bold tabular-nums text-income">€3,200.00');
  });

  it("ends with the dashed add row (labelled for screen readers) and a live status line", () => {
    const html = renderToStaticMarkup(<CategorySection kind="income" categories={INCOME} currency="EUR" segments={[]} />);
    expect(html).toContain('<label for="new-income-category" class="sr-only">New income category</label>');
    expect(html).toMatch(/<input[^>]*id="new-income-category"[^>]*placeholder="\+ New income category"/);
    expect(html).toMatch(/<input[^>]*id="new-income-category"[^>]*border-dashed|<input[^>]*border-dashed[^>]*id="new-income-category"/);
    expect(html).toContain(">Add</button>");
    expect(html).toContain('<p role="status" class="mt-1 text-sm text-income empty:hidden"></p>');
  });

  it("without a currency (no wallets) leaves out amounts and share bars", () => {
    const html = renderToStaticMarkup(<CategorySection kind="expense" categories={EXPENSE} currency={null} segments={[]} />);
    expect(html).not.toContain("€");
    expect(html).not.toContain("h-full rounded-full");
    expect(html).toContain("Bills");
  });

  it("an empty kind says so and still offers the add row", () => {
    const html = renderToStaticMarkup(<CategorySection kind="income" categories={[]} currency="EUR" segments={[]} />);
    expect(html.replace(/<[^>]+>/g, "")).toContain("Income · 0 categories");
    expect(html).toContain("No income categories yet.");
    expect(html).toContain('placeholder="+ New income category"');
  });
});

describe("SpendingSplitCard", () => {
  it("total, one bar segment per spending category largest first, legend with shares", () => {
    const html = renderToStaticMarkup(<SpendingSplitCard split={split} month="2026-10" currency="EUR" />);
    expect(html).toContain("Spending split");
    expect(html).toContain("€1,310.00");
    expect(html).toContain("spent in October");
    const bar = /<div aria-hidden="true" class="mt-3 flex h-3\.5 gap-\[3px\]">(.*?)<\/div>/.exec(html)?.[1] ?? "";
    expect([...bar.matchAll(/bg-chart-ramp-(\d)/g)].map((m) => m[1])).toEqual(["1", "2", "3"]);
    const legend = html.replace(/<[^>]+>/g, "|");
    expect(legend).toMatch(/Housing\|+88%.*Bills\|+9%.*Food\|+3%/);
    expect(html).not.toContain("Transport");
    expect(html).not.toContain("Salary");
  });

  it("an empty month says nothing was spent", () => {
    const html = renderToStaticMarkup(
      <SpendingSplitCard split={spendingSplit(INCOME)} month="2026-12" currency="RON" />,
    );
    expect(html).toContain("Nothing spent in December 2026 in RON.");
    expect(html).not.toContain("bg-chart-ramp");
  });
});

function openPanel(category: CategoryWithMonthUsage, others: CategoryWithMonthUsage[]) {
  return renderToStaticMarkup(
    <ExpandableList defaultOpenId="x">
      <ul>
        <ExpandableRow
          id="x"
          summary={category.name}
          panelLabel={`Rename or remove ${category.name}`}
          panel={<CategoryPanel category={category} others={others} announce={() => {}} />}
        />
      </ul>
    </ExpandableList>,
  );
}

describe("CategoryPanel (the open row)", () => {
  it("rename form: the name prefilled and a Rename button; an unused category gets a plain Remove button", () => {
    const html = openPanel(EXPENSE[3], EXPENSE.slice(0, 3));
    expect(html).toContain('<label class="block text-sm font-medium text-foreground" for="rename-category-4">New name for “Transport”</label>');
    expect(html).toMatch(/<input[^>]*id="rename-category-4"[^>]*name="name"[^>]*value="Transport"/);
    expect(html).toContain(">Rename</button>");
    expect(html).toContain(">Cancel</button>");
    expect(html).toContain('<span class="truncate">Remove Transport</span>');
    expect(html).not.toContain("<select");
  });

  it("a used category asks for a replacement of the same kind first", () => {
    const html = openPanel(EXPENSE[1], EXPENSE.filter((c) => c.id !== 2));
    expect(html).toContain('for="move-category-2">Remove, moving its 40 transactions to</label>');
    const options = [...html.matchAll(/<option value="(\d*)"[^>]*>([^<]*)<\/option>/g)].map((m) => m[2]);
    expect(options).toEqual(["Choose a category…", "Bills", "Housing", "Transport"]);
    expect(html).toContain('<span class="truncate">Remove Food</span>');
  });

  it("the only category of its kind with transactions explains why it cannot be removed", () => {
    const html = openPanel(INCOME[0], []);
    expect(html).toContain("is your only income category, so there is nowhere to move them");
    expect(html).not.toContain("Remove Salary");
  });
});

describe("/categories links", () => {
  it("overviewHref with a base path builds the month + currency links", () => {
    expect(overviewHref("2026-10", "RON", "2026-11", "/categories")).toBe("/categories?month=2026-10&currency=RON");
    expect(overviewHref("2026-11", "EUR", "2026-11", "/categories")).toBe("/categories?currency=EUR");
    expect(overviewHref("2026-11", null, "2026-11", "/categories")).toBe("/categories");
    expect(overviewHref("2026-11", null, "2026-11")).toBe("/");
  });
});
