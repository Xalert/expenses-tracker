import "server-only";
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { getDb, type DBOrTx } from "@/db";
import { categories, tags, transactions, transactionTags, transfers, type CategoryKind } from "@/db/schema";
import { ServiceError } from "@/lib/errors";
import { MAX_TAGS_PER_ENTRY } from "@/lib/tags";
import { assertId, isPgId } from "./_validate";
import { normalizeTagName, resolveTagIds } from "./tags";
import { filterConditions, type TransactionFilters } from "./transactions";

// Bulk edits on /transactions: delete, set the category, add or remove a tag on many entries at once. Each call is one
// DB transaction (all or nothing) over a target — the ids of the rows the user ticked, or the list's filters
// re-evaluated here ("Select all N matching"). A selected transfer leg stands for its whole transfer: Delete removes
// the transfer and both legs; the other actions skip transfers and count them. Another user's ids behave like
// missing ones (they match nothing).

/** Most rows (entries and transfer legs) one bulk call may touch; beyond it the call is refused and nothing changes. */
export const MAX_BULK_ENTRIES = 2000;

export type BulkTarget = { ids: number[] } | { filters: TransactionFilters };

/** What a target resolves to: expenses / income, and transfers (each counted once, whichever legs were selected). */
export type BulkSelection = { entries: number; transfers: number };

type TargetRow = { id: number; kind: string; transferId: number | null; categoryId: number | null };

function targetCondition(userId: number, target: BulkTarget): SQL {
  if ("ids" in target) {
    const ids = target.ids;
    if (!Array.isArray(ids) || ids.length === 0) {
      throw new ServiceError("VALIDATION", "Select at least one entry.", "ids");
    }
    if (ids.length > MAX_BULK_ENTRIES) throw tooMany(ids.length);
    // A malformed id is a bad request, not a missing row.
    for (const id of ids) if (!isPgId(id)) throw new ServiceError("VALIDATION", "Invalid selection.", "ids");
    return and(eq(transactions.userId, userId), inArray(transactions.id, [...new Set(ids)]))!;
  }
  return filterConditions(userId, { ...target.filters, limit: undefined, offset: undefined });
}

function tooMany(n: number): ServiceError {
  return new ServiceError(
    "VALIDATION",
    `That is ${n.toLocaleString("en-US")} entries; one change can touch at most ${MAX_BULK_ENTRIES.toLocaleString("en-US")}. ` +
      "Narrow the filters (a month at a time, say) and repeat. Nothing was changed.",
  );
}

/** The target's rows, locked FOR UPDATE; refused beyond MAX_BULK_ENTRIES, NOT_FOUND when nothing matches. */
async function lockTarget(userId: number, target: BulkTarget, tx: DBOrTx): Promise<TargetRow[]> {
  const where = targetCondition(userId, target);
  const [{ n }] = await tx
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(transactions)
    .where(where);
  if (n > MAX_BULK_ENTRIES) throw tooMany(n);
  const rows = await tx
    .select({
      id: transactions.id,
      kind: transactions.kind,
      transferId: transactions.transferId,
      categoryId: transactions.categoryId,
    })
    .from(transactions)
    .where(where)
    .orderBy(transactions.id)
    .for("update");
  if (rows.length === 0) {
    throw new ServiceError(
      "NOT_FOUND",
      "ids" in target ? "None of the selected entries exist any more." : "No entries match these filters.",
    );
  }
  return rows;
}

function split(rows: TargetRow[]): { entries: TargetRow[]; transferIds: number[] } {
  const entries = rows.filter((r) => r.transferId === null);
  const transferIds = [...new Set(rows.filter((r) => r.transferId !== null).map((r) => r.transferId!))];
  return { entries, transferIds };
}

/** What `target` would touch now (the delete confirmation's counts). Read-only; same checks as the actions. */
export async function previewBulk(userId: number, target: BulkTarget): Promise<BulkSelection> {
  const db = await getDb();
  return await db.transaction(async (tx) => {
    const { entries, transferIds } = split(await lockTarget(userId, target, tx));
    return { entries: entries.length, transfers: transferIds.length };
  });
}

/**
 * Delete the target's expenses / income and, for every selected transfer leg, the whole transfer (both legs). With
 * `expected` (the counts the user confirmed) a target that has changed since is refused (CONFLICT, nothing deleted).
 */
