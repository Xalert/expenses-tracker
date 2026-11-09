import "server-only";
import { and, asc, count, eq, ne, sql } from "drizzle-orm";
import { getDb, type DBOrTx } from "@/db";
import { categories, transactions, wallets, type CategoryKind } from "@/db/schema";
import { isValidCurrency } from "@/lib/currencies";
import { isValidMonth, monthRange } from "@/lib/dates";
import { ServiceError } from "@/lib/errors";
import { MAX_ID, assertId, isPgId, isUniqueViolation, normalizeName } from "./_validate";

export type CategoryView = { id: number; name: string; kind: CategoryKind };
export type CategoryWithUsage = CategoryView & { transactionCount: number };
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

// Expense first, then by name ignoring case (user-entered names are not always capitalised).
const categoryOrder = [asc(categories.kind), sql`lower(${categories.name})`, asc(categories.id)];

/** The user's categories, optionally for one kind; ordered expense first, then by name. */
export async function listCategories(userId: number, kind?: CategoryKind): Promise<CategoryView[]> {
  const where = kind
    ? and(eq(categories.userId, userId), eq(categories.kind, kind))
    : eq(categories.userId, userId);
  return (await getDb())
    .select({ id: categories.id, name: categories.name, kind: categories.kind })
    .from(categories)
    .where(where)
    .orderBy(...categoryOrder);
}

/**
 * All the user's categories with how many transactions use each; same order as `listCategories`. With
 * `opts.month` also the month's count (all currencies) and, with `opts.currency`, the month's amount in it.
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
  return (await getDb())
    .select({
      id: categories.id,
      name: categories.name,
      kind: categories.kind,
      transactionCount: sql<number>`count(${transactions.id})`.mapWith(Number),
      monthCount: sql<number>`coalesce(sum(case when ${inMonth} then 1 else 0 end), 0)`.mapWith(Number),
      monthAmountMinor: sql<number>`coalesce(sum(case when ${inMonth} and ${inCurrency} then ${transactions.amountMinor} else 0 end), 0)`.mapWith(Number),
    })
    .from(categories)
    .leftJoin(transactions, and(eq(transactions.categoryId, categories.id), eq(transactions.userId, userId), inGroup))
    .leftJoin(wallets, eq(wallets.id, transactions.walletId))
    .where(eq(categories.userId, userId))
    .groupBy(categories.id)
    .orderBy(...categoryOrder);
}

/** One owned category or null. */
export async function getCategory(userId: number, categoryId: number): Promise<CategoryView | null> {
  if (!isPgId(categoryId)) return null;
  const [row] = await (await getDb())
    .select({ id: categories.id, name: categories.name, kind: categories.kind })
    .from(categories)
    .where(and(eq(categories.id, categoryId), eq(categories.userId, userId)));
  return row ?? null;
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

async function ownedCategory(tx: DBOrTx, userId: number, categoryId: unknown): Promise<CategoryView> {
  const [row] = isId(categoryId)
    ? await tx
        .select({ id: categories.id, name: categories.name, kind: categories.kind })
        .from(categories)
        .where(and(eq(categories.id, categoryId), eq(categories.userId, userId)))
    : [];
  if (!row) throw new ServiceError("NOT_FOUND", "Category not found.");
  return row;
}

function duplicateError(name: string, kind: CategoryKind): ServiceError {
  return new ServiceError("CONFLICT", `You already have an ${KIND_NOUN[kind]} category called “${name}”.`, "name");
}

/** CONFLICT when another category of the same user and kind has this name, ignoring case. */
async function assertNameFree(
  tx: DBOrTx,
  userId: number,
  kind: CategoryKind,
  name: string,
  exceptId?: number,
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
  if (clash) throw duplicateError(clash.name, kind);
}

const normalizeCategoryName = (value: unknown) => normalizeName(value, "name", MAX_CATEGORY_NAME_LENGTH);

/** Create a category. Name trimmed, inner whitespace collapsed, 1–40 chars, unique per kind ignoring case. */
export async function createCategory(userId: number, input: { name: string; kind: CategoryKind }): Promise<CategoryView> {
  const kind = assertKind(input.kind);
  const name = normalizeCategoryName(input.name);
  try {
    const db = await getDb();
    return await db.transaction(async (tx) => {
      await assertNameFree(tx, userId, kind, name);
      const [row] = await tx
        .insert(categories)
        .values({ userId, kind, name })
        .returning({ id: categories.id, name: categories.name, kind: categories.kind });
      return row;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw duplicateError(name, kind);
    throw err;
  }
}

/** Rename an owned category (its kind never changes). Changing only the letter case of its own name is allowed. */
export async function renameCategory(
  userId: number,
  categoryId: number,
  input: { name: string },
): Promise<CategoryView> {
  const name = normalizeCategoryName(input.name);
  let kind: CategoryKind | undefined;
  try {
    const db = await getDb();
    return await db.transaction(async (tx) => {
      const current = await ownedCategory(tx, userId, categoryId);
      kind = current.kind;
      if (current.name === name) return current;
      await assertNameFree(tx, userId, current.kind, name, current.id);
      await tx
        .update(categories)
        .set({ name })
        .where(and(eq(categories.id, current.id), eq(categories.userId, userId)));
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
export async function deleteCategory(
  userId: number,
  categoryId: number,
  opts: { moveToCategoryId?: number | null } = {},
): Promise<{ movedTransactions: number }> {
  const db = await getDb();
  return await db.transaction(async (tx) => {
    const category = await ownedCategory(tx, userId, categoryId);
    const [usageRow] = await tx
      .select({ n: count() })
      .from(transactions)
      .where(and(eq(transactions.categoryId, category.id), eq(transactions.userId, userId)));
    const usage = usageRow?.n ?? 0;

    if (usage > 0) {
      const noun = usage === 1 ? "1 transaction" : `${usage} transactions`;
      const moveTo = opts.moveToCategoryId;
      if (moveTo === undefined || moveTo === null) {
        const [hasOther] = await tx
          .select({ id: categories.id })
          .from(categories)
          .where(
            and(eq(categories.userId, userId), eq(categories.kind, category.kind), ne(categories.id, category.id)),
          )
          .limit(1);
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
      const [target] = isId(moveTo)
        ? await tx
            .select({ id: categories.id, kind: categories.kind })
            .from(categories)
            .where(and(eq(categories.id, moveTo), eq(categories.userId, userId)))
        : [];
      if (!target || target.kind !== category.kind) {
        throw new ServiceError(
          "VALIDATION",
          `Choose another ${KIND_NOUN[category.kind]} category to move the transactions to.`,
          "moveToCategoryId",
        );
      }
      await tx
        .update(transactions)
        .set({ categoryId: target.id })
        .where(and(eq(transactions.categoryId, category.id), eq(transactions.userId, userId)));
    }

    await tx.delete(categories).where(and(eq(categories.id, category.id), eq(categories.userId, userId)));
    return { movedTransactions: usage };
  });
}
