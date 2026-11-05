import "server-only";
import { and, asc, count, eq, ne, sql } from "drizzle-orm";
import { getDb, type DBOrTx } from "@/db";
import { categories, transactions, type CategoryKind } from "@/db/schema";
import { ServiceError } from "@/lib/errors";
import { isUniqueViolation, normalizeName } from "./_validate";

export type CategoryView = { id: number; name: string; kind: CategoryKind };
export type CategoryWithUsage = CategoryView & { transactionCount: number };

export const MAX_CATEGORY_NAME_LENGTH = 40;

export const DEFAULT_CATEGORIES: Record<CategoryKind, readonly string[]> = {
  expense: ["Food", "Groceries", "Bills", "Transport", "Housing"],
  income: ["Salary", "Refund", "Extra Income"],
};

const KIND_NOUN: Record<CategoryKind, string> = { expense: "expense", income: "income" };

// Expense first, then by name ignoring case (user-entered names are not always capitalised).
const categoryOrder = [asc(categories.kind), sql`${categories.name} collate nocase`, asc(categories.id)];

/** The user's categories, optionally for one kind; ordered expense first, then by name. */
export function listCategories(userId: number, kind?: CategoryKind): CategoryView[] {
  const where = kind
    ? and(eq(categories.userId, userId), eq(categories.kind, kind))
    : eq(categories.userId, userId);
  return getDb()
    .select({ id: categories.id, name: categories.name, kind: categories.kind })
    .from(categories)
    .where(where)
    .orderBy(...categoryOrder)
    .all();
}

/** All the user's categories with how many transactions use each; same order as `listCategories`. */
export function listCategoriesWithUsage(userId: number): CategoryWithUsage[] {
  return getDb()
    .select({
      id: categories.id,
      name: categories.name,
      kind: categories.kind,
      transactionCount: sql<number>`count(${transactions.id})`,
    })
    .from(categories)
    .leftJoin(transactions, and(eq(transactions.categoryId, categories.id), eq(transactions.userId, userId)))
    .where(eq(categories.userId, userId))
    .groupBy(categories.id)
    .orderBy(...categoryOrder)
    .all();
}

/** One owned category or null. */
export function getCategory(userId: number, categoryId: number): CategoryView | null {
  return (
    getDb()
      .select({ id: categories.id, name: categories.name, kind: categories.kind })
      .from(categories)
      .where(and(eq(categories.id, categoryId), eq(categories.userId, userId)))
      .get() ?? null
  );
}

/**
 * Insert the default categories for a new user. Idempotent. Pass the transaction handle when called
 * inside registration so the user and their categories are created atomically.
 */
export function seedDefaultCategories(userId: number, tx: DBOrTx = getDb()): void {
  const rows = (Object.keys(DEFAULT_CATEGORIES) as CategoryKind[]).flatMap((kind) =>
    DEFAULT_CATEGORIES[kind].map((name) => ({ userId, kind, name })),
  );
  tx.insert(categories).values(rows).onConflictDoNothing().run();
}

// ---------------------------------------------------------------------------------------------
// Management

function isId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function assertKind(value: unknown): CategoryKind {
  if (value !== "expense" && value !== "income") {
    throw new ServiceError("VALIDATION", "Choose expense or income.", "kind");
  }
  return value;
}

function ownedCategory(tx: DBOrTx, userId: number, categoryId: unknown): CategoryView {
  const row = isId(categoryId)
    ? tx
        .select({ id: categories.id, name: categories.name, kind: categories.kind })
        .from(categories)
        .where(and(eq(categories.id, categoryId), eq(categories.userId, userId)))
        .get()
    : undefined;
  if (!row) throw new ServiceError("NOT_FOUND", "Category not found.");
  return row;
}

function duplicateError(name: string, kind: CategoryKind): ServiceError {
  return new ServiceError("CONFLICT", `You already have an ${KIND_NOUN[kind]} category called “${name}”.`, "name");
}

/** CONFLICT when another category of the same user and kind has this name, ignoring case. */
function assertNameFree(tx: DBOrTx, userId: number, kind: CategoryKind, name: string, exceptId?: number): void {
  const folded = name.toLowerCase();
  const others = tx
    .select({ id: categories.id, name: categories.name })
    .from(categories)
    .where(
      and(
        eq(categories.userId, userId),
        eq(categories.kind, kind),
        exceptId === undefined ? undefined : ne(categories.id, exceptId),
      ),
    )
    .all();
  const clash = others.find((c) => c.name.toLowerCase() === folded);
  if (clash) throw duplicateError(clash.name, kind);
}

