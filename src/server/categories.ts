import "server-only";
import { and, count, eq, isNull, ne, sql } from "drizzle-orm";
import { getDb, type DBOrTx } from "@/db";
import { budgets, categories, recurringTransactions, transactions, wallets, type CategoryKind } from "@/db/schema";
import { sortCategories } from "@/lib/category-order";
import { isValidCurrency } from "@/lib/currencies";
import { isGroupColor, type GroupColor } from "@/lib/group-colors";
import { isValidMonth, monthRange } from "@/lib/dates";
import { ServiceError } from "@/lib/errors";
import { usageText } from "@/lib/usage-text";
import { MAX_ID, assertId, isPgId, isUniqueViolation, normalizeName } from "./_validate";

/**
 * `archivedAt` set: hidden from the entry form's pickers; still in reports, history and exports. `color`: one of
 * `GROUP_COLORS` (the wallet-group palette) or null; a stored value outside the palette reads as null.
 */
export type CategoryView = { id: number; name: string; kind: CategoryKind; archivedAt: Date | null; color: GroupColor | null };
/** `recurringCount`: repeating entries (src/server/recurring.ts) filed under it; they count as use too. */
export type CategoryWithUsage = CategoryView & { transactionCount: number; recurringCount: number };
export type CategoryWithMonthUsage = CategoryWithUsage & {
  /** Transactions in `opts.month`, every currency (0 without a month). */
  monthCount: number;
  /** Their total in `opts.currency` only (0 without a month or currency). */
  monthAmountMinor: number;
};

export const MAX_CATEGORY_NAME_LENGTH = 40;

export const DEFAULT_CATEGORIES: Record<CategoryKind, readonly string[]> = {
  expense: ["Food", "Groceries", "Bills", "Transport", "Housing"],
  income: ["Salary", "Refund", "Extra Income"],
};

const KIND_NOUN: Record<CategoryKind, string> = { expense: "expense", income: "income" };

// Order: `sortCategories` (src/lib/category-order.ts) in JS: expense first, active before archived, then by name
// ignoring case by code point, then id. Never SQL `lower(name)`, whose result depends on the database's collation.

const viewColumns = {
  id: categories.id,
  name: categories.name,
  kind: categories.kind,
  archivedAt: categories.archivedAt,
  color: sql<GroupColor | null>`${categories.color}`,
};

/** A stored colour outside the palette (written by hand, or by an older palette) reads as none. */
function clean<T extends { color: string | null }>(row: T): T {
  return row.color === null || isGroupColor(row.color) ? row : { ...row, color: null };
}

/** `undefined` stays undefined (unchanged); null or "" is no colour; anything else must be in the palette. */
function normalizeColor(value: unknown): GroupColor | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (!isGroupColor(value)) throw new ServiceError("VALIDATION", "Choose a colour from the list.", "color");
  return value;
}

/**
 * The user's categories, optionally for one kind. Archived ones only with `opts.includeArchived` (as `listWallets`):
 * the entry form's pickers leave them out, history filters keep them. Ordered expense first, active before archived,
 * then by name.
 */
export async function listCategories(
  userId: number,
  kind?: CategoryKind,
  opts: { includeArchived?: boolean } = {},
): Promise<CategoryView[]> {
  const rows = await (await getDb())
    .select(viewColumns)
    .from(categories)
    .where(
      and(
        eq(categories.userId, userId),
        kind ? eq(categories.kind, kind) : undefined,
        opts.includeArchived ? undefined : isNull(categories.archivedAt),
      ),
    );
  return sortCategories(rows.map(clean));
}

/**
 * All the user's categories, archived included, with how many transactions use each; same order as `listCategories`.
 * With `opts.month` also the month's count (all currencies) and, with `opts.currency`, the month's amount in it.
 */
