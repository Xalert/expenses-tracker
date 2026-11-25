import "server-only";
import { and, desc, eq, gte, inArray, lte, ne, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDb, type DBOrTx } from "@/db";
import { categories, tags, transactions, transactionTags, wallets, type CategoryKind, type TransactionKind } from "@/db/schema";
import { isValidDate, isValidMonth, monthRange } from "@/lib/dates";
import { ServiceError } from "@/lib/errors";
import { isGroupColor, type GroupColor } from "@/lib/group-colors";
import { amountConditions } from "./_filters";
import { assertDate, assertId, assertPositiveAmount, isPgId, normalizeNote } from "./_validate";
import { loadEntryTags, normalizeTagList, setEntryTags } from "./tags";
import { closedWalletMessage, getOwnedWalletRow, signedAmountSql } from "./wallets";

export type TransactionView = {
  id: number;
  kind: TransactionKind;
  walletId: number;
  walletName: string;
  currency: string;
  categoryId: number | null;
  categoryName: string | null;
  /** The category's colour (a `GROUP_COLORS` key) or null: the dot before its name in the day lists. */
  categoryColor: GroupColor | null;
  /** Always positive. */
  amountMinor: number;
  /** Negative for expense / transfer_out. */
  signedAmountMinor: number;
  date: string;
  note: string | null;
  transferId: number | null;
  /** The other leg, for transfer legs. */
  counterparty: { walletId: number; walletName: string; currency: string; amountMinor: number } | null;
  /** The repeating rule that created this entry (src/server/recurring.ts), or null. */
  recurringId: number | null;
  /** The entry's tag names (src/server/tags.ts), by name ignoring case; always empty for transfer legs. */
  tags: string[];
};

export type TransactionFilters = {
  walletId?: number;
  /** Only wallets of this group; ignored when `walletId` is set. */
  groupId?: number;
  kind?: "expense" | "income" | "transfer";
  /** Entries of this category; combined with `categoryIds` (any of them matches). */
  categoryId?: number;
  /** Entries whose category is any of these (another user's id matches nothing). */
  categoryIds?: number[];
  /** Only entries carrying this tag (an id of the user's; another user's matches nothing); combined with `tagIds`. */
  tagId?: number;
  /** Entries carrying any of these tags. */
  tagIds?: number[];
  /**
   * Inclusive amount bounds in major units as typed ("12.50", "12,5"), compared with each entry in its own wallet's
   * currency (src/lib/amount-filter.ts). Invalid, negative, or a maximum below the minimum → VALIDATION (`min` / `max`).
   */
  minAmount?: string;
  maxAmount?: string;
  /** `YYYY-MM`: the month's first to last day. Ignored (but still validated) when `from` or `to` is given. */
  month?: string;
  /** Inclusive `YYYY-MM-DD`. */
  from?: string;
  /** Inclusive `YYYY-MM-DD`. */
  to?: string;
  /** Case-insensitive substring of the note, the category name or one of the entry's tag names. */
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
  /**
   * The entry's tag names: replaces its whole set (missing tags are created). Omitted: create → none, update → the
   * entry keeps the tags it has. See `normalizeTagList` for the rules (field `tags`).
   */
  tags?: string[];
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
  categoryColor: string | null;
  amountMinor: number;
  date: string;
  note: string | null;
  transferId: number | null;
  recurringId: number | null;
  cpWalletId: number | null;
  cpWalletName: string | null;
  cpCurrency: string | null;
  cpAmountMinor: number | null;
};

