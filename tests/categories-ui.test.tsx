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
  changeCategoryKindAction: async () => ({}),
  setCategoryArchivedAction: async () => ({}),
}));

const cat = (
  id: number,
  name: string,
  kind: "expense" | "income",
  monthAmountMinor: number,
  monthCount: number,
  transactionCount: number,
): CategoryWithMonthUsage => ({ id, name, kind, archivedAt: null, color: null, monthAmountMinor, monthCount, transactionCount });
const archive = (c: CategoryWithMonthUsage): CategoryWithMonthUsage => ({ ...c, archivedAt: new Date("2026-10-01T00:00:00Z") });

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
    swatch: /<span aria-hidden="true" class="size-2\.5 shrink-0 (?:rounded-full|rounded-\[3px\]) ?([^"]*)"/.exec(m[1])?.[1],
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

  it("archived categories leave the main list and the count, and follow the add row under an Archived heading", () => {
    const list = [EXPENSE[0], archive(EXPENSE[1]), EXPENSE[2], archive(EXPENSE[3])];
    const html = renderToStaticMarkup(
      <CategorySection kind="expense" categories={list} currency="EUR" segments={split.segments} />,
    );
    const text = html.replace(/<[^>]+>/g, "");
    expect(text).toContain("Expense · 2 categories");
    expect(text).toContain("Archived · 2 categories");
    expect(text).toContain("Hidden from the entry form; their entries stay in reports and history.");
    // Active rows, then the add row, then the archived rows (still with their month figures).
    expect(rows(html).map((r) => r.text.split(" · ")[0])).toEqual(["Bills", "Housing", "Food", "Transport"]);
    expect(html.indexOf('id="new-expense-category"')).toBeLessThan(html.indexOf("expense-archived-categories-heading"));
    expect(html).toContain('<ul aria-labelledby="expense-archived-categories-heading"');
    expect(rows(html)[2].text).toContain("€40.00");
  });

  it("only archived categories: the empty line says there are no active ones", () => {
    const html = renderToStaticMarkup(
      <CategorySection kind="income" categories={INCOME.map(archive)} currency="EUR" segments={[]} />,
    );
    expect(html).toContain("No active income categories. Add one below");
    expect(html.replace(/<[^>]+>/g, "")).toContain("Archived · 2 categories");
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
          panelLabel={`Edit ${category.name}`}
          panel={<CategoryPanel category={category} others={others} announce={() => {}} />}
        />
      </ul>
    </ExpandableList>,
  );
}

describe("CategoryPanel (the open row)", () => {
  it("rename form: the name prefilled, the colour radios and a Save button; an unused category gets a plain Remove button", () => {
    const html = openPanel(EXPENSE[3], EXPENSE.slice(0, 3));
    expect(html).toContain('<label class="block text-sm font-medium text-foreground" for="rename-category-4">New name for “Transport”</label>');
    expect(html).toMatch(/<input[^>]*id="rename-category-4"[^>]*name="name"[^>]*value="Transport"/);
    // The colour radios: None (checked, no colour yet) and the palette, each 44px.
    expect(html).toContain("<legend");
    expect(html).toMatch(/<input type="radio" class="sr-only" id="rename-category-4-color-none" name="color" checked="" value=""\/>/);
    expect(html.match(/name="color"/g)).toHaveLength(7);
    expect(html).toContain("relative grid cursor-pointer place-items-center rounded-full border border-border");
    expect(html).toMatch(/size-11/);
    expect(html).toContain(">Save</button>");
    expect(html).toContain(">Cancel</button>");
    expect(html).toContain('<span class="truncate">Remove Transport</span>');
    expect(html).not.toContain("<select");
  });

  it("an unused category offers the kind change (a hidden field with the other kind) and Archive", () => {
    const html = openPanel(EXPENSE[3], EXPENSE.slice(0, 3));
    expect(html).toContain('<input type="hidden" name="kind" value="income"/>');
    expect(html).toContain(">Make it an income category</button>");
    expect(html).toMatch(/aria-describedby="category-4-archive-note">Archive<\/button>/);
    expect(html).toContain("Hides it from the entry form; its entries stay in reports and history.");
  });

  it("a used category explains why its kind stays", () => {
    const html = openPanel(EXPENSE[1], EXPENSE.filter((c) => c.id !== 2));
    expect(html).not.toContain('name="kind"');
    expect(html).toContain(
      "Used by 40 transactions, so it stays an expense category: changing it would turn those entries into income.",
    );
    const one = openPanel({ ...INCOME[0], transactionCount: 1 }, [INCOME[1]]);
    expect(one).toContain(
      "Used by 1 transaction, so it stays an income category: changing it would turn that entry into expense.",
    );
  });

  it("a used category asks for a replacement: another active category of its kind, or a new one", () => {
    const html = openPanel(EXPENSE[1], EXPENSE.filter((c) => c.id !== 2));
    expect(html).toContain('for="move-category-2">Remove, moving its 40 transactions to</label>');
    const options = [...html.matchAll(/<option value="(\w*)"[^>]*>([^<]*)<\/option>/g)].map((m) => [m[1], m[2]]);
    expect(options).toEqual([
      ["", "Choose a category…"],
      ["1", "Bills"],
      ["3", "Housing"],
      ["4", "Transport"],
      ["new", "A new expense category…"],
    ]);
    // The name field only appears once "A new … category" is chosen.
    expect(html).not.toContain('name="moveToNewCategoryName"');
    expect(html).toContain('<span class="truncate">Remove Food</span>');
    expect(html).toContain("To keep its entries where they are, archive it instead.");
  });

  it("the only active category of its kind with transactions: a new category named here, or archive it", () => {
    const html = openPanel(INCOME[0], []);
    expect(html).not.toContain("<select");
    expect(html).toContain(
      'for="move-category-10-new-name">Remove, moving its 7 transactions to a new income category named</label>',
    );
    expect(html).toMatch(/<input[^>]*id="move-category-10-new-name"[^>]*name="moveToNewCategoryName"/);
    expect(html).toContain('<span class="truncate">Remove Salary</span>');
    expect(html).toContain(
      "It is your only active income category. To keep its entries where they are, archive it instead.",
    );
  });

  it("an archived category offers Unarchive and no archive hint", () => {
    const html = openPanel(archive(INCOME[0]), [INCOME[1]]);
    expect(html).toMatch(/aria-describedby="category-10-archive-note">Unarchive<\/button>/);
    expect(html).toContain("Archived: hidden from the entry form.");
    expect(html).not.toContain("archive it instead");
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