export async function listCategoriesWithUsage(
  userId: number,
  opts: { month?: string; currency?: string; groupId?: number } = {},
): Promise<CategoryWithMonthUsage[]> {
  if (opts.month !== undefined && !isValidMonth(opts.month)) {
    throw new ServiceError("VALIDATION", "Invalid month.", "month");
  }
  if (opts.currency !== undefined && (typeof opts.currency !== "string" || !isValidCurrency(opts.currency))) {
    throw new ServiceError("VALIDATION", "Choose a valid currency.", "currency");
  }
  const range = opts.month !== undefined ? monthRange(opts.month) : null;
  const inMonth = range
    ? sql`${transactions.date} >= ${range.from} and ${transactions.date} <= ${range.to}`
    : sql`false`;
  const inCurrency = opts.currency !== undefined ? sql`${wallets.currency} = ${opts.currency}` : sql`false`;
  if (opts.groupId !== undefined) assertId(opts.groupId, "groupId", "group");
  const inGroup =
    opts.groupId === undefined
      ? undefined
      : sql`${transactions.walletId} in (select id from wallets where group_id = ${opts.groupId} and user_id = ${userId})`;
  const rows = await (await getDb())
    .select({
      ...viewColumns,
      transactionCount: sql<number>`count(${transactions.id})`.mapWith(Number),
      recurringCount: sql<number>`(select count(*) from ${recurringTransactions} where ${recurringTransactions.categoryId} = ${categories.id})`.mapWith(
        Number,
      ),
      monthCount: sql<number>`coalesce(sum(case when ${inMonth} then 1 else 0 end), 0)`.mapWith(Number),
      monthAmountMinor: sql<number>`coalesce(sum(case when ${inMonth} and ${inCurrency} then ${transactions.amountMinor} else 0 end), 0)`.mapWith(Number),
    })
    .from(categories)
    .leftJoin(transactions, and(eq(transactions.categoryId, categories.id), eq(transactions.userId, userId), inGroup))
    .leftJoin(wallets, eq(wallets.id, transactions.walletId))
    .where(eq(categories.userId, userId))
    .groupBy(categories.id);
  return sortCategories(rows.map(clean));
}

/** One owned category (archived included) or null. */
export async function getCategory(userId: number, categoryId: number): Promise<CategoryView | null> {
  if (!isPgId(categoryId)) return null;
  const [row] = await (await getDb())
    .select(viewColumns)
    .from(categories)
    .where(and(eq(categories.id, categoryId), eq(categories.userId, userId)));
  return row ? clean(row) : null;
}

/**
 * Insert the default categories for a new user. Idempotent. Pass the transaction handle when called
 * inside registration so the user and their categories are created atomically.
 */
export async function seedDefaultCategories(userId: number, tx?: DBOrTx): Promise<void> {
  const db = tx ?? (await getDb());
  const rows = (Object.keys(DEFAULT_CATEGORIES) as CategoryKind[]).flatMap((kind) =>
    DEFAULT_CATEGORIES[kind].map((name) => ({ userId, kind, name })),
  );
  await db.insert(categories).values(rows).onConflictDoNothing();
}

// ---------------------------------------------------------------------------------------------
// Management

function isId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= MAX_ID;
}

function assertKind(value: unknown): CategoryKind {
  if (value !== "expense" && value !== "income") {
    throw new ServiceError("VALIDATION", "Choose expense or income.", "kind");
  }
  return value;
}

/**
 * The owned category or NOT_FOUND. With `lock` the row is locked for the rest of `tx` (`FOR UPDATE`): a kind change
 * holds it so no transaction can be filed under the category between the usage check and the update
 * (`createTransaction` reads the category `FOR SHARE`).
 */
async function ownedCategory(tx: DBOrTx, userId: number, categoryId: unknown, lock = false): Promise<CategoryView> {
  if (!isId(categoryId)) throw new ServiceError("NOT_FOUND", "Category not found.");
  const query = tx
    .select(viewColumns)
    .from(categories)
    .where(and(eq(categories.id, categoryId), eq(categories.userId, userId)));
  const [row] = lock ? await query.for("update") : await query;
  if (!row) throw new ServiceError("NOT_FOUND", "Category not found.");
  return clean(row);
}

async function usageOf(tx: DBOrTx, userId: number, categoryId: number): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(transactions)
    .where(and(eq(transactions.categoryId, categoryId), eq(transactions.userId, userId)));
  return row?.n ?? 0;
}

async function rulesOf(tx: DBOrTx, userId: number, categoryId: number): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(recurringTransactions)
    .where(and(eq(recurringTransactions.categoryId, categoryId), eq(recurringTransactions.userId, userId)));
  return row?.n ?? 0;
}

function duplicateError(name: string, kind: CategoryKind, field = "name"): ServiceError {
  return new ServiceError("CONFLICT", `You already have an ${KIND_NOUN[kind]} category called “${name}”.`, field);
}

/** CONFLICT when another category of the same user and kind has this name, ignoring case. */
async function assertNameFree(
  tx: DBOrTx,
  userId: number,
  kind: CategoryKind,
  name: string,
  exceptId?: number,
  field = "name",
): Promise<void> {
  const folded = name.toLowerCase();
  const others = await tx
    .select({ id: categories.id, name: categories.name })
    .from(categories)
    .where(
      and(
        eq(categories.userId, userId),
        eq(categories.kind, kind),
        exceptId === undefined ? undefined : ne(categories.id, exceptId),
      ),
    );
  const clash = others.find((c) => c.name.toLowerCase() === folded);
  if (clash) throw duplicateError(clash.name, kind, field);
}

const normalizeCategoryName = (value: unknown, field = "name") => normalizeName(value, field, MAX_CATEGORY_NAME_LENGTH);

