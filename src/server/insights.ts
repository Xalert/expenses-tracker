import "server-only";
import { and, asc, count, desc, eq, gte, inArray, isNull, lt, lte, sql, type SQL } from "drizzle-orm";
import { getDb } from "@/db";
import { categories, transactions, wallets } from "@/db/schema";
import { compareCategoryNames } from "@/lib/category-order";
import { isValidCurrency } from "@/lib/currencies";
import { isValidMonth, monthRange, shiftMonth } from "@/lib/dates";
import { ServiceError } from "@/lib/errors";
import { convertMinor, tableFor, type Conversion } from "@/lib/fx";
import { assertDate, assertId, isPgId } from "./_validate";
import { signedAmountSql } from "./wallets";

// Per-currency month figures for the redesigned Overview, wallet page and charts. Every figure is for ONE currency
// and nothing is converted. "Expense" / "income" mean transactions of those kinds (transfers excluded) on every
// wallet of that currency, archived included, unless a `walletId` narrows it — so the numbers match the
// Transactions list. Day N is today's day of the month for the current month, the month's last day for a past
// month, and 0 for a future month; "today" is the user's (`todayInZone`), passed in by the caller.
//
// The one exception is `convert` (view "All in <currency>" on Overview, the /transactions day strip and
// /categories): the month figures then cover every wallet, each currency converted into `currency` at the rate of
// the entry's own date (`tableFor`: the provider's rate, else the user's own). Amounts are summed per date, kind and
// currency first and each sum is converted once. A currency without a rate is left out and listed in
// `missingCurrencies`.

/** Convert every other currency into the requested one with these rates (`getConversion`). */
export type ConvertOption = Conversion;

