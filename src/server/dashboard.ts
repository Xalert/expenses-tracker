import "server-only";
import { and, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { categories, transactions, wallets } from "@/db/schema";
import { currentMonth, isValidMonth, monthRange } from "@/lib/dates";
import { ServiceError } from "@/lib/errors";
import { listTransactions, type TransactionView } from "./transactions";
import { listWallets, type WalletView } from "./wallets";

export type CurrencyTotals = { currency: string; balanceMinor: number; incomeMinor: number; expenseMinor: number };
export type CategorySpend = { currency: string; categoryId: number; categoryName: string; amountMinor: number };

export type Dashboard = {
  month: string;
  /** Active wallets only. */
  wallets: WalletView[];
  /** One row per currency held in an active wallet (sorted by code); income/expense are for `month`, transfers excluded. */
  totalsByCurrency: CurrencyTotals[];
  /** Expenses in `month` on active wallets, per currency + category, largest first. */
  expenseByCategory: CategorySpend[];
  /** Latest 8 transactions across all wallets (of the group, when one is given). */
  recent: TransactionView[];
};

export const RECENT_COUNT = 8;

export async function getDashboard(
  userId: number,
  opts: { month?: string; groupId?: number } = {},
): Promise<Dashboard> {
  const month = opts.month ?? currentMonth();
  if (!isValidMonth(month)) throw new ServiceError("VALIDATION", "Invalid month.", "month");
  const { from, to } = monthRange(month);
  const db = await getDb();

  const activeWallets = await listWallets(userId, { groupId: opts.groupId });

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

  const expenseByCategory = await db
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
    .orderBy(desc(sql`sum(${transactions.amountMinor})`), categories.name);

  return {
    month,
    wallets: activeWallets,
    totalsByCurrency: [...totals.values()].sort((a, b) => a.currency.localeCompare(b.currency)),
    expenseByCategory,
    recent: (await listTransactions(userId, { limit: RECENT_COUNT, groupId: opts.groupId })).items,
  };
}