async function insertCategory(tx: DBOrTx, userId: number, kind: CategoryKind, name: string, field = "name") {
  await assertNameFree(tx, userId, kind, name, undefined, field);
  const [row] = await tx.insert(categories).values({ userId, kind, name }).returning(viewColumns);
  return clean(row);
}

/** Create a category. Name trimmed, inner whitespace collapsed, 1–40 chars, unique per kind ignoring case. */
export async function createCategory(userId: number, input: { name: string; kind: CategoryKind }): Promise<CategoryView> {
  const kind = assertKind(input.kind);
  const name = normalizeCategoryName(input.name);
  try {
    const db = await getDb();
    return await db.transaction((tx) => insertCategory(tx, userId, kind, name));
  } catch (err) {
    if (isUniqueViolation(err)) throw duplicateError(name, kind);
    throw err;
  }
}

/**
 * Rename an owned category (archived or not) and / or change its colour (`color` omitted → unchanged, null or "" →
 * none, else one of `GROUP_COLORS`; VALIDATION on field `color` otherwise). Changing only the letter case of its own
 * name is allowed.
 */
export async function renameCategory(
  userId: number,
  categoryId: number,
  input: { name: string; color?: string | null },
): Promise<CategoryView> {
  const name = normalizeCategoryName(input.name);
  const color = normalizeColor(input.color);
  let kind: CategoryKind | undefined;
  try {
    const db = await getDb();
    return await db.transaction(async (tx) => {
      const current = await ownedCategory(tx, userId, categoryId);
      kind = current.kind;
      const nextColor = color === undefined ? current.color : color;
      if (current.name === name && current.color === nextColor) return current;
      if (current.name !== name) await assertNameFree(tx, userId, current.kind, name, current.id);
      await tx
        .update(categories)
        .set({ name, color: nextColor })
        .where(and(eq(categories.id, current.id), eq(categories.userId, userId)));
      return { ...current, name, color: nextColor };
    });
  } catch (err) {
    if (kind && isUniqueViolation(err)) throw duplicateError(name, kind);
    throw err;
  }
}

/**
 * Switch an owned category between expense and income. Only while no transaction and no repeating entry uses it:
 * otherwise it is CONFLICT (field `kind`), since changing it would turn those expenses into income or the other way
 * round. The name must be free in the new kind (CONFLICT, field `kind`). The same kind is a no-op. Budgets are for
 * expense categories only, so an expense category's budget is removed in the same DB transaction (`budgetRemoved`).
 */
export async function changeCategoryKind(
  userId: number,
  categoryId: number,
  input: { kind: CategoryKind },
): Promise<CategoryView & { budgetRemoved: boolean }> {
  const kind = assertKind(input.kind);
  let name: string | undefined;
  try {
    const db = await getDb();
    return await db.transaction(async (tx) => {
      const current = await ownedCategory(tx, userId, categoryId, true);
      name = current.name;
      if (current.kind === kind) return { ...current, budgetRemoved: false };
      const usage = await usageOf(tx, userId, current.id);
      const rules = await rulesOf(tx, userId, current.id);
      if (usage + rules > 0) {
        const n = usage + rules;
        throw new ServiceError(
          "CONFLICT",
          `“${current.name}” is used by ${usageText(usage, rules)}, so it stays an ${KIND_NOUN[current.kind]} category: ` +
            `changing it would turn ${n === 1 ? "that entry" : "those entries"} into ${KIND_NOUN[kind]}. ` +
            `Add a new ${KIND_NOUN[kind]} category instead.`,
          "kind",
        );
      }
      await assertNameFree(tx, userId, kind, current.name, undefined, "kind");
      await tx
        .update(categories)
        .set({ kind })
        .where(and(eq(categories.id, current.id), eq(categories.userId, userId)));
      const removed = await tx
        .delete(budgets)
        .where(and(eq(budgets.categoryId, current.id), eq(budgets.userId, userId)))
        .returning({ id: budgets.id });
      return { ...current, kind, budgetRemoved: removed.length > 0 };
    });
  } catch (err) {
    if (name && isUniqueViolation(err)) throw duplicateError(name, kind, "kind");
    throw err;
  }
}

/**
 * Archive an owned category: it disappears from the entry form's pickers (an entry that already uses it keeps it when
 * edited) and new entries can't be filed under it, while its transactions stay in reports, history and exports.
 * Already archived → unchanged (the first date is kept).
 */
export async function archiveCategory(userId: number, categoryId: number): Promise<CategoryView> {
  const db = await getDb();
  return await db.transaction(async (tx) => {
    const current = await ownedCategory(tx, userId, categoryId);
    if (current.archivedAt) return current;
    const archivedAt = new Date();
    await tx
      .update(categories)
      .set({ archivedAt })
      .where(and(eq(categories.id, current.id), eq(categories.userId, userId)));
    return { ...current, archivedAt };
  });
}

