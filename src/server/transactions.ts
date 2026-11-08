import "server-only";
import { and, desc, eq, gte, inArray, lte, ne, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { getDb, type DBOrTx } from "@/db";
import { categories, transactions, wallets, type CategoryKind, type TransactionKind } from "@/db/schema";
import { isValidDate, isValidMonth, monthRange } from "@/lib/dates";
import { ServiceError } from "@/lib/errors";
import { assertDate, assertId, assertPositiveAmount, normalizeNote } from "./_validate";
import { getOwnedWalletRow, signedAmountSql } from "./wallets";

export type TransactionView = {
  id: number;
  kind: TransactionKind;
  walletId: number;
  walletName: string;
  currency: string;
  categoryId: number | null;
  categoryName: string | null;
  /** Always positive. */
  amountMinor: number;
  /** Negative for expense / transfer_out. */
  signedAmountMinor: number;
  date: string;
  note: string | null;
  transferId: number | null;
  /** The other leg, for transfer legs. */
  counterparty: { walletId: number; walletName: string; currency: string; amountMinor: number } | null;
};

export type TransactionFilters = {
  walletId?: number;
  kind?: "expense" | "income" | "transfer";
  categoryId?: number;
  /** `YYYY-MM`: the month's first to last day. Ignored (but still validated) when `from` or `to` is given. */
  month?: string;
  /** Inclusive `YYYY-MM-DD`. */
  from?: string;
  /** Inclusive `YYYY-MM-DD`. */
  to?: string;
  /** Case-insensitive substring match on the note. */
  q?: string;
  /** Default 50, max 200. */
  limit?: number;
  offset?: number;
};

export type TransactionInput = {
  walletId: number;
  kind: "expense" | "income";
  categoryId: number;
  amountMinor: number;
  date: string;
  note?: string | null;
};

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

const otherLeg = alias(transactions, "other_leg");
const otherWallet = alias(wallets, "other_wallet");

type Row = {
  id: number;
  kind: TransactionKind;
  walletId: number;
  walletName: string;
  currency: string;
  categoryId: number | null;
  categoryName: string | null;
  amountMinor: number;
  date: string;
  note: string | null;
  transferId: number | null;
  cpWalletId: number | null;
  cpWalletName: string | null;
  cpCurrency: string | null;
  cpAmountMinor: number | null;
};

function baseQuery(where: SQL | undefined) {
  return getDb()
    .select({
      id: transactions.id,
      kind: transactions.kind,
      walletId: transactions.walletId,
      walletName: wallets.name,
      currency: wallets.currency,
      categoryId: transactions.categoryId,
      categoryName: categories.name,
      amountMinor: transactions.amountMinor,
      date: transactions.date,
      note: transactions.note,
      transferId: transactions.transferId,
      cpWalletId: otherLeg.walletId,
      cpWalletName: otherWallet.name,
      cpCurrency: otherWallet.currency,
      cpAmountMinor: otherLeg.amountMinor,
    })
    .from(transactions)
    .innerJoin(wallets, eq(wallets.id, transactions.walletId))
    .leftJoin(categories, eq(categories.id, transactions.categoryId))
    .leftJoin(
      otherLeg,
      and(eq(otherLeg.transferId, transactions.transferId), ne(otherLeg.id, transactions.id)),
    )
    .leftJoin(otherWallet, eq(otherWallet.id, otherLeg.walletId))
    .where(where);
}

function toView(r: Row): TransactionView {
  const negative = r.kind === "expense" || r.kind === "transfer_out";
  return {
    id: r.id,
    kind: r.kind,
    walletId: r.walletId,
    walletName: r.walletName,
    currency: r.currency,
    categoryId: r.categoryId,
    categoryName: r.categoryName,
    amountMinor: r.amountMinor,
    signedAmountMinor: negative ? -r.amountMinor : r.amountMinor,
    date: r.date,
    note: r.note,
    transferId: r.transferId,
    counterparty:
      r.transferId !== null && r.cpWalletId !== null
        ? {
            walletId: r.cpWalletId,
            walletName: r.cpWalletName ?? "",
            currency: r.cpCurrency ?? "",
            amountMinor: r.cpAmountMinor ?? 0,
          }
        : null,
  };
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** WHERE clause for `listTransactions` filters (also used by the CSV export). Throws VALIDATION on bad input. */
export function filterConditions(userId: number, f: TransactionFilters): SQL {
  const conds: SQL[] = [eq(transactions.userId, userId)];
  if (f.walletId !== undefined) conds.push(eq(transactions.walletId, assertId(f.walletId, "walletId", "wallet")));
  if (f.kind !== undefined) {
    if (f.kind === "transfer") conds.push(inArray(transactions.kind, ["transfer_out", "transfer_in"]));
    else if (f.kind === "expense" || f.kind === "income") conds.push(eq(transactions.kind, f.kind));
    else throw new ServiceError("VALIDATION", "Invalid kind filter.", "kind");
  }
  if (f.categoryId !== undefined) {
    conds.push(eq(transactions.categoryId, assertId(f.categoryId, "categoryId", "category")));
  }
  if (f.month !== undefined) {
    if (!isValidMonth(f.month)) throw new ServiceError("VALIDATION", "Invalid month.", "month");
    if (f.from === undefined && f.to === undefined) {
      const range = monthRange(f.month);
      conds.push(gte(transactions.date, range.from), lte(transactions.date, range.to));
    }
  }
  if (f.from !== undefined) {
    if (!isValidDate(f.from)) throw new ServiceError("VALIDATION", "Invalid start date.", "from");
    conds.push(gte(transactions.date, f.from));
  }
  if (f.to !== undefined) {
    if (!isValidDate(f.to)) throw new ServiceError("VALIDATION", "Invalid end date.", "to");
    conds.push(lte(transactions.date, f.to));
  }
  const q = f.q?.trim();
  if (q) conds.push(sql`${transactions.note} like ${`%${escapeLike(q)}%`} escape '\\'`);
  return and(...conds)!;
}

/** Filtered, paginated transactions (date desc, id desc) plus the total matching count. */
export function listTransactions(
  userId: number,
  filters: TransactionFilters = {},
): { items: TransactionView[]; total: number } {
  const where = filterConditions(userId, filters);
  const limit = Math.min(Math.max(Math.trunc(filters.limit ?? DEFAULT_PAGE_SIZE), 1), MAX_PAGE_SIZE);
  const offset = Math.max(Math.trunc(filters.offset ?? 0), 0);

  const rows = baseQuery(where)
    .orderBy(desc(transactions.date), desc(transactions.id))
    .limit(limit)
    .offset(offset)
    .all();
  const total =
    getDb().select({ n: sql<number>`count(*)` }).from(transactions).where(where).get()?.n ?? 0;
  return { items: rows.map(toView), total };
}

export type DayTotal = { date: string; currency: string; netMinor: number };

/**
 * Net amount per (date, currency) over ALL matches of `filters` on `dates` (limit/offset ignored), for the day
 * headers of a paginated list. Transfer legs count as money out of / into their own wallet. Only pairs that have
 * entries are returned, by date desc then currency. Malformed dates in `dates` are ignored.
 */
export function listDayTotals(userId: number, filters: TransactionFilters, dates: string[]): DayTotal[] {
  const where = filterConditions(userId, filters);
  const wanted = [...new Set(dates.filter((d) => isValidDate(d)))];
  if (wanted.length === 0) return [];
  return getDb()
    .select({
      date: transactions.date,
      currency: wallets.currency,
      netMinor: sql<number>`sum(${signedAmountSql})`,
    })
    .from(transactions)
    .innerJoin(wallets, eq(wallets.id, transactions.walletId))
    .where(and(where, inArray(transactions.date, wanted)))
    .groupBy(transactions.date, wallets.currency)
    .orderBy(desc(transactions.date), wallets.currency)
    .all();
}

/** One owned transaction (including transfer legs), or null. */
export function getTransaction(userId: number, id: number): TransactionView | null {
  const row = baseQuery(and(eq(transactions.id, id), eq(transactions.userId, userId))).get();
  return row ? toView(row) : null;
}

type ValidatedInput = Required<Omit<TransactionInput, "note">> & { note: string | null };

function validateInput(userId: number, input: TransactionInput, tx: DBOrTx, previousWalletId?: number): ValidatedInput {
  const kind = input.kind as CategoryKind;
  if (kind !== "expense" && kind !== "income") {
    throw new ServiceError("VALIDATION", "Choose expense or income.", "kind");
  }
  const walletId = assertId(input.walletId, "walletId", "wallet");
  const categoryId = assertId(input.categoryId, "categoryId", "category");
  const amountMinor = assertPositiveAmount(input.amountMinor);
  const date = assertDate(input.date);
  const note = normalizeNote(input.note);

  const wallet = getOwnedWalletRow(userId, walletId, tx);
  // An archived wallet only stays valid for a transaction that already belonged to it.
  if (wallet.archivedAt && wallet.id !== previousWalletId) {
    throw new ServiceError("VALIDATION", "This wallet is archived.", "walletId");
  }
  const category = tx
    .select({ kind: categories.kind })
    .from(categories)
    .where(and(eq(categories.id, categoryId), eq(categories.userId, userId)))
    .get();
  if (!category) throw new ServiceError("NOT_FOUND", "Category not found.", "categoryId");
  if (category.kind !== kind) {
    throw new ServiceError("VALIDATION", `Choose an ${kind} category.`, "categoryId");
  }
  return { walletId, kind, categoryId, amountMinor, date, note };
}

export function createTransaction(userId: number, input: TransactionInput): TransactionView {
  const db = getDb();
  const id = db.transaction((tx) => {
    const v = validateInput(userId, input, tx);
    return tx
      .insert(transactions)
      .values({ userId, ...v, transferId: null })
      .returning({ id: transactions.id })
      .get().id;
  });
  return getTransaction(userId, id)!;
}

function getEditableRow(userId: number, id: number, tx: DBOrTx) {
  const row = tx
    .select({ id: transactions.id, walletId: transactions.walletId, transferId: transactions.transferId })
    .from(transactions)
    .where(and(eq(transactions.id, id), eq(transactions.userId, userId)))
    .get();
  if (!row) throw new ServiceError("NOT_FOUND", "Transaction not found.");
  if (row.transferId !== null) {
    throw new ServiceError("VALIDATION", "Transfer legs can only be changed through their transfer.");
  }
  return row;
}

/** Update an expense/income. Rejects transfer legs. */
export function updateTransaction(userId: number, id: number, input: TransactionInput): TransactionView {
  getDb().transaction((tx) => {
    const existing = getEditableRow(userId, id, tx);
    const v = validateInput(userId, input, tx, existing.walletId);
    tx.update(transactions)
      .set(v)
      .where(and(eq(transactions.id, id), eq(transactions.userId, userId)))
      .run();
  });
  return getTransaction(userId, id)!;
}

/** Delete an expense/income. Rejects transfer legs. */
export function deleteTransaction(userId: number, id: number): void {
  getDb().transaction((tx) => {
    getEditableRow(userId, id, tx);
    tx.delete(transactions).where(and(eq(transactions.id, id), eq(transactions.userId, userId))).run();
  });
}