function baseQuery(db: DBOrTx, where: SQL | undefined) {
  return db
    .select({
      id: transactions.id,
      kind: transactions.kind,
      walletId: transactions.walletId,
      walletName: wallets.name,
      currency: wallets.currency,
      categoryId: transactions.categoryId,
      categoryName: categories.name,
      categoryColor: categories.color,
      amountMinor: transactions.amountMinor,
      date: transactions.date,
      note: transactions.note,
      transferId: transactions.transferId,
      recurringId: transactions.recurringId,
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

function toView(r: Row, tagNames: Map<number, string[]>): TransactionView {
  const negative = r.kind === "expense" || r.kind === "transfer_out";
  return {
    id: r.id,
    kind: r.kind,
    walletId: r.walletId,
    walletName: r.walletName,
    currency: r.currency,
    categoryId: r.categoryId,
    categoryName: r.categoryName,
    categoryColor: isGroupColor(r.categoryColor) ? r.categoryColor : null,
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
    recurringId: r.recurringId,
    tags: tagNames.get(r.id) ?? [],
  };
}

/** Rows → views, with every row's tags loaded in one query (none when no row can have tags). */
async function toViews(db: DBOrTx, rows: Row[]): Promise<TransactionView[]> {
  const tagNames = await loadEntryTags(
    db,
    rows.filter((r) => r.transferId === null).map((r) => r.id),
  );
  return rows.map((r) => toView(r, tagNames));
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** WHERE clause for `listTransactions` filters (also used by the CSV export). Throws VALIDATION on bad input. */
export function filterConditions(userId: number, f: TransactionFilters): SQL {
  const conds: SQL[] = [eq(transactions.userId, userId)];
  if (f.walletId !== undefined) conds.push(eq(transactions.walletId, assertId(f.walletId, "walletId", "wallet")));
  else if (f.groupId !== undefined) {
    const groupId = assertId(f.groupId, "groupId", "group");
    conds.push(sql`${transactions.walletId} in (select id from wallets where group_id = ${groupId} and user_id = ${userId})`);
  }
  if (f.kind !== undefined) {
    if (f.kind === "transfer") conds.push(inArray(transactions.kind, ["transfer_out", "transfer_in"]));
    else if (f.kind === "expense" || f.kind === "income") conds.push(eq(transactions.kind, f.kind));
    else throw new ServiceError("VALIDATION", "Invalid kind filter.", "kind");
  }
  const categoryIds = idList(f.categoryId, f.categoryIds, "categoryId", "category");
  if (categoryIds.length > 0) conds.push(inArray(transactions.categoryId, categoryIds));
  const tagIds = idList(f.tagId, f.tagIds, "tagId", "tag");
  if (tagIds.length > 0) conds.push(hasAnyTag(tagIds));
  conds.push(...amountConditions(f.minAmount, f.maxAmount));
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
  if (q) {
    // Note, category name or a tag name; transfer legs have neither of the last two, so they match on their note.
    const pattern = `%${escapeLike(q)}%`;
    conds.push(sql`(${transactions.note} ilike ${pattern} escape '\\'
      or exists (select 1 from ${categories} c where c.id = ${transactions.categoryId} and c.name ilike ${pattern} escape '\\')
      or exists (select 1 from ${transactionTags} tt join ${tags} tg on tg.id = tt.tag_id
        where tt.transaction_id = ${transactions.id} and tg.name ilike ${pattern} escape '\\'))`);
  }
  return and(...conds)!;
}

/** Most ids one list filter takes (the URL keeps at most this many, too). */
export const MAX_FILTER_IDS = 100;

/** `single` and `list` merged, each a valid id (VALIDATION on `field` otherwise), deduped. */
function idList(single: number | undefined, list: number[] | undefined, field: string, label: string): number[] {
  const all = [...(single === undefined ? [] : [single]), ...(list ?? [])];
  if (all.length > MAX_FILTER_IDS) throw new ServiceError("VALIDATION", `Choose at most ${MAX_FILTER_IDS}.`, field);
  return [...new Set(all.map((id) => assertId(id, field, label)))];
}

/** The entry carries at least one of `tagIds`. */
function hasAnyTag(tagIds: number[]): SQL {
  return sql`exists (select 1 from ${transactionTags} where ${transactionTags.transactionId} = ${transactions.id} and ${inArray(transactionTags.tagId, tagIds)})`;
}

/** Filtered, paginated transactions (date desc, id desc) plus the total matching count. */
export async function listTransactions(
  userId: number,
  filters: TransactionFilters = {},
): Promise<{ items: TransactionView[]; total: number }> {
  const db = await getDb();
  const where = filterConditions(userId, filters);
  const limit = Math.min(Math.max(Math.trunc(filters.limit ?? DEFAULT_PAGE_SIZE), 1), MAX_PAGE_SIZE);
  const offset = Math.max(Math.trunc(filters.offset ?? 0), 0);

  const rows = await baseQuery(db, where)
    .orderBy(desc(transactions.date), desc(transactions.id))
    .limit(limit)
    .offset(offset);
  const [totalRow] = await db
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(transactions)
    .where(where);
  const total = totalRow?.n ?? 0;
  return { items: await toViews(db, rows), total };
}

export type DayTotal = { date: string; currency: string; netMinor: number };

/**
 * Net amount per (date, currency) over ALL matches of `filters` on `dates` (limit/offset ignored), for the day
 * headers of a paginated list. Transfer legs count as money out of / into their own wallet. Only pairs that have
 * entries are returned, by date desc then currency. Malformed dates in `dates` are ignored.
 */
export async function listDayTotals(
  userId: number,
  filters: TransactionFilters,
  dates: string[],
): Promise<DayTotal[]> {
  const where = filterConditions(userId, filters);
  const wanted = [...new Set(dates.filter((d) => isValidDate(d)))];
  if (wanted.length === 0) return [];
  return (await getDb())
    .select({
      date: transactions.date,
      currency: wallets.currency,
      netMinor: sql<number>`sum(${signedAmountSql})`.mapWith(Number),
    })
    .from(transactions)
    .innerJoin(wallets, eq(wallets.id, transactions.walletId))
    .where(and(where, inArray(transactions.date, wanted)))
    .groupBy(transactions.date, wallets.currency)
    .orderBy(desc(transactions.date), wallets.currency);
}

/** One owned transaction (including transfer legs), or null. */
export async function getTransaction(userId: number, id: number, tx?: DBOrTx): Promise<TransactionView | null> {
  if (!isPgId(id)) return null;
  const db = tx ?? (await getDb());
  const [row] = await baseQuery(db, and(eq(transactions.id, id), eq(transactions.userId, userId)));
  return row ? (await toViews(db, [row]))[0] : null;
}

export type ValidatedTransactionInput = Required<Omit<TransactionInput, "note" | "tags">> & { note: string | null };
/**
 * Internal (also used by src/server/recurring.ts): check an expense / income input against the account — an owned
 * wallet that takes entries, an owned category of the kind that is not archived (each kept when `previous` already
 * used it) — and return it normalised. The category row is read `FOR SHARE` (see `changeCategoryKind`).
 */
export async function validateTransactionInput(
  userId: number,
  input: TransactionInput,
  tx: DBOrTx,
  previous?: { walletId: number; categoryId: number | null },
): Promise<ValidatedTransactionInput> {
  const kind = input.kind as CategoryKind;
  if (kind !== "expense" && kind !== "income") {
    throw new ServiceError("VALIDATION", "Choose expense or income.", "kind");
  }
  const walletId = assertId(input.walletId, "walletId", "wallet");
  const categoryId = assertId(input.categoryId, "categoryId", "category");
  const amountMinor = assertPositiveAmount(input.amountMinor);
  const date = assertDate(input.date);
  const note = normalizeNote(input.note);

  const wallet = await getOwnedWalletRow(userId, walletId, tx);
  // An archived wallet (or one in an archived group) only stays valid for a transaction that already belonged to it.
  const closed = closedWalletMessage(wallet, "This wallet");
  if (closed && wallet.id !== previous?.walletId) {
    throw new ServiceError("VALIDATION", closed, "walletId");
  }
  // FOR SHARE: a concurrent kind change (`changeCategoryKind`, FOR UPDATE) waits for this entry, then sees it.
  const [category] = await tx
    .select({ kind: categories.kind, name: categories.name, archivedAt: categories.archivedAt })
    .from(categories)
    .where(and(eq(categories.id, categoryId), eq(categories.userId, userId)))
    .for("share");
  if (!category) throw new ServiceError("NOT_FOUND", "Category not found.", "categoryId");
  if (category.kind !== kind) {
    throw new ServiceError("VALIDATION", `Choose an ${kind} category.`, "categoryId");
  }
  // Same rule as wallets: an archived category only stays valid for a transaction that already belonged to it.
  if (category.archivedAt && categoryId !== previous?.categoryId) {
    throw new ServiceError("VALIDATION", `“${category.name}” is archived. Choose another category.`, "categoryId");
  }
  return { walletId, kind, categoryId, amountMinor, date, note };
}

export async function createTransaction(userId: number, input: TransactionInput): Promise<TransactionView> {
  const db = await getDb();
  const id = await db.transaction(async (tx) => {
    const v = await validateTransactionInput(userId, input, tx);
    const tagNames = input.tags === undefined ? [] : normalizeTagList(input.tags);
    const [row] = await tx
      .insert(transactions)
      .values({ userId, ...v, transferId: null })
      .returning({ id: transactions.id });
    if (tagNames.length > 0) await setEntryTags(userId, row.id, tagNames, tx);
    return row.id;
  });
  return (await getTransaction(userId, id))!;
}

async function getEditableRow(userId: number, id: number, tx: DBOrTx) {
  const [row] = !isPgId(id)
    ? []
    : await tx
    .select({
      id: transactions.id,
      walletId: transactions.walletId,
      categoryId: transactions.categoryId,
      transferId: transactions.transferId,
    })
    .from(transactions)
    .where(and(eq(transactions.id, id), eq(transactions.userId, userId)));
  if (!row) throw new ServiceError("NOT_FOUND", "Transaction not found.");
  if (row.transferId !== null) {
    throw new ServiceError("VALIDATION", "Transfer legs can only be changed through their transfer.");
  }
  return row;
}

/** Update an expense/income. Rejects transfer legs. */
export async function updateTransaction(userId: number, id: number, input: TransactionInput): Promise<TransactionView> {
  const db = await getDb();
  await db.transaction(async (tx) => {
    const existing = await getEditableRow(userId, id, tx);
    const v = await validateTransactionInput(userId, input, tx, existing);
    const tagNames = input.tags === undefined ? undefined : normalizeTagList(input.tags);
    await tx
      .update(transactions)
      .set(v)
      .where(and(eq(transactions.id, id), eq(transactions.userId, userId)));
    if (tagNames !== undefined) await setEntryTags(userId, id, tagNames, tx);
  });
  return (await getTransaction(userId, id))!;
}

/** Delete an expense/income. Rejects transfer legs. */
export async function deleteTransaction(userId: number, id: number): Promise<void> {
  const db = await getDb();
  await db.transaction(async (tx) => {
    await getEditableRow(userId, id, tx);
    await tx.delete(transactions).where(and(eq(transactions.id, id), eq(transactions.userId, userId)));
  });
}