const normalizeCategoryName = (value: unknown) => normalizeName(value, "name", MAX_CATEGORY_NAME_LENGTH);

/** Create a category. Name trimmed, inner whitespace collapsed, 1–40 chars, unique per kind ignoring case. */
export function createCategory(userId: number, input: { name: string; kind: CategoryKind }): CategoryView {
  const kind = assertKind(input.kind);
  const name = normalizeCategoryName(input.name);
  try {
    return getDb().transaction((tx) => {
      assertNameFree(tx, userId, kind, name);
      return tx
        .insert(categories)
        .values({ userId, kind, name })
        .returning({ id: categories.id, name: categories.name, kind: categories.kind })
        .get();
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw duplicateError(name, kind);
    throw err;
  }
}

/** Rename an owned category (its kind never changes). Changing only the letter case of its own name is allowed. */
export function renameCategory(userId: number, categoryId: number, input: { name: string }): CategoryView {
  const name = normalizeCategoryName(input.name);
  let kind: CategoryKind | undefined;
  try {
    return getDb().transaction((tx) => {
      const current = ownedCategory(tx, userId, categoryId);
      kind = current.kind;
      if (current.name === name) return current;
      assertNameFree(tx, userId, current.kind, name, current.id);
      tx.update(categories)
        .set({ name })
        .where(and(eq(categories.id, current.id), eq(categories.userId, userId)))
        .run();
      return { ...current, name };
    });
  } catch (err) {
    if (kind && isUniqueViolation(err)) throw duplicateError(name, kind);
    throw err;
  }
}

/**
 * Remove an owned category. Unused → deleted (`moveToCategoryId` ignored). In use → its transactions are
 * re-pointed to `moveToCategoryId` (another owned category of the same kind) and the category is deleted, in one
 * DB transaction. Without a replacement: CONFLICT naming the transaction count.
 */
export function deleteCategory(
  userId: number,
  categoryId: number,
  opts: { moveToCategoryId?: number | null } = {},
): { movedTransactions: number } {
  return getDb().transaction((tx) => {
    const category = ownedCategory(tx, userId, categoryId);
    const usage =
      tx
        .select({ n: count() })
        .from(transactions)
        .where(and(eq(transactions.categoryId, category.id), eq(transactions.userId, userId)))
        .get()?.n ?? 0;

    if (usage > 0) {
      const noun = usage === 1 ? "1 transaction" : `${usage} transactions`;
      const moveTo = opts.moveToCategoryId;
      if (moveTo === undefined || moveTo === null) {
        const hasOther = tx
          .select({ id: categories.id })
          .from(categories)
          .where(
            and(eq(categories.userId, userId), eq(categories.kind, category.kind), ne(categories.id, category.id)),
          )
          .limit(1)
          .get();
        throw new ServiceError(
          "CONFLICT",
          hasOther
            ? `“${category.name}” is used by ${noun}. Choose a category to move them to.`
            : `“${category.name}” is used by ${noun} and is your only ${KIND_NOUN[category.kind]} category. ` +
                `Create another ${KIND_NOUN[category.kind]} category first, then move them there.`,
          "moveToCategoryId",
        );
      }
      if (moveTo === category.id) {
        throw new ServiceError("VALIDATION", "Choose a different category to move the transactions to.", "moveToCategoryId");
      }
      const target = isId(moveTo)
        ? tx
            .select({ id: categories.id, kind: categories.kind })
            .from(categories)
            .where(and(eq(categories.id, moveTo), eq(categories.userId, userId)))
            .get()
        : undefined;
      if (!target || target.kind !== category.kind) {
        throw new ServiceError(
          "VALIDATION",
          `Choose another ${KIND_NOUN[category.kind]} category to move the transactions to.`,
          "moveToCategoryId",
        );
      }
      tx.update(transactions)
        .set({ categoryId: target.id })
        .where(and(eq(transactions.categoryId, category.id), eq(transactions.userId, userId)))
        .run();
    }

    tx.delete(categories).where(and(eq(categories.id, category.id), eq(categories.userId, userId))).run();
    return { movedTransactions: usage };
  });
}
