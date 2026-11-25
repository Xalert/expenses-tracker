// Budgets and category colours rendered to HTML (no DOM): the meter in a /categories row and the overall row, the
// group-scope line, the budget form in an open row, the Overview's Budgets card and the colour dots (rows and the
// entry form's category picker). Opening rows and submitting were checked in the browser (e2e/categories.spec.ts).
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BudgetForm } from "@/components/categories/budget-form";
import { CategoryPanel } from "@/components/categories/category-row";
import { CategorySection, type SectionBudgets } from "@/components/categories/category-section";
import { BudgetsCard } from "@/components/dashboard/budgets-card";
import { EntryForm } from "@/components/transactions/entry-form";
import { ExpandableList, ExpandableRow } from "@/components/ui/expandable-row";
import { spendingSplit } from "@/lib/category-split";
import { toCategoryOptions } from "@/app/(app)/transactions/form-options";
import type { BudgetProgress, MonthBudgets } from "@/server/budgets";
import type { CategoryWithMonthUsage } from "@/server/categories";

vi.mock("@/app/(app)/categories/actions", () => ({
  createCategoryAction: async () => ({}),
  renameCategoryAction: async () => ({}),
  deleteCategoryAction: async () => ({}),
  changeCategoryKindAction: async () => ({}),
  setCategoryArchivedAction: async () => ({}),
  setBudgetAction: async () => ({}),
  removeBudgetAction: async () => ({}),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ back() {}, refresh() {}, push() {} }) }));

const cat = (id: number, name: string, monthAmountMinor: number, color: CategoryWithMonthUsage["color"] = null): CategoryWithMonthUsage => ({
  id,
  name,
  kind: "expense",
  archivedAt: null,
  color,
  monthAmountMinor,
  monthCount: monthAmountMinor > 0 ? 1 : 0,
  transactionCount: monthAmountMinor > 0 ? 3 : 0,
  recurringCount: 0,
});
const EXPENSE = [cat(1, "Bills", 12_000), cat(2, "Food", 4_000, "teal"), cat(3, "Transport", 0)];
const split = spendingSplit(EXPENSE);

const progress = (categoryId: number | null, spentMinor: number, amountMinor: number, extra: Partial<BudgetProgress> = {}): BudgetProgress => ({
  id: categoryId ?? 100,
  categoryId,
  currency: "EUR",
  amountMinor,
  spentMinor,
  remainingMinor: amountMinor - spentMinor,
  missingCurrencies: [],
  category: categoryId === null ? null : { name: EXPENSE.find((c) => c.id === categoryId)?.name ?? `#${categoryId}`, archived: false, color: null },
  ...extra,
});
const view = (p: BudgetProgress) => ({ id: p.id, categoryId: p.categoryId, currency: p.currency, amountMinor: p.amountMinor });

const ELAPSED = { day: 10, days: 30 };
const PROGRESS = [progress(null, 150_000, 200_000), progress(2, 4_000, 3_000, { missingCurrencies: ["RON"] })];
const BUDGETS: SectionBudgets = {
  list: PROGRESS.map(view),
  progress: { budgets: PROGRESS, elapsed: ELAPSED },
  currencies: ["EUR", "RON"],
  defaultCurrency: "EUR",
};

const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'");

/** The text of each row button, in order. */
function rows(html: string): string[] {
  return [...html.matchAll(/<button type="button" aria-expanded="false"[^>]*>(.*?)<\/button>/g)].map((m) => text(m[1]));
}