export type TimelineDay = { date: string; expenseMinor: number; incomeMinor: number };
export type MonthTimeline = {
  /** Every calendar day of the month, zeros included. */
  days: TimelineDay[];
  /** Running expense total per day of the previous month (index 0 = day 1), one entry per day of that month. */
  previousCumulativeMinor: number[];
  /** The month's biggest expense day; `label` is its largest entry's note, else that entry's category name. */
  largestDay: { date: string; amountMinor: number; label: string } | null;
  /** With `convert` only: currencies (sorted) left out because they have no rate. */
  missingCurrencies?: string[];
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
  /** With `convert` only: currencies (sorted) left out because they have no rate. */
  missingCurrencies?: string[];
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
  /**
   * Days N+1..the end of the month (empty for a past month), the closing balances carried on from `days` through
   * the future-dated entries: the wallet page's "Balance after … · projected". Not drawn by the charts.
   */
  projectedDays: WalletMonthDay[];
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

/**
 * Day N: today's day for the current month, the last day for a past month, 0 for a future month. `today` is the
 * user's (`todayInZone`).
 */
export function monthDayN(month: string, today: string): number {
  const current = today.slice(0, 7);
  if (month === current) return Number(today.slice(8));
  return month < current ? monthLength(month) : 0;
}

export type Narrow = { walletId?: number; groupId?: number; categoryId?: number };

/**
 * Conditions for this user's rows on wallets of `currency` (null: every currency), optionally narrowed. Exported for
 * the year report (`reports.ts`).
 */
export function currencyConditions(userId: number, currency: string | null, narrow: Narrow = {}): SQL[] {
  const conds: SQL[] = [eq(transactions.userId, userId), eq(wallets.userId, userId)];
  if (currency !== null) conds.push(eq(wallets.currency, currency));
  if (narrow.walletId !== undefined) conds.push(eq(transactions.walletId, narrow.walletId));
  else if (narrow.groupId !== undefined) conds.push(eq(wallets.groupId, narrow.groupId));
  if (narrow.categoryId !== undefined) conds.push(eq(transactions.categoryId, narrow.categoryId));
  return conds;
}

/**
 * `amountMinor` in `from` on `date` → minor units of `to`: unchanged without `convert`, else at that date's rate
 * (null when there is none; the caller adds `from` to its missing set). Exported for the year report (`reports.ts`).
 */
export function converter(to: string, convert: ConvertOption | undefined) {
  return (amountMinor: number, from: string, date: string): number | null =>
    !convert || from === to ? amountMinor : convertMinor(amountMinor, from, to, tableFor(convert, date));
}

/**
 * Expense and income per date in [from, to] for one currency; with `convert`, for every currency converted into
 * `currency`, plus the currencies left out.
 */
async function dailyFlows(
  userId: number,
  currency: string,
  from: string,
  to: string,
  narrow: Narrow = {},
  convert?: ConvertOption,
): Promise<{ byDate: Map<string, { expenseMinor: number; incomeMinor: number }>; missing: Set<string> }> {
  const rows = await (await getDb())
    .select({
      date: transactions.date,
      kind: transactions.kind,
      currency: wallets.currency,
      amountMinor: sql<number>`sum(${transactions.amountMinor})`.mapWith(Number),
    })
    .from(transactions)
    .innerJoin(wallets, eq(wallets.id, transactions.walletId))
    .where(
      and(
        ...currencyConditions(userId, convert ? null : currency, narrow),
        inArray(transactions.kind, ["expense", "income"]),
        gte(transactions.date, from),
        lte(transactions.date, to),
      ),
    )
    .groupBy(transactions.date, transactions.kind, wallets.currency);
  const toTarget = converter(currency, convert);
  const byDate = new Map<string, { expenseMinor: number; incomeMinor: number }>();
  const missing = new Set<string>();
  for (const r of rows) {
    const amount = toTarget(r.amountMinor, r.currency, r.date);
    if (amount === null) {
      missing.add(r.currency);
      continue;
    }
    const d = byDate.get(r.date) ?? { expenseMinor: 0, incomeMinor: 0 };
    if (r.kind === "expense") d.expenseMinor += amount;
    else d.incomeMinor += amount;
    byDate.set(r.date, d);
  }
  return { byDate, missing };
}

const sorted = (set: Set<string>) => [...set].sort();

const expenseOn = (flows: Map<string, { expenseMinor: number }>, date: string) => flows.get(date)?.expenseMinor ?? 0;

// ---------------------------------------------------------------------------------------------
// Currencies

/** Currencies of the user's active wallets, by code. */
export async function listUserCurrencies(userId: number, opts: { groupId?: number } = {}): Promise<string[]> {
  const rows = await (await getDb())
    .selectDistinct({ currency: wallets.currency })
    .from(wallets)
    .where(
      and(
        eq(wallets.userId, userId),
        isNull(wallets.archivedAt),
        opts.groupId === undefined ? undefined : eq(wallets.groupId, opts.groupId),
      ),
    )
    .orderBy(asc(wallets.currency));
  return rows.map((r) => r.currency);
}

/**
 * The currency with the most expense + income entries in `month` (every wallet, archived included). On a tie for
 * the most, or when the month has none: the currency of the active wallet with the most transactions overall
 * (then by code). No active wallets then → null. The result can be a currency held only in archived wallets.
 */
export async function pickDefaultCurrency(
  userId: number,
  month: string,
  opts: { groupId?: number } = {},
): Promise<string | null> {
  const { from, to } = monthRange(assertMonth(month));
  return pickDefaultCurrencyBetween(userId, from, to, opts);
}

/** `pickDefaultCurrency`'s rule over the dates [from, to] (both valid `YYYY-MM-DD`): a year on /reports. */
export async function pickDefaultCurrencyBetween(
  userId: number,
  from: string,
  to: string,
  opts: { groupId?: number } = {},
): Promise<string | null> {
  const db = await getDb();
  const inGroup = opts.groupId === undefined ? undefined : eq(wallets.groupId, opts.groupId);
  const busiest = await db
    .select({ currency: wallets.currency, n: count() })
    .from(transactions)
    .innerJoin(wallets, eq(wallets.id, transactions.walletId))
    .where(
      and(
        eq(transactions.userId, userId),
        eq(wallets.userId, userId),
        inGroup,
        inArray(transactions.kind, ["expense", "income"]),
        gte(transactions.date, from),
        lte(transactions.date, to),
      ),
    )
    .groupBy(wallets.currency)
    .orderBy(desc(count()), asc(wallets.currency))
    .limit(2);
  if (busiest.length === 1 || (busiest.length === 2 && busiest[0].n > busiest[1].n)) return busiest[0].currency;

  const [fallback] = await db
    .select({ currency: wallets.currency, n: count(transactions.id) })
    .from(wallets)
    .leftJoin(transactions, eq(transactions.walletId, wallets.id))
    .where(and(eq(wallets.userId, userId), isNull(wallets.archivedAt), inGroup))
    .groupBy(wallets.id)
    .orderBy(desc(count(transactions.id)), asc(wallets.currency))
    .limit(1);
  return fallback?.currency ?? null;
}

// ---------------------------------------------------------------------------------------------
// Month figures

/**
 * Per-day expenses / income of one currency for the month chart, plus the previous month's running total. With
 * `convert`: of every currency, converted into `currency` (see the note at the top).
 */
export async function getMonthTimeline(
  userId: number,
  opts: {
    month: string;
    currency: string;
    walletId?: number;
    /** Only wallets of this group; ignored when `walletId` is set. */
    groupId?: number;
    categoryId?: number;
    convert?: ConvertOption;
  },
): Promise<MonthTimeline> {
  const month = assertMonth(opts.month);
  const currency = assertCurrency(opts.currency);
  const narrow: Narrow = {};
  if (opts.walletId !== undefined) narrow.walletId = assertId(opts.walletId, "walletId", "wallet");
  if (opts.groupId !== undefined) narrow.groupId = assertId(opts.groupId, "groupId", "group");
  if (opts.categoryId !== undefined) narrow.categoryId = assertId(opts.categoryId, "categoryId", "category");

  const previous = shiftMonth(month, -1);
  const { convert } = opts;
  const { byDate: flows, missing } = await dailyFlows(
    userId,
    currency,
    monthRange(previous).from,
    monthRange(month).to,
    narrow,
    convert,
  );

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
    // The day's largest entry; with `convert` the entries are in several currencies, so they are compared after
    // conversion (few rows: one day of one user).
    const entriesQuery = (await getDb())
      .select({
        note: transactions.note,
        categoryName: categories.name,
        amountMinor: transactions.amountMinor,
        currency: wallets.currency,
      })
      .from(transactions)
      .innerJoin(wallets, eq(wallets.id, transactions.walletId))
      .leftJoin(categories, eq(categories.id, transactions.categoryId))
      .where(
        and(
          ...currencyConditions(userId, convert ? null : currency, narrow),
          eq(transactions.kind, "expense"),
          eq(transactions.date, top.date),
        ),
      )
      .orderBy(desc(transactions.amountMinor), asc(transactions.id))
      .$dynamic();
    const entries = await (convert ? entriesQuery : entriesQuery.limit(1));
    const toTarget = converter(currency, convert);
    let entry: (typeof entries)[number] | undefined;
    let entryValue = -Infinity;
    for (const e of entries) {
      const value = toTarget(e.amountMinor, e.currency, top.date);
      if (value !== null && value > entryValue) {
        entry = e;
        entryValue = value;
      }
    }
    largestDay = {
      date: top.date,
      amountMinor: top.expenseMinor,
      label: entry?.note || entry?.categoryName || "",
    };
  }

  return convert
    ? { days, previousCumulativeMinor, largestDay, missingCurrencies: sorted(missing) }
    : { days, previousCumulativeMinor, largestDay };
}