export async function bulkDelete(
  userId: number,
  target: BulkTarget,
  opts: { expected?: BulkSelection } = {},
): Promise<BulkSelection> {
  const db = await getDb();
  return await db.transaction(async (tx) => {
    const { entries, transferIds } = split(await lockTarget(userId, target, tx));
    const found = { entries: entries.length, transfers: transferIds.length };
    const { expected } = opts;
    if (expected && (expected.entries !== found.entries || expected.transfers !== found.transfers)) {
      throw new ServiceError("CONFLICT", "The selection has changed since you confirmed. Check the new counts and confirm again.");
    }
    if (entries.length > 0) {
      await tx.delete(transactions).where(
        and(
          eq(transactions.userId, userId),
          inArray(
            transactions.id,
            entries.map((e) => e.id),
          ),
        ),
      );
    }
    if (transferIds.length > 0) {
      await tx.delete(transactions).where(and(eq(transactions.userId, userId), inArray(transactions.transferId, transferIds)));
      await tx.delete(transfers).where(and(eq(transfers.userId, userId), inArray(transfers.id, transferIds)));
    }
    return found;
  });
}

export type SetCategoryResult = {
  category: { id: number; name: string; kind: CategoryKind };
  /** Entries moved into the category. */
  changed: number;
  /** Entries of the category's kind that were already in it. */
  unchanged: number;
  /** Entries of the other kind (an expense category cannot take income), left as they were. */
  skippedOtherKind: number;
  /** Transfers in the target, left as they were. */
  skippedTransfers: number;
};

/**
 * Move the target's entries of the category's kind into `categoryId`. The category must be the user's (NOT_FOUND)
 * and not archived (VALIDATION), both on field `categoryId`, like any new use; a target with no entry of that kind is
 * refused on the same field.
 */
export async function bulkSetCategory(userId: number, target: BulkTarget, categoryId: number): Promise<SetCategoryResult> {
  const id = assertId(categoryId, "categoryId", "category");
  const db = await getDb();
  return await db.transaction(async (tx) => {
    // FOR SHARE, as `validateTransactionInput`: a concurrent kind change waits for this transaction.
    const [category] = await tx
      .select({ id: categories.id, name: categories.name, kind: categories.kind, archivedAt: categories.archivedAt })
      .from(categories)
      .where(and(eq(categories.id, id), eq(categories.userId, userId)))
      .for("share");
    if (!category) throw new ServiceError("NOT_FOUND", "Category not found.", "categoryId");
    if (category.archivedAt) {
      throw new ServiceError("VALIDATION", `“${category.name}” is archived. Choose another category.`, "categoryId");
    }
    const { entries, transferIds } = split(await lockTarget(userId, target, tx));
    const ofKind = entries.filter((e) => e.kind === category.kind);
    if (ofKind.length === 0) {
      const message =
        category.kind === "expense"
          ? `“${category.name}” is an expense category, and none of the selected entries is an expense.`
          : `“${category.name}” is an income category, and none of the selected entries is income.`;
      throw new ServiceError("VALIDATION", message, "categoryId");
    }
    const toMove = ofKind.filter((e) => e.categoryId !== category.id).map((e) => e.id);
    if (toMove.length > 0) {
      await tx
        .update(transactions)
        .set({ categoryId: category.id })
        .where(and(eq(transactions.userId, userId), inArray(transactions.id, toMove)));
    }
    return {
      category: { id: category.id, name: category.name, kind: category.kind },
      changed: toMove.length,
      unchanged: ofKind.length - toMove.length,
      skippedOtherKind: entries.length - ofKind.length,
      skippedTransfers: transferIds.length,
    };
  });
}

/** How many tags each entry has, and whether it has `tagId`. */
async function tagCounts(
  tx: DBOrTx,
  entryIds: number[],
  tagId: number | null,
): Promise<Map<number, { count: number; has: boolean }>> {
  const out = new Map<number, { count: number; has: boolean }>();
  if (entryIds.length === 0) return out;
  const rows = await tx
    .select({
      transactionId: transactionTags.transactionId,
      count: sql<number>`count(*)`.mapWith(Number),
      has: tagId === null ? sql<boolean>`false` : sql<boolean>`bool_or(${transactionTags.tagId} = ${tagId})`,
    })
    .from(transactionTags)
    .where(inArray(transactionTags.transactionId, entryIds))
    .groupBy(transactionTags.transactionId);
  for (const r of rows) out.set(r.transactionId, { count: r.count, has: Boolean(r.has) });
  return out;
}

