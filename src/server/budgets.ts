import "server-only";
import { and, eq, gte, isNull, lte, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { budgets, categories, transactions, wallets } from "@/db/schema";
import { compareCategories } from "@/lib/category-order";
import { isValidCurrency } from "@/lib/currencies";
import { isValidMonth, monthRange } from "@/lib/dates";
import { ServiceError } from "@/lib/errors";
import { convertMinor, tableFor, type Conversion } from "@/lib/fx";
import { isGroupColor, type GroupColor } from "@/lib/group-colors";
import { assertDate, isPgId, isUniqueViolation } from "./_validate";
import { monthDayN } from "./insights";

// Monthly spending limits (docs/SPEC.md "Budgets"). One per expense category and one overall (`categoryId` null) per
// user; one amount in one currency that applies to every month (no history). Progress is always measured in the
// budget's own currency over every wallet (archived included, every wallet group): the month's expenses in the
// category (the overall budget: all expenses), each currency converted at the rate of the entry's date, as the "All
// in <currency>" views do (`convert`, from `getConversion`). A currency without a rate that day is left out and named
// in `missingCurrencies`. Transfers never count.

export type BudgetView = {
  id: number;
  /** null: the overall budget. */
  categoryId: number | null;
  currency: string;
  amountMinor: number;
};

export type BudgetProgress = BudgetView & {
  /** null for the overall budget. */
  category: { name: string; archived: boolean; color: GroupColor | null } | null;
  /** The month's expenses in the budget's currency (converted where needed; missing currencies left out). */
  spentMinor: number;
  /** amountMinor − spentMinor: negative when over. */
  remainingMinor: number;
  /** Currencies (sorted) whose spending this month is left out because there is no rate for them. */
  missingCurrencies: string[];
};

export type MonthBudgets = {
  month: string;
  /** The overall budget first, then the category budgets in the category order. */
  budgets: BudgetProgress[];
  /** The current month only: how far through it today is (day N of `days`). Null for a past month. */
  elapsed: { day: number; days: number } | null;
};

const viewColumns = {
  id: budgets.id,
  categoryId: budgets.categoryId,
  currency: budgets.currency,
  amountMinor: budgets.amountMinor,
};

/** The overall budget first, then by category id. */
function byOverallThenCategory(a: BudgetView, b: BudgetView): number {
  if (a.categoryId === null) return b.categoryId === null ? 0 : -1;
  if (b.categoryId === null) return 1;
  return a.categoryId - b.categoryId;
}

/** The user's budgets: the overall one first (when there is one), then by category id. */
export async function listBudgets(userId: number): Promise<BudgetView[]> {
  const rows = await (await getDb()).select(viewColumns).from(budgets).where(eq(budgets.userId, userId));
  return rows.sort(byOverallThenCategory);
}

/** The currencies of the user's wallets, archived included, sorted. */
async function heldCurrencies(userId: number): Promise<string[]> {
  const rows = await (await getDb())
    .selectDistinct({ currency: wallets.currency })
    .from(wallets)
    .where(eq(wallets.userId, userId));
  return rows.map((r) => r.currency).sort();
}

/**
 * Create or replace the budget of an owned expense category (`categoryId`), or the overall one (`categoryId: null`).
 * `currency` must be one the user holds a wallet in (archived wallets count; VALIDATION on `currency`), `amountMinor`
 * a positive whole number of its minor units (VALIDATION on `amount`; the caller parses the typed amount with
 * `parseAmount(value, currency)`). Another user's category or a missing one → NOT_FOUND (field `categoryId`); an
 * income category → VALIDATION (field `categoryId`). Archived categories may have a budget. The category row is read
 * `FOR SHARE`, so a concurrent kind change (which removes the budget) waits.
 */
export async function setBudget(
  userId: number,
  input: { categoryId: number | null; currency: string; amountMinor: number },
): Promise<BudgetView> {
  const categoryId = input.categoryId;
  if (categoryId !== null && !isPgId(categoryId)) {
    throw new ServiceError("NOT_FOUND", "Category not found.", "categoryId");
  }
  const currency = typeof input.currency === "string" ? input.currency.trim().toUpperCase() : "";
  if (!isValidCurrency(currency)) throw new ServiceError("VALIDATION", "Choose a currency.", "currency");
  const amountMinor = input.amountMinor;
  if (typeof amountMinor !== "number" || !Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw new ServiceError("VALIDATION", "Enter an amount greater than zero.", "amount");
  }
  const held = await heldCurrencies(userId);
  if (!held.includes(currency)) {
    throw new ServiceError(
      "VALIDATION",
      held.length === 0
        ? "Add a wallet first: a budget is in the currency of one of your wallets."
        : `Choose the currency of one of your wallets (${held.join(", ")}).`,
      "currency",
    );
  }

  const write = async () => {
    const db = await getDb();
    return await db.transaction(async (tx) => {
      if (categoryId !== null) {
        const [category] = await tx
          .select({ kind: categories.kind })
          .from(categories)
          .where(and(eq(categories.id, categoryId), eq(categories.userId, userId)))
          .for("share");
        if (!category) throw new ServiceError("NOT_FOUND", "Category not found.", "categoryId");
        if (category.kind !== "expense") {
          throw new ServiceError("VALIDATION", "Budgets are for expense categories only.", "categoryId");
        }
      }
      const own = and(
        eq(budgets.userId, userId),
        categoryId === null ? isNull(budgets.categoryId) : eq(budgets.categoryId, categoryId),
      );
      const [updated] = await tx.update(budgets).set({ currency, amountMinor }).where(own).returning(viewColumns);
      if (updated) return updated;
      const [created] = await tx.insert(budgets).values({ userId, categoryId, currency, amountMinor }).returning(viewColumns);
      return created;
    });
  };
  try {
    return await write();
  } catch (err) {
    // Created at the same moment by another request: the second write then finds it and replaces it.
    if (isUniqueViolation(err)) return await write();
    throw err;
  }
}

/**
 * Remove the budget of a category (`categoryId`) or the overall one (null). True when there was one; another user's
 * category, a missing one or one without a budget → false (nothing to remove).
 */
export async function removeBudget(userId: number, categoryId: number | null): Promise<boolean> {
  if (categoryId !== null && !isPgId(categoryId)) return false;
  const removed = await (await getDb())
    .delete(budgets)
    .where(
      and(
        eq(budgets.userId, userId),
        categoryId === null ? isNull(budgets.categoryId) : eq(budgets.categoryId, categoryId),
      ),
    )
    .returning({ id: budgets.id });
  return removed.length > 0;
}

/**
 * Every budget's progress in `month` (YYYY-MM): what was spent against it (see the note at the top), what is left
 * and the currencies left out for want of a rate. `today` is the user's (`todayInZone`): it gives `elapsed` for the
 * current month. `convert` is the rates for the month (`getConversion(userId, monthStart, monthEnd)`); without it only
 * spending already in a budget's currency counts and every other currency is listed as missing.
 */
export async function getMonthBudgets(
  userId: number,
  opts: { month: string; today: string; convert?: Conversion },
): Promise<MonthBudgets> {
  if (!isValidMonth(opts.month)) throw new ServiceError("VALIDATION", "Invalid month.", "month");
  const month = opts.month;
  const today = assertDate(opts.today, "today");
  const { from, to } = monthRange(month);
  const db = await getDb();

  const list = await db
    .select({
      ...viewColumns,
      categoryName: categories.name,
      categoryArchivedAt: categories.archivedAt,
      categoryColor: categories.color,
    })
    .from(budgets)
    .leftJoin(categories, eq(categories.id, budgets.categoryId))
    .where(eq(budgets.userId, userId));

  const days = Number(to.slice(8));
  const n = monthDayN(month, today);
  const elapsed = month === today.slice(0, 7) ? { day: n, days } : null;
  if (list.length === 0) return { month, budgets: [], elapsed };

  // The month's expenses per category, date and currency (each sum is converted once, at that date's rate).
  const rows = await db
    .select({
      categoryId: transactions.categoryId,
      date: transactions.date,
      currency: wallets.currency,
      amountMinor: sql<number>`sum(${transactions.amountMinor})`.mapWith(Number),
    })
    .from(transactions)
    .innerJoin(wallets, eq(wallets.id, transactions.walletId))
    .where(
      and(
        eq(transactions.userId, userId),
        eq(wallets.userId, userId),
        eq(transactions.kind, "expense"),
        gte(transactions.date, from),
        lte(transactions.date, to),
      ),
    )
    .groupBy(transactions.categoryId, transactions.date, wallets.currency);

  const progress = list.map((b): BudgetProgress => {
    let spentMinor = 0;
    const missing = new Set<string>();
    for (const r of rows) {
      if (b.categoryId !== null && r.categoryId !== b.categoryId) continue;
      const value =
        r.currency === b.currency ? r.amountMinor : convertMinor(r.amountMinor, r.currency, b.currency, tableFor(opts.convert, r.date));
      if (value === null) missing.add(r.currency);
      else spentMinor += value;
    }
    return {
      id: b.id,
      categoryId: b.categoryId,
      currency: b.currency,
      amountMinor: b.amountMinor,
      category:
        b.categoryId === null || b.categoryName === null
          ? null
          : {
              name: b.categoryName,
              archived: b.categoryArchivedAt !== null,
              color: isGroupColor(b.categoryColor) ? b.categoryColor : null,
            },
      spentMinor,
      remainingMinor: b.amountMinor - spentMinor,
      missingCurrencies: [...missing].sort(),
    };
  });

  // Overall first, then the category order (active before archived, then by name).
  const listed = (p: BudgetProgress) => ({
    id: p.categoryId ?? 0,
    name: p.category?.name ?? "",
    kind: "expense" as const,
    archivedAt: p.category?.archived ? new Date(0) : null,
  });
  const overall = progress.filter((p) => p.category === null);
  const ordered = progress.filter((p) => p.category !== null).sort((a, b) => compareCategories(listed(a), listed(b)));
  return { month, budgets: [...overall, ...ordered], elapsed };
}
