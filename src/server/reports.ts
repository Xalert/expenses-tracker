import "server-only";
import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { categories, transactions, wallets } from "@/db/schema";
import { compareCategoryNames } from "@/lib/category-order";
import { isValidCurrency } from "@/lib/currencies";
import { isValidDate } from "@/lib/dates";
import { ServiceError } from "@/lib/errors";
import { comparisonThrough, isValidYear, yearMonths } from "@/lib/reports";
import { assertId } from "./_validate";
import { converter, currencyConditions, type ConvertOption, type Narrow } from "./insights";

// The year view (/reports). The same rules as the month services in insights.ts: expenses and income only
// (transfers never count), every wallet of `currency` — archived wallets and categories included, it is history —
// narrowed to a wallet group by `groupId`; with `convert` ("All in <currency>") every currency, each day's sums
// converted at that day's rate (`converter`), a currency without a rate left out and listed in `missingCurrencies`.
//
// One query: sums per date, kind, currency and category over the previous year and the shown year (the comparison
// needs both), then everything is added up in JS. Nothing is queried per month.

export type YearTotals = { incomeMinor: number; expenseMinor: number; netMinor: number };

export type ReportMonth = YearTotals & { month: string };

export type ReportCategoryRow = {
  categoryId: number;
  name: string;
  archived: boolean;
  /** Twelve amounts, January first. */
  months: number[];
  totalMinor: number;
};

export type YearReport = {
  year: string;
  /** The whole year: every entry dated in it (future-dated ones included, like the Overview's month figures). */
  totals: YearTotals;
  /** Twelve months, January first. */
  months: ReportMonth[];
  /**
   * The year against the previous one. For the current year both run to the same date (`through`: today and the same
   * day a year earlier), so `current` can differ from `totals` by entries dated after today; for a past year
   * `through` is null and `current` equals `totals`.
   */
  comparison: { previousYear: string; through: { current: string; previous: string } | null; current: YearTotals; previous: YearTotals };
  /** Categories with an amount in the year, largest total first (then the category name rule, then id). */
  expenseCategories: ReportCategoryRow[];
  incomeCategories: ReportCategoryRow[];
  /** With `convert` only: currencies (sorted) left out because they have no rate. */
  missingCurrencies?: string[];
};

const zero = (): YearTotals => ({ incomeMinor: 0, expenseMinor: 0, netMinor: 0 });

function add(t: YearTotals, kind: "expense" | "income", amount: number) {
  if (kind === "expense") t.expenseMinor += amount;
  else t.incomeMinor += amount;
  t.netMinor = t.incomeMinor - t.expenseMinor;
}

function sortRows(rows: ReportCategoryRow[]): ReportCategoryRow[] {
  return rows.sort(
    (a, b) => b.totalMinor - a.totalMinor || compareCategoryNames(a.name, b.name) || a.categoryId - b.categoryId,
  );
}

/**
 * One year of one currency (with `convert`: of every currency, converted into `currency`): the totals, the twelve
 * months, the comparison with the previous year and the category-by-month sums. `today` is the user's
 * (`todayInZone`); it decides the comparison's period for the current year. Invalid year → VALIDATION (field `year`).
 */
export async function getYearReport(
  userId: number,
  opts: { year: string; currency: string; today: string; groupId?: number; convert?: ConvertOption },
): Promise<YearReport> {
  if (!isValidYear(opts.year)) throw new ServiceError("VALIDATION", "Invalid year.", "year");
  if (typeof opts.currency !== "string" || !isValidCurrency(opts.currency)) {
    throw new ServiceError("VALIDATION", "Choose a valid currency.", "currency");
  }
  if (!isValidDate(opts.today)) throw new ServiceError("VALIDATION", "Invalid date.", "date");
  const { year, currency, convert } = opts;
  const narrow: Narrow = opts.groupId === undefined ? {} : { groupId: assertId(opts.groupId, "groupId", "group") };
  const previousYear = String(Number(year) - 1);
  const yearStart = `${year}-01-01`;
  const through = comparisonThrough(year, opts.today);

  const rows = await (await getDb())
    .select({
      date: transactions.date,
      kind: transactions.kind,
      currency: wallets.currency,
      categoryId: categories.id,
      name: categories.name,
      archived: sql<boolean>`${categories.archivedAt} is not null`,
      amountMinor: sql<number>`sum(${transactions.amountMinor})`.mapWith(Number),
    })
    .from(transactions)
    .innerJoin(wallets, eq(wallets.id, transactions.walletId))
    .innerJoin(categories, eq(categories.id, transactions.categoryId))
    .where(
      and(
        ...currencyConditions(userId, convert ? null : currency, narrow),
        eq(categories.userId, userId),
        inArray(transactions.kind, ["expense", "income"]),
        gte(transactions.date, `${previousYear}-01-01`),
        lte(transactions.date, `${year}-12-31`),
      ),
    )
    .groupBy(transactions.date, transactions.kind, wallets.currency, categories.id);

  const toTarget = converter(currency, convert);
  const totals = zero();
  const current = zero();
  const previous = zero();
  const months = yearMonths(year).map((month) => ({ month, ...zero() }));
  const perCategory = new Map<number, ReportCategoryRow & { kind: "expense" | "income" }>();
  const missing = new Set<string>();

  for (const r of rows) {
    const kind = r.kind as "expense" | "income";
    const amount = toTarget(r.amountMinor, r.currency, r.date);
    if (amount === null) {
      missing.add(r.currency);
      continue;
    }
    if (r.date < yearStart) {
      if (!through || r.date <= through.previous) add(previous, kind, amount);
      continue;
    }
    add(totals, kind, amount);
    if (!through || r.date <= through.current) add(current, kind, amount);
    const m = Number(r.date.slice(5, 7)) - 1;
    add(months[m], kind, amount);
    let row = perCategory.get(r.categoryId);
    if (!row) {
      row = { categoryId: r.categoryId, name: r.name, archived: Boolean(r.archived), kind, months: Array(12).fill(0), totalMinor: 0 };
      perCategory.set(r.categoryId, row);
    }
    row.months[m] += amount;
    row.totalMinor += amount;
  }

  const rowsOf = (kind: "expense" | "income") =>
    sortRows(
      [...perCategory.values()]
        .filter((c) => c.kind === kind && c.totalMinor !== 0)
        .map((c) => ({ categoryId: c.categoryId, name: c.name, archived: c.archived, months: c.months, totalMinor: c.totalMinor })),
    );

  return {
    ...(convert ? { missingCurrencies: [...missing].sort() } : {}),
    year,
    totals,
    months,
    comparison: { previousYear, through, current, previous },
    expenseCategories: rowsOf("expense"),
    incomeCategories: rowsOf("income"),
  };
}