describe("the expense card with budgets", () => {
  it("starts with the overall row (limit, meter) and shows the meter on rows with a budget", () => {
    const html = renderToStaticMarkup(
      <CategorySection kind="expense" categories={EXPENSE} currency="EUR" segments={split.segments} budgets={BUDGETS} />,
    );
    const r = rows(html);
    expect(r[0]).toContain("Overall budget · all spending€2,000.00 a month");
    expect(r[0]).toContain("This month: €1,500.00 of €2,000.00€500.00 left75% spent · day 10 of 30");
    expect(html).toContain('aria-label="Overall budget"');
    // Food: over its budget, the danger colour, the RON spending named; Bills has no budget, so no meter.
    const food = r.find((x) => x.startsWith("Food"))!;
    expect(food).toContain("Budget: €40.00 of €30.00€10.00 over133% spent · day 10 of 30RON not counted: no exchange rate");
    expect(r.find((x) => x.startsWith("Bills"))).not.toContain("Budget:");
    expect(html).toContain('class="font-semibold text-danger">€10.00 over');
    expect(html).toMatch(/class="absolute inset-y-0 left-0 rounded-full bg-danger" style="width:100%"/);
    expect(html).toMatch(/class="absolute inset-y-0 left-0 rounded-full bg-muted-foreground" style="width:75%"/);
    // The pace tick: day 10 of 30.
    expect(html).toMatch(/data-budget-pace=""[^>]*style="left:33\.33/);
    // A row with a meter wraps it onto its own line.
    expect(html).toContain("min-h-11 px-4 py-3 text-sm sm:px-[18px] flex-wrap gap-y-2");
    expect(html).not.toContain("their progress shows only");
  });

  it("an account without an overall budget says Not set; a past month has no pace tick", () => {
    const only = [progress(2, 1_000, 3_000)];
    const html = renderToStaticMarkup(
      <CategorySection
        kind="expense"
        categories={EXPENSE}
        currency="EUR"
        segments={split.segments}
        budgets={{ ...BUDGETS, list: only.map(view), progress: { budgets: only, elapsed: null } }}
      />,
    );
    expect(rows(html)[0]).toBe("Overall budget · all spendingNot set");
    expect(html).not.toContain("data-budget-pace");
    expect(text(html)).toContain("33% spent");
  });

  it("in a group scope: no meters, one line saying budgets cover all groups", () => {
    const html = renderToStaticMarkup(
      <CategorySection kind="expense" categories={EXPENSE} currency="EUR" segments={split.segments} budgets={{ ...BUDGETS, progress: null }} />,
    );
    expect(text(html)).toContain("Budgets cover all your wallet groups, so their progress shows only with All groups selected.");
    expect(html).not.toContain("data-budget-meter");
    expect(rows(html)[0]).toBe("Overall budget · all spending€2,000.00 a month");
  });

  it("the income card gets no budget row", () => {
    const html = renderToStaticMarkup(<CategorySection kind="income" categories={[]} currency="EUR" segments={[]} />);
    expect(html).not.toContain("Overall budget");
  });

  it("a category's colour is a round dot before its name; the ramp swatch is a square", () => {
    const html = renderToStaticMarkup(
      <CategorySection kind="expense" categories={EXPENSE} currency="EUR" segments={split.segments} />,
    );
    expect(html).toMatch(/<span aria-hidden="true" data-group-color="teal" class="inline-block size-2\.5 shrink-0 rounded-full bg-group-teal mr-1\.5[^"]*"><\/span>Food/);
    expect(html.match(/data-group-color/g)).toHaveLength(1);
    expect(html).toContain('class="size-2.5 shrink-0 rounded-[3px] bg-chart-ramp-1"');
  });
});

function openPanel(category: CategoryWithMonthUsage, budget?: BudgetProgress, currencies = ["EUR", "RON"]) {
  return renderToStaticMarkup(
    <ExpandableList defaultOpenId="x">
      <ul>
        <ExpandableRow
          id="x"
          summary={category.name}
          panelLabel={`Edit ${category.name}`}
          panel={
            <CategoryPanel
              category={category}
              others={[]}
              announce={() => {}}
              budget={budget && view(budget)}
              budgetChoices={{ currencies, defaultCurrency: "EUR" }}
            />
          }
        />
      </ul>
    </ExpandableList>,
  );
}

describe("the budget form in an open row", () => {
  it("with a budget: the amount and currency prefilled, Save budget and Remove; the kind change and removal mention it", () => {
    const html = openPanel(EXPENSE[2], progress(3, 0, 6_000, { currency: "RON" }));
    expect(html).toContain('for="budget-3-amount">Monthly budget for “Transport”</label>');
    expect(html).toMatch(/<input id="budget-3-amount"[^>]*inputMode="decimal"[^>]*name="amount"[^>]*value="60.00"/);
    expect(html).toMatch(/<select id="budget-3-currency"[^>]*name="currency"/);
    expect(html).toMatch(/<option value="RON" selected="">RON<\/option>/);
    expect(html).toMatch(/<label for="budget-3-currency" class="sr-only">Budget currency<\/label>/);
    expect(html).toContain(">Save budget</button>");
    expect(text(html)).toMatch(/Now lei\s60\.00 a month\./);
    expect(text(html)).toContain("Remove the budget for Transport");
    expect(text(html)).toContain("Budgets are for expenses only, so its budget is removed with the change.");
  });

  it("without a budget: an empty amount in the page's currency and Set budget; one currency is a fixed field", () => {
    const html = openPanel(EXPENSE[2], undefined, ["EUR"]);
    expect(html).toMatch(/<input id="budget-3-amount"[^>]*placeholder="No budget"[^>]*value=""/);
    expect(html).toContain('<input type="hidden" name="currency" value="EUR"/>');
    expect(html).not.toContain("<select");
    expect(html).toContain(">Set budget</button>");
    expect(text(html)).not.toContain("Remove the budget");
    expect(text(html)).not.toContain("its budget is removed");
  });

  it("without wallets it says why there is no form; an income category has none", () => {
    expect(text(openPanel(EXPENSE[2], undefined, []))).toContain("Add a wallet to set a budget");
    const income = { ...EXPENSE[2], kind: "income" as const };
    expect(openPanel(income)).not.toContain("budget-3-amount");
  });

  it("the overall form names all spending", () => {
    const html = renderToStaticMarkup(
      <BudgetForm target={null} subject="all spending" budget={undefined} currencies={["EUR"]} defaultCurrency="EUR" onDone={() => {}} />,
    );
    expect(html).toContain('for="budget-overall-amount">Monthly budget for all spending</label>');
  });
});

describe("the Overview's Budgets card", () => {
  const month = (budgets: BudgetProgress[]): MonthBudgets => ({ month: "2026-03", budgets, elapsed: ELAPSED });

  it("shows the overall budget and the three category budgets closest to their limit, and links to /categories", () => {
    const list = [
      progress(null, 1_000, 2_000),
      progress(1, 100, 1_000),
      progress(2, 1_200, 1_000),
      progress(3, 900, 1_000),
      progress(4, 500, 1_000, { category: { name: "Gifts", archived: true, color: "red" } }),
      progress(5, 0, 1_000),
    ];
    const html = renderToStaticMarkup(<BudgetsCard budgets={month(list)} href="/categories?month=2026-03" />);
    const items = [...html.matchAll(/<li class="min-w-0">(.*?)<\/li>/g)].map((m) => text(m[1]));
    expect(items.map((t) => t.split("€")[0])).toEqual(["All spending", "Food", "Transport", "Gifts (archived)"]);
    expect(html).toContain('href="/categories?month=2026-03"');
    expect(text(html)).toContain("All budgets (2 more)");
    expect(html).toContain('data-group-color="red"');
    expect(html).toContain('aria-labelledby="overview-budgets"');
  });

  it("with few budgets the link just manages them; in a group scope one line replaces the figures", () => {
    expect(text(renderToStaticMarkup(<BudgetsCard budgets={month([progress(2, 1, 10)])} href="/categories" />))).toContain(
      "Manage budgets",
    );
    const scoped = renderToStaticMarkup(<BudgetsCard budgets={null} href="/categories" />);
    expect(text(scoped)).toContain("Budgets cover all your wallet groups");
    expect(scoped).not.toContain("data-budget-meter");
  });
});

describe("the entry form's category picker", () => {
  it("shows a category's colour as a dot in its pill", () => {
    const options = toCategoryOptions([
      { id: 10, name: "Food", kind: "expense", archivedAt: null, color: "amber" },
      { id: 11, name: "Bills", kind: "expense", archivedAt: null, color: null },
    ]);
    expect(options).toEqual([
      { id: 10, name: "Food", kind: "expense", color: "amber" },
      { id: 11, name: "Bills", kind: "expense" },
    ]);
    const html = renderToStaticMarkup(
      <EntryForm
        wallets={[{ id: 1, name: "Cash", currency: "EUR", archived: false }]}
        categories={options}
        initial={{ kind: "expense", date: "2026-11-08" }}
        today="2026-11-08"
        transactionAction={async () => ({})}
        transferAction={async () => ({})}
        returnTo="/"
        canTransfer
      />,
    );
    expect(html).toMatch(/data-group-color="amber"[^>]*><\/span>Food<\/span>/);
    expect(html.match(/data-group-color/g)).toHaveLength(1);
  });
});
