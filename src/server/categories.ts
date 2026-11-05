import "server-only";
import { and, asc, eq } from "drizzle-orm";
import { getDb, type DBOrTx } from "@/db";
import { categories, type CategoryKind } from "@/db/schema";

export type CategoryView = { id: number; name: string; kind: CategoryKind };

export const DEFAULT_CATEGORIES: Record<CategoryKind, readonly string[]> = {
  expense: ["Food", "Groceries", "Bills", "Transport", "Housing"],
  income: ["Salary", "Refund", "Extra Income"],
};

/** The user's categories, optionally for one kind; ordered expense first, then by name. */
export function listCategories(userId: number, kind?: CategoryKind): CategoryView[] {
  const where = kind
    ? and(eq(categories.userId, userId), eq(categories.kind, kind))
    : eq(categories.userId, userId);
  return getDb()
    .select({ id: categories.id, name: categories.name, kind: categories.kind })
    .from(categories)
    .where(where)
    .orderBy(asc(categories.kind), asc(categories.name))
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
