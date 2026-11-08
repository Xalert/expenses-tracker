import "server-only";
import { and, asc, count, desc, eq, gte, inArray, isNull, lt, lte, sql, type SQL } from "drizzle-orm";
import { getDb } from "@/db";
import { categories, transactions, wallets } from "@/db/schema";
import { isValidCurrency } from "@/lib/currencies";
import { isValidMonth, monthRange, shiftMonth, todayISO } from "@/lib/dates";
import { ServiceError } from "@/lib/errors";
import { assertId } from "./_validate";
import { signedAmountSql } from "./wallets";

// Per-currency month figures for the redesigned Overview, wallet page and charts. Every figure is for ONE currency
// and nothing is converted. "Expense" / "income" mean transactions of those kinds (transfers excluded) on every
// wallet of that currency, archived included, unless a `walletId` narrows it — so the numbers match the
// Transactions list. Day N is today's day of the month for the current month, the month's last day for a past
// month, and 0 for a future month (server local time).

export type TimelineDay = { date: string; expenseMinor: number; incomeMinor: number };
export type MonthTimeline = {
  /** Every calendar day of the month, zeros included. */
  days: TimelineDay[];
  /** Running expense total per day of the previous month (index 0 = day 1), one entry per day of that month. */
  previousCumulativeMinor: number[];
  /** The month's biggest expense day; `label` is its largest entry's note, else that entry's category name. */
  largestDay: { date: string; amountMinor: number; label: string } | null;
};

export type MonthInsights = {
  incomeMinor: number;
  expenseMinor: number;
  /** income − expense. */
  netMinor: number;
  /** `sharePercent` is rounded to a whole percent of the month's expenses. */
  topCategory: { categoryId: number; categoryName: string; amountMinor: number; sharePercent: number } | null;
  /** Cumulative expenses through day N vs through min(N, previous month's length) of the previous month. */
  pace: { day: number; thisMonthMinor: number; previousMonthMinor: number };
  /** Days 1..N with no expense in this currency; `previous*` is the whole previous month. */
  noSpendDays: { days: number; outOf: number; previousDays: number; previousOutOf: number };
};

export type WalletMonthDay = { date: string; inMinor: number; outMinor: number; closingMinor: number };
export type WalletMonth = {
  /** Balance at the start of the month: initial balance + every entry dated before the month. */
  openingMinor: number;
  /** This month (the whole month), transfers included. */
  inMinor: number;
  outMinor: number;
  /** Entries this month / ever. */
  entryCount: number;
  totalEntryCount: number;
  /** Days 1..N; `closingMinor` is the balance after that day. */
  days: WalletMonthDay[];
};

// ---------------------------------------------------------------------------------------------
// Helpers

function assertMonth(month: unknown): string {
  if (!isValidMonth(month)) throw new ServiceError("VALIDATION", "Invalid month.", "month");
  return month;
}

function assertCurrency(currency: unknown): string {
  if (typeof currency !== "string" || !isValidCurrency(currency)) {
    throw new ServiceError("VALIDATION", "Choose a valid currency.", "currency");
  }
  return currency;
}

/** Number of days in a valid `YYYY-MM` month. */
function monthLength(month: string): number {
  return Number(monthRange(month).to.slice(8));
}