/** Unarchive an owned category (a no-op when it is not archived). */
export async function unarchiveCategory(userId: number, categoryId: number): Promise<CategoryView> {
  const db = await getDb();
  return await db.transaction(async (tx) => {
    const current = await ownedCategory(tx, userId, categoryId);
    if (!current.archivedAt) return current;
    await tx
      .update(categories)
      .set({ archivedAt: null })
      .where(and(eq(categories.id, current.id), eq(categories.userId, userId)));
    return { ...current, archivedAt: null };
  });
}

/**
 * Remove an owned category (its budget goes with it: the foreign key cascades; it is not moved). Unused → deleted (the
 * replacement options are ignored). In use (transactions or repeating entries) → its transactions and repeating
 * entries are re-pointed to a replacement of the same kind and the category is deleted, in one DB transaction. The
 * replacement
 * is either `moveToCategoryId` (another owned, active category of the same kind; VALIDATION otherwise) or
 * `moveToNewCategoryName` (a string: a new category of the same kind created in the same DB transaction; name rules
 * as `createCategory`, errors on field `moveToNewCategoryName`). The new name wins when both are given. Without
 * either: CONFLICT naming the transaction count (field `moveToCategoryId`, or `moveToNewCategoryName` when there is
 * no other active category of that kind to choose).
 */
export async function deleteCategory(
  userId: number,
  categoryId: number,
  opts: { moveToCategoryId?: number | null; moveToNewCategoryName?: string | null } = {},
): Promise<{ movedTransactions: number; movedRecurring: number; movedTo: CategoryView | null }> {
  const newName = opts.moveToNewCategoryName;
  let pendingName: { name: string; kind: CategoryKind } | undefined;
  try {
    const db = await getDb();
    return await db.transaction(async (tx) => {
      const category = await ownedCategory(tx, userId, categoryId);
      const usage = await usageOf(tx, userId, category.id);
      const rules = await rulesOf(tx, userId, category.id);
      const used = usageText(usage, rules);
      const noun = KIND_NOUN[category.kind];
      let target: CategoryView | null = null;

      if (usage + rules > 0) {
        const moveTo = opts.moveToCategoryId;
        if (typeof newName === "string") {
          const name = normalizeCategoryName(newName, "moveToNewCategoryName");
          pendingName = { name, kind: category.kind };
          target = await insertCategory(tx, userId, category.kind, name, "moveToNewCategoryName");
        } else if (moveTo === undefined || moveTo === null) {
          const [hasOther] = await tx
            .select({ id: categories.id })
            .from(categories)
            .where(
              and(
                eq(categories.userId, userId),
                eq(categories.kind, category.kind),
                ne(categories.id, category.id),
                isNull(categories.archivedAt),
              ),
            )
            .limit(1);
          throw new ServiceError(
            "CONFLICT",
            hasOther
              ? `“${category.name}” is used by ${used}. Choose a category to move them to.`
              : `“${category.name}” is used by ${used} and is your only ${noun} category. ` +
                  `Name a new ${noun} category to move them to, or archive “${category.name}” instead.`,
            hasOther ? "moveToCategoryId" : "moveToNewCategoryName",
          );
        } else {
          if (moveTo === category.id) {
            throw new ServiceError(
              "VALIDATION",
              "Choose a different category to move the transactions to.",
              "moveToCategoryId",
            );
          }
          const [row] = isId(moveTo)
            ? await tx
                .select(viewColumns)
                .from(categories)
                .where(and(eq(categories.id, moveTo), eq(categories.userId, userId)))
            : [];
          if (!row || row.kind !== category.kind) {
            throw new ServiceError(
              "VALIDATION",
              `Choose another ${noun} category to move the transactions to.`,
              "moveToCategoryId",
            );
          }
          if (row.archivedAt) {
            throw new ServiceError(
              "VALIDATION",
              `“${row.name}” is archived. Choose an active category, or unarchive it first.`,
              "moveToCategoryId",
            );
          }
          target = row;
        }
        await tx
          .update(transactions)
          .set({ categoryId: target.id })
          .where(and(eq(transactions.categoryId, category.id), eq(transactions.userId, userId)));
        await tx
          .update(recurringTransactions)
          .set({ categoryId: target.id })
          .where(and(eq(recurringTransactions.categoryId, category.id), eq(recurringTransactions.userId, userId)));
      }

      await tx.delete(categories).where(and(eq(categories.id, category.id), eq(categories.userId, userId)));
      return { movedTransactions: usage, movedRecurring: rules, movedTo: target };
    });
  } catch (err) {
    if (pendingName && isUniqueViolation(err)) {
      throw duplicateError(pendingName.name, pendingName.kind, "moveToNewCategoryName");
    }
    throw err;
  }
}
