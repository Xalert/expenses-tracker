import "server-only";
import { and, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { categories, transactions, wallets } from "@/db/schema";
import { compareCategoryNames } from "@/lib/category-order";
import { isValidMonth, monthRange } from "@/lib/dates";
import { ServiceError } from "@/lib/errors";
import { listTransactions, type TransactionView } from "./transactions";
import { walletInOpenGroupSql } from "./wallet-groups";
import { assertDate } from "./_validate";
import { listWallets, type WalletWithBalance } from "./wallets";

export type CurrencyTotals = { currency: string; balanceMinor: number; incomeMinor: number; expenseMinor: number };
export type CategorySpend = { currency: string; categoryId: number; categoryName: string; amountMinor: number };

export type Dashboard = {
  month: string;
  /** Active wallets only, with their balances at the end of `balanceOn`. */
  wallets: WalletWithBalance[];
  /**
   * One row per currency held in an active wallet (sorted by code): the balance is the sum of those wallets' balances
   * at the end of `balanceOn`; income/expense are for `month`, transfers excluded.
   */
  totalsByCurrency: CurrencyTotals[];
  /** Expenses in `month` on active wallets, per currency + category, largest first. */
  expenseByCategory: CategorySpend[];
  /** Latest 8 transactions across all wallets (of the group, when one is given). */
  recent: TransactionView[];
};

export const RECENT_COUNT = 8;

/**
 * `month` and `balanceOn` are required: the caller decides which month is current and the day the balances are at
 * the end of — the user's today (`todayInZone`) for the current month, the month's last day for a past one.
 */
export async function getDashboard(
  userId: number,
  opts: { month: string; balanceOn: string; groupId?: number },
): Promise<Dashboard> {
  const month = opts.month;
  if (!isValidMonth(month)) throw new ServiceError("VALIDATION", "Invalid month.", "month");
  const balanceOn = assertDate(opts.balanceOn, "balanceOn");
  const { from, to } = monthRange(month);
  const db = await getDb();

  const activeWallets = await listWallets(userId, { groupId: opts.groupId, balanceOn });

  const totals = new Map<string, CurrencyTotals>();
  for (const w of activeWallets) {
    const t = totals.get(w.currency) ?? { currency: w.currency, balanceMinor: 0, incomeMinor: 0, expenseMinor: 0 };
    t.balanceMinor += w.balanceMinor;
    totals.set(w.currency, t);
  }

  const inMonthOnActive = and(
    eq(transactions.userId, userId),
    eq(wallets.userId, userId),
    isNull(wallets.archivedAt),
    walletInOpenGroupSql, // a wallet in an archived group counts as archived
    opts.groupId === undefined ? undefined : eq(wallets.groupId, opts.groupId),
    gte(transactions.date, from),
    lte(transactions.date, to),
  );

  const flows = await db
    .select({
      currency: wallets.currency,
      kind: transactions.kind,
      amountMinor: sql<number>`sum(${transactions.amountMinor})`.mapWith(Number),
    })
    .from(transactions)
    .innerJoin(wallets, eq(wallets.id, transactions.walletId))
    .where(and(inMonthOnActive, inArray(transactions.kind, ["income", "expense"])))
    .groupBy(wallets.currency, transactions.kind);
  for (const f of flows) {
    const t = totals.get(f.currency);
    if (!t) continue;
    if (f.kind === "income") t.incomeMinor += f.amountMinor;
    else t.expenseMinor += f.amountMinor;
  }

  // Largest first; ties by the category order's name rule (not the database collation), then id.
  const expenseByCategory = (
    await db
    .select({
      currency: wallets.currency,
      categoryId: categories.id,
      categoryName: categories.name,
      amountMinor: sql<number>`sum(${transactions.amountMinor})`.mapWith(Number),
    })
    .from(transactions)
    .innerJoin(wallets, eq(wallets.id, transactions.walletId))
    .innerJoin(categories, eq(categories.id, transactions.categoryId))
    .where(and(inMonthOnActive, eq(transactions.kind, "expense")))
    .groupBy(wallets.currency, categories.id)
  ).sort(
    (a, b) =>
      b.amountMinor - a.amountMinor || compareCategoryNames(a.categoryName, b.categoryName) || a.categoryId - b.categoryId,
  );

  return {
    month,
    wallets: activeWallets,
    totalsByCurrency: [...totals.values()].sort((a, b) => a.currency.localeCompare(b.currency)),
    expenseByCategory,
    recent: (await listTransactions(userId, { limit: RECENT_COUNT, groupId: opts.groupId })).items,
  };
}