export type AddTagResult = {
  /** The tag (created when it did not exist and at least one entry got it); id null when it was not created. */
  tag: { id: number | null; name: string };
  added: number;
  /** Entries that already had it. */
  already: number;
  /** Entries already at MAX_TAGS_PER_ENTRY tags, left as they were. */
  skippedAtLimit: number;
  skippedTransfers: number;
};

/**
 * Add the tag named `tagName` (cleaned and checked like any tag name; VALIDATION on field `tagName`; created when it
 * does not exist, matched ignoring case when it does) to the target's expenses and income. Entries at the 10-tag limit
 * are skipped and counted; a target with no expense or income is refused (field `tagName`).
 */
export async function bulkAddTag(userId: number, target: BulkTarget, tagName: string): Promise<AddTagResult> {
  const name = normalizeTagName(tagName, "tagName");
  const db = await getDb();
  return await db.transaction(async (tx) => {
    const { entries, transferIds } = split(await lockTarget(userId, target, tx));
    if (entries.length === 0) {
      throw new ServiceError("VALIDATION", "Only expenses and income take tags, and the selection has none.", "tagName");
    }
    const [existing] = await tx
      .select({ id: tags.id, name: tags.name })
      .from(tags)
      .where(and(eq(tags.userId, userId), sql`lower(${tags.name}) = lower(${name}::text)`));
    const counts = await tagCounts(
      tx,
      entries.map((e) => e.id),
      existing?.id ?? null,
    );
    let already = 0;
    let atLimit = 0;
    const toAdd: number[] = [];
    for (const e of entries) {
      const c = counts.get(e.id);
      if (c?.has) already++;
      else if ((c?.count ?? 0) >= MAX_TAGS_PER_ENTRY) atLimit++;
      else toAdd.push(e.id);
    }
    let tag: { id: number | null; name: string } = existing ?? { id: null, name };
    if (toAdd.length > 0) {
      if (!existing) {
        const [newId] = await resolveTagIds(userId, [name], tx);
        const [row] = await tx.select({ id: tags.id, name: tags.name }).from(tags).where(eq(tags.id, newId));
        tag = row;
      }
      await tx
        .insert(transactionTags)
        .values(toAdd.map((transactionId) => ({ transactionId, tagId: tag.id! })))
        .onConflictDoNothing();
    }
    return { tag, added: toAdd.length, already, skippedAtLimit: atLimit, skippedTransfers: transferIds.length };
  });
}

export type RemoveTagResult = {
  tag: { id: number; name: string };
  removed: number;
  /** Expenses / income that did not have it. */
  notTagged: number;
  skippedTransfers: number;
};

/**
 * Take the tag `tagId` (the user's; NOT_FOUND on field `tagId` otherwise) off the target's expenses and income. The
 * tag itself stays, possibly unused. A target with no expense or income is refused (field `tagId`).
 */
export async function bulkRemoveTag(userId: number, target: BulkTarget, tagId: number): Promise<RemoveTagResult> {
  const id = assertId(tagId, "tagId", "tag");
  const db = await getDb();
  return await db.transaction(async (tx) => {
    const [tag] = await tx
      .select({ id: tags.id, name: tags.name })
      .from(tags)
      .where(and(eq(tags.id, id), eq(tags.userId, userId)));
    if (!tag) throw new ServiceError("NOT_FOUND", "Tag not found.", "tagId");
    const { entries, transferIds } = split(await lockTarget(userId, target, tx));
    if (entries.length === 0) {
      throw new ServiceError("VALIDATION", "Only expenses and income carry tags, and the selection has none.", "tagId");
    }
    const removed = await tx
      .delete(transactionTags)
      .where(
        and(
          eq(transactionTags.tagId, tag.id),
          inArray(
            transactionTags.transactionId,
            entries.map((e) => e.id),
          ),
        ),
      )
      .returning({ transactionId: transactionTags.transactionId });
    return { tag, removed: removed.length, notTagged: entries.length - removed.length, skippedTransfers: transferIds.length };
  });
}