type TopCategoryRow = { categoryId: number; categoryName: string; amountMinor: number };

/**
 * The month's top category: the largest amount; on a tie the category order's name rule (`compareCategoryNames`:
 * lower-cased, by code point; not `localeCompare`, not the database collation, so the per-currency and converted
 * views always agree), then the id. Exported for tests.
 */
export function pickTopCategory<T extends TopCategoryRow>(rows: T[]): T | undefined {
  return [...rows].sort(
    (a, b) =>
      b.amountMinor - a.amountMinor ||
      compareCategoryNames(a.categoryName, b.categoryName) ||
      a.categoryId - b.categoryId,
  )[0];
}

/**
 * The Overview insight cards for one month and currency (with `convert`: every currency, converted). `today` (the
 * user's, `todayInZone`) decides how far into the month the pace and no-spend days count.
 */
export async function getMonthInsights(
  userId: number,
  opts: { month: string; currency: string; today: string; groupId?: number; convert?: ConvertOption },
): Promise<MonthInsights> {
  const month = assertMonth(opts.month);
  const currency = assertCurrency(opts.currency);
  const previous = shiftMonth(month, -1);
  const { from, to } = monthRange(month);
  const { convert } = opts;
  const narrow: Narrow = opts.groupId === undefined ? {} : { groupId: assertId(opts.groupId, "groupId", "group") };
  const { byDate: flows, missing } = await dailyFlows(
    userId,
    currency,
    monthRange(previous).from,
    to,
    narrow,
    convert,
  );

  const dates = monthDates(month);
  const previousDates = monthDates(previous);
  let incomeMinor = 0;
  let expenseMinor = 0;
  for (const date of dates) {
    incomeMinor += flows.get(date)?.incomeMinor ?? 0;
    expenseMinor += expenseOn(flows, date);
  }

  const n = monthDayN(month, opts.today);
  const throughN = dates.slice(0, n);
  const previousThroughN = previousDates.slice(0, Math.min(n, previousDates.length));
  const sumExpenses = (ds: string[]) => ds.reduce((s, d) => s + expenseOn(flows, d), 0);
  const countNoSpend = (ds: string[]) => ds.filter((d) => expenseOn(flows, d) === 0).length;

  const inMonthExpenses = and(
    ...currencyConditions(userId, convert ? null : currency, narrow),
    eq(transactions.kind, "expense"),
    gte(transactions.date, from),
    lte(transactions.date, to),
  );
  let top: TopCategoryRow | undefined;
  if (!convert) {
    // One row per expense category of the month, ranked in JS by `pickTopCategory` (the same rule as below).
    top = pickTopCategory(
      await (await getDb())
        .select({
          categoryId: categories.id,
          categoryName: categories.name,
          amountMinor: sql<number>`sum(${transactions.amountMinor})`.mapWith(Number),
        })
        .from(transactions)
        .innerJoin(wallets, eq(wallets.id, transactions.walletId))
        .innerJoin(categories, eq(categories.id, transactions.categoryId))
        .where(inMonthExpenses)
        .groupBy(categories.id),
    );
  } else {
    // Per category, date and currency, converted at each date's rate, then added per category and ranked by
    // `pickTopCategory`, like the query above.
    const rows = await (await getDb())
      .select({
        categoryId: categories.id,
        categoryName: categories.name,
        date: transactions.date,
        currency: wallets.currency,
        amountMinor: sql<number>`sum(${transactions.amountMinor})`.mapWith(Number),
      })
      .from(transactions)
      .innerJoin(wallets, eq(wallets.id, transactions.walletId))
      .innerJoin(categories, eq(categories.id, transactions.categoryId))
      .where(inMonthExpenses)
      .groupBy(categories.id, transactions.date, wallets.currency);
    const toTarget = converter(currency, convert);
    const perCategory = new Map<number, { categoryId: number; categoryName: string; amountMinor: number }>();
    for (const row of rows) {
      const value = toTarget(row.amountMinor, row.currency, row.date);
      if (value === null) continue;
      const c = perCategory.get(row.categoryId) ?? { categoryId: row.categoryId, categoryName: row.categoryName, amountMinor: 0 };
      c.amountMinor += value;
      perCategory.set(row.categoryId, c);
    }
    top = pickTopCategory([...perCategory.values()]);
  }

  return {
    ...(convert ? { missingCurrencies: sorted(missing) } : {}),
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

/**
 * One wallet's month: opening balance, money in / out (transfers included), the balance after each day 1..N and,
 * for the days after today, the projected balance after each (`projectedDays`). `today` is the user's (`todayInZone`).
 */
export async function getWalletMonth(
  userId: number,
  walletId: number,
  month: string,
  { today }: { today: string },
): Promise<WalletMonth | null> {
  const { from, to } = monthRange(assertMonth(month));
  if (!isPgId(walletId)) return null;
  const db = await getDb();
  const [wallet] = await db
    .select({ initialBalanceMinor: wallets.initialBalanceMinor })
    .from(wallets)
    .where(and(eq(wallets.id, walletId), eq(wallets.userId, userId)));
  if (!wallet) return null;

  const own = and(eq(transactions.walletId, walletId), eq(transactions.userId, userId));
  const [before] = await db
    .select({ net: sql<number>`coalesce(sum(${signedAmountSql}), 0)`.mapWith(Number), n: count() })
    .from(transactions)
    .where(and(own, lt(transactions.date, from)));
  const [after] = await db
    .select({ n: count() })
    .from(transactions)
    .where(and(own, sql`${transactions.date} > ${to}`));
  const perDay = await db
    .select({
      date: transactions.date,
      inMinor: sql<number>`coalesce(sum(case when ${transactions.kind} in ('income', 'transfer_in') then ${transactions.amountMinor} else 0 end), 0)`.mapWith(Number),
      outMinor: sql<number>`coalesce(sum(case when ${transactions.kind} in ('expense', 'transfer_out') then ${transactions.amountMinor} else 0 end), 0)`.mapWith(Number),
      n: count(),
    })
    .from(transactions)
    .where(and(own, gte(transactions.date, from), lte(transactions.date, to)))
    .groupBy(transactions.date);
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
  const all = monthDates(month).map((date) => {
    const r = byDate.get(date);
    const dayIn = r?.inMinor ?? 0;
    const dayOut = r?.outMinor ?? 0;
    balance += dayIn - dayOut;
    return { date, inMinor: dayIn, outMinor: dayOut, closingMinor: balance };
  });
  const n = monthDayN(month, today);

  return {
    openingMinor,
    inMinor,
    outMinor,
    entryCount,
    totalEntryCount: (before?.n ?? 0) + entryCount + (after?.n ?? 0),
    days: all.slice(0, n),
    projectedDays: all.slice(n),
  };
}

/**
 * Expense and income per category in `month` (every wallet of the group, archived included, like
 * `listCategoriesWithUsage`'s `monthAmountMinor`), for /categories' "All in <currency>": with `convert`, every
 * currency converted into `currency` at each date's rate (per category, date and currency, each sum converted once),
 * the currencies without a rate left out and listed; without it, only wallets in `currency`.
 */
export async function getCategoryMonthAmounts(
  userId: number,
  opts: { month: string; currency: string; groupId?: number; convert?: ConvertOption },
): Promise<{ amounts: Map<number, number>; missingCurrencies: string[] }> {
  const month = assertMonth(opts.month);
  const currency = assertCurrency(opts.currency);
  const { from, to } = monthRange(month);
  const { convert } = opts;
  const narrow: Narrow = opts.groupId === undefined ? {} : { groupId: assertId(opts.groupId, "groupId", "group") };
  const rows = await (await getDb())
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
        ...currencyConditions(userId, convert ? null : currency, narrow),
        inArray(transactions.kind, ["expense", "income"]),
        gte(transactions.date, from),
        lte(transactions.date, to),
      ),
    )
    .groupBy(transactions.categoryId, transactions.date, wallets.currency);
  const toTarget = converter(currency, convert);
  const amounts = new Map<number, number>();
  const missing = new Set<string>();
  for (const r of rows) {
    if (r.categoryId === null) continue;
    const value = toTarget(r.amountMinor, r.currency, r.date);
    if (value === null) {
      missing.add(r.currency);
      continue;
    }
    amounts.set(r.categoryId, (amounts.get(r.categoryId) ?? 0) + value);
  }
  return { amounts, missingCurrencies: sorted(missing) };
}

/**
 * The balance of each of the user's wallets at the end of `date` (initial balance + every entry dated on or before
 * it, transfers included), by wallet id: the Overview's Wallets card for a past month. Archived wallets included.
 */
export async function getWalletBalancesOn(
  userId: number,
  date: string,
  opts: { groupId?: number } = {},
): Promise<Map<number, number>> {
  const day = assertDate(date);
  const groupId = opts.groupId === undefined ? undefined : assertId(opts.groupId, "groupId", "group");
  const rows = await (await getDb())
    .select({
      id: wallets.id,
      balanceMinor: sql<number>`${wallets.initialBalanceMinor} + coalesce(sum(${signedAmountSql}), 0)`.mapWith(Number),
    })
    .from(wallets)
    .leftJoin(
      transactions,
      and(eq(transactions.walletId, wallets.id), eq(transactions.userId, userId), lte(transactions.date, day)),
    )
    .where(and(eq(wallets.userId, userId), groupId === undefined ? undefined : eq(wallets.groupId, groupId)))
    .groupBy(wallets.id);
  return new Map(rows.map((r) => [r.id, r.balanceMinor]));
}