/** Every date of a month, in order. */
function monthDates(month: string): string[] {
  return Array.from({ length: monthLength(month) }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`);
}

/** Day N: today's day for the current month, the last day for a past month, 0 for a future month. */
export function monthDayN(month: string, today: string = todayISO()): number {
  const current = today.slice(0, 7);
  if (month === current) return Number(today.slice(8));
  return month < current ? monthLength(month) : 0;
}

type Narrow = { walletId?: number; categoryId?: number };

/** Conditions for this user's income/expense rows on wallets of `currency`, optionally narrowed. */
function currencyConditions(userId: number, currency: string, narrow: Narrow = {}): SQL[] {
  const conds: SQL[] = [
    eq(transactions.userId, userId),
    eq(wallets.userId, userId),
    eq(wallets.currency, currency),
  ];
  if (narrow.walletId !== undefined) conds.push(eq(transactions.walletId, narrow.walletId));
  if (narrow.categoryId !== undefined) conds.push(eq(transactions.categoryId, narrow.categoryId));
  return conds;
}

/** Expense and income per date in [from, to] for one currency. */
function dailyFlows(
  userId: number,
  currency: string,
  from: string,
  to: string,
  narrow: Narrow = {},
): Map<string, { expenseMinor: number; incomeMinor: number }> {
  const rows = getDb()
    .select({
      date: transactions.date,
      kind: transactions.kind,
      amountMinor: sql<number>`sum(${transactions.amountMinor})`,
    })
    .from(transactions)
    .innerJoin(wallets, eq(wallets.id, transactions.walletId))
    .where(
      and(
        ...currencyConditions(userId, currency, narrow),
        inArray(transactions.kind, ["expense", "income"]),
        gte(transactions.date, from),
        lte(transactions.date, to),
      ),
    )
    .groupBy(transactions.date, transactions.kind)
    .all();
  const byDate = new Map<string, { expenseMinor: number; incomeMinor: number }>();
  for (const r of rows) {
    const d = byDate.get(r.date) ?? { expenseMinor: 0, incomeMinor: 0 };
    if (r.kind === "expense") d.expenseMinor += r.amountMinor;
    else d.incomeMinor += r.amountMinor;
    byDate.set(r.date, d);
  }
  return byDate;
}

const expenseOn = (flows: Map<string, { expenseMinor: number }>, date: string) => flows.get(date)?.expenseMinor ?? 0;

// ---------------------------------------------------------------------------------------------
// Currencies

/** Currencies of the user's active wallets, by code. */
export function listUserCurrencies(userId: number): string[] {
  return getDb()
    .selectDistinct({ currency: wallets.currency })
    .from(wallets)
    .where(and(eq(wallets.userId, userId), isNull(wallets.archivedAt)))
    .orderBy(asc(wallets.currency))
    .all()
    .map((r) => r.currency);
}

/**
 * The currency with the most expense + income entries in `month` (every wallet, archived included). On a tie for
 * the most, or when the month has none: the currency of the active wallet with the most transactions overall
 * (then by code). No active wallets then → null. The result can be a currency held only in archived wallets.
 */
export function pickDefaultCurrency(userId: number, month: string): string | null {
  const { from, to } = monthRange(assertMonth(month));
  const db = getDb();
  const busiest = db
    .select({ currency: wallets.currency, n: count() })
    .from(transactions)
    .innerJoin(wallets, eq(wallets.id, transactions.walletId))
    .where(
      and(
        eq(transactions.userId, userId),
        eq(wallets.userId, userId),
        inArray(transactions.kind, ["expense", "income"]),
        gte(transactions.date, from),
        lte(transactions.date, to),
      ),
    )
    .groupBy(wallets.currency)
    .orderBy(desc(count()), asc(wallets.currency))
    .limit(2)
    .all();
  if (busiest.length === 1 || (busiest.length === 2 && busiest[0].n > busiest[1].n)) return busiest[0].currency;

  const fallback = db
    .select({ currency: wallets.currency, n: count(transactions.id) })
    .from(wallets)
    .leftJoin(transactions, eq(transactions.walletId, wallets.id))
    .where(and(eq(wallets.userId, userId), isNull(wallets.archivedAt)))
    .groupBy(wallets.id)
    .orderBy(desc(count(transactions.id)), asc(wallets.currency))
    .limit(1)
    .get();
  return fallback?.currency ?? null;
}

// ---------------------------------------------------------------------------------------------
// Month figures

/** Per-day expenses / income of one currency for the month chart, plus the previous month's running total. */
export function getMonthTimeline(
  userId: number,
  opts: { month: string; currency: string; walletId?: number; categoryId?: number },
): MonthTimeline {
  const month = assertMonth(opts.month);
  const currency = assertCurrency(opts.currency);
  const narrow: Narrow = {};
  if (opts.walletId !== undefined) narrow.walletId = assertId(opts.walletId, "walletId", "wallet");
  if (opts.categoryId !== undefined) narrow.categoryId = assertId(opts.categoryId, "categoryId", "category");

  const previous = shiftMonth(month, -1);
  const flows = dailyFlows(userId, currency, monthRange(previous).from, monthRange(month).to, narrow);

  const days = monthDates(month).map((date) => ({
    date,
    expenseMinor: flows.get(date)?.expenseMinor ?? 0,
    incomeMinor: flows.get(date)?.incomeMinor ?? 0,
  }));

  let running = 0;
  const previousCumulativeMinor = monthDates(previous).map((date) => (running += expenseOn(flows, date)));

  // Highest expense day; the earliest one on a tie.
  let top: TimelineDay | null = null;
  for (const d of days) if (d.expenseMinor > 0 && (!top || d.expenseMinor > top.expenseMinor)) top = d;

  let largestDay: MonthTimeline["largestDay"] = null;
  if (top) {
    const entry = getDb()
      .select({ note: transactions.note, categoryName: categories.name })
      .from(transactions)
      .innerJoin(wallets, eq(wallets.id, transactions.walletId))
      .leftJoin(categories, eq(categories.id, transactions.categoryId))
      .where(
        and(
          ...currencyConditions(userId, currency, narrow),
          eq(transactions.kind, "expense"),
          eq(transactions.date, top.date),
        ),
      )
      .orderBy(desc(transactions.amountMinor), asc(transactions.id))
      .limit(1)
      .get();
    largestDay = {
      date: top.date,
      amountMinor: top.expenseMinor,
      label: entry?.note || entry?.categoryName || "",
    };
  }

  return { days, previousCumulativeMinor, largestDay };
}

/** The Overview insight cards for one month and currency. */
export function getMonthInsights(userId: number, opts: { month: string; currency: string }): MonthInsights {
  const month = assertMonth(opts.month);
  const currency = assertCurrency(opts.currency);
  const previous = shiftMonth(month, -1);
  const { from, to } = monthRange(month);
  const flows = dailyFlows(userId, currency, monthRange(previous).from, to);

  const dates = monthDates(month);
  const previousDates = monthDates(previous);
  let incomeMinor = 0;
  let expenseMinor = 0;
  for (const date of dates) {
    incomeMinor += flows.get(date)?.incomeMinor ?? 0;
    expenseMinor += expenseOn(flows, date);
  }

  const n = monthDayN(month);
  const throughN = dates.slice(0, n);
  const previousThroughN = previousDates.slice(0, Math.min(n, previousDates.length));
  const sumExpenses = (ds: string[]) => ds.reduce((s, d) => s + expenseOn(flows, d), 0);
  const countNoSpend = (ds: string[]) => ds.filter((d) => expenseOn(flows, d) === 0).length;

  const top = getDb()
    .select({
      categoryId: categories.id,
      categoryName: categories.name,
      amountMinor: sql<number>`sum(${transactions.amountMinor})`,
    })
    .from(transactions)
    .innerJoin(wallets, eq(wallets.id, transactions.walletId))
    .innerJoin(categories, eq(categories.id, transactions.categoryId))
    .where(
      and(
        ...currencyConditions(userId, currency),
        eq(transactions.kind, "expense"),
        gte(transactions.date, from),
        lte(transactions.date, to),
      ),
    )
    .groupBy(categories.id)
    .orderBy(desc(sql`sum(${transactions.amountMinor})`), sql`${categories.name} collate nocase`, asc(categories.id))
    .limit(1)
    .get();

  return {
    incomeMinor,
    expenseMinor,
    netMinor: incomeMinor - expenseMinor,
    topCategory:
      top && expenseMinor > 0 ? { ...top, sharePercent: Math.round((top.amountMinor * 100) / expenseMinor) } : null,
    pace: { day: n, thisMonthMinor: sumExpenses(throughN), previousMonthMinor: sumExpenses(previousThroughN) },
    noSpendDays: {
      days: countNoSpend(throughN),
      outOf: throughN.length,
      previousDays: countNoSpend(previousDates),
      previousOutOf: previousDates.length,
    },
  };
}

/** One wallet's month: opening balance, money in / out (transfers included) and the balance after each day 1..N. */
export function getWalletMonth(userId: number, walletId: number, month: string): WalletMonth | null {
  const { from, to } = monthRange(assertMonth(month));
  if (typeof walletId !== "number" || !Number.isSafeInteger(walletId)) return null;
  const db = getDb();
  const wallet = db
    .select({ initialBalanceMinor: wallets.initialBalanceMinor })
    .from(wallets)
    .where(and(eq(wallets.id, walletId), eq(wallets.userId, userId)))
    .get();
  if (!wallet) return null;

  const own = and(eq(transactions.walletId, walletId), eq(transactions.userId, userId));
  const before = db
    .select({ net: sql<number>`coalesce(sum(${signedAmountSql}), 0)`, n: count() })
    .from(transactions)
    .where(and(own, lt(transactions.date, from)))
    .get();
  const after = db
    .select({ n: count() })
    .from(transactions)
    .where(and(own, sql`${transactions.date} > ${to}`))
    .get();
  const perDay = db
    .select({
      date: transactions.date,
      inMinor: sql<number>`coalesce(sum(case when ${transactions.kind} in ('income', 'transfer_in') then ${transactions.amountMinor} else 0 end), 0)`,
      outMinor: sql<number>`coalesce(sum(case when ${transactions.kind} in ('expense', 'transfer_out') then ${transactions.amountMinor} else 0 end), 0)`,
      n: count(),
    })
    .from(transactions)
    .where(and(own, gte(transactions.date, from), lte(transactions.date, to)))
    .groupBy(transactions.date)
    .all();
  const byDate = new Map(perDay.map((r) => [r.date, r]));

  const openingMinor = wallet.initialBalanceMinor + (before?.net ?? 0);
  let inMinor = 0;
  let outMinor = 0;
  let entryCount = 0;
  for (const r of perDay) {
    inMinor += r.inMinor;
    outMinor += r.outMinor;
    entryCount += r.n;
  }

  let balance = openingMinor;
  const days = monthDates(month)
    .slice(0, monthDayN(month))
    .map((date) => {
      const r = byDate.get(date);
      const dayIn = r?.inMinor ?? 0;
      const dayOut = r?.outMinor ?? 0;
      balance += dayIn - dayOut;
      return { date, inMinor: dayIn, outMinor: dayOut, closingMinor: balance };
    });

  return {
    openingMinor,
    inMinor,
    outMinor,
    entryCount,
    totalEntryCount: (before?.n ?? 0) + entryCount + (after?.n ?? 0),
    days,
  };
}
