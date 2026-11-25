import "server-only";
import { and, count, eq, inArray, ne, sql } from "drizzle-orm";
import { getDb, type DBOrTx } from "@/db";
import { tags, transactionTags } from "@/db/schema";
import { ServiceError } from "@/lib/errors";
import { cleanTagName, dedupeTagNames, sortTagNames, tagKey, tagListProblem, tagNameProblem } from "@/lib/tags";
import { isPgId, isUniqueViolation } from "./_validate";

// Tags: free labels on expenses and income that cut across categories (SPEC "Tags"). A tag is created the first time
// an entry uses it; this module lists them (with use counts), renames (renaming onto another tag's name merges the
// two) and deletes them. The entry services (src/server/transactions.ts) set an entry's tags through `setEntryTags`.

/** A tag and how many entries carry it. */
export type TagView = { id: number; name: string; transactionCount: number };

/** By name ignoring case (code point order, as `sortTagNames`), then id. Sorted in JS, never SQL `lower()` order. */
function sortViews(list: TagView[]): TagView[] {
  return [...list].sort((a, b) => {
    const x = tagKey(a.name);
    const y = tagKey(b.name);
    return x < y ? -1 : x > y ? 1 : a.id - b.id;
  });
}

async function selectViews(db: DBOrTx, userId: number, tagId?: number): Promise<TagView[]> {
  const rows = await db
    .select({ id: tags.id, name: tags.name, transactionCount: count(transactionTags.transactionId) })
    .from(tags)
    .leftJoin(transactionTags, eq(transactionTags.tagId, tags.id))
    .where(and(eq(tags.userId, userId), tagId === undefined ? undefined : eq(tags.id, tagId)))
    .groupBy(tags.id);
  return rows.map((r) => ({ ...r, transactionCount: Number(r.transactionCount) }));
}

/** Every tag of the user with its entry count, by name (ignoring case). */
export async function listTags(userId: number): Promise<TagView[]> {
  return sortViews(await selectViews(await getDb(), userId));
}

/** One owned tag, or null. */
export async function getTag(userId: number, tagId: number, db?: DBOrTx): Promise<TagView | null> {
  if (!isPgId(tagId)) return null;
  const [row] = await selectViews(db ?? (await getDb()), userId, tagId);
  return row ?? null;
}

/** A tag name as stored: cleaned (trimmed, inner whitespace collapsed); VALIDATION on `field` otherwise. */
export function normalizeTagName(value: unknown, field = "name"): string {
  const name = typeof value === "string" ? cleanTagName(value) : "";
  const problem = tagNameProblem(name);
  if (problem) throw new ServiceError("VALIDATION", problem, field);
  return name;
}

/**
 * An entry's tag list as stored: each name cleaned and valid, repeats (ignoring case) dropped, at most
 * `MAX_TAGS_PER_ENTRY`. VALIDATION (field `tags`) otherwise.
 */
export function normalizeTagList(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new ServiceError("VALIDATION", "Invalid tags.", "tags");
  }
  const names = dedupeTagNames(value as string[]);
  const problem = tagListProblem(names);
  if (problem) throw new ServiceError("VALIDATION", problem, "tags");
  return names;
}

/** SQL `lower(tags.name) in (lower($1), …)`: the same folding as the unique index. */
function nameIn(names: readonly string[]) {
  return sql`lower(${tags.name}) in (${sql.join(
    names.map((n) => sql`lower(${n}::text)`),
    sql`, `,
  )})`;
}

/**
 * Internal: the ids of the user's tags named `names` (validated, deduped), creating the missing ones. Inside the
 * caller's DB transaction; a concurrent creation of the same name is absorbed by `on conflict do nothing`.
 */
export async function resolveTagIds(userId: number, names: readonly string[], tx: DBOrTx): Promise<number[]> {
  if (names.length === 0) return [];
  await tx
    .insert(tags)
    .values(names.map((name) => ({ userId, name })))
    .onConflictDoNothing();
  const rows = await tx.select({ id: tags.id }).from(tags).where(and(eq(tags.userId, userId), nameIn(names)));
  return [...new Set(rows.map((r) => r.id))];
}

/**
 * Internal (the importer): the id of the user's tag for each of `names` (normalised; distinct ignoring case), creating
 * the missing ones, keyed by the name as given. Matched with SQL `lower()`, the unique index's folding.
 */
export async function ensureTagIds(userId: number, names: readonly string[], tx: DBOrTx): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (let i = 0; i < names.length; i += 1000) {
    const chunk = names.slice(i, i + 1000);
    await tx
      .insert(tags)
      .values(chunk.map((name) => ({ userId, name })))
      .onConflictDoNothing();
    const values = sql.join(
      chunk.map((n) => sql`(${n}::text)`),
      sql`, `,
    );
    const rows = (await tx.execute(sql`
      select x.n as name, t.id as id from (values ${values}) as x(n)
      join ${tags} t on t.user_id = ${userId} and lower(t.name) = lower(x.n)`)) as unknown as {
      rows: { name: string; id: number }[];
    };
    for (const r of rows.rows) out.set(r.name, Number(r.id));
  }
  return out;
}

/**
 * Internal: replace the tags of entry `transactionId` (the caller has checked it is the user's and is an expense or
 * income) with `names` (already normalised), creating missing tags. Inside the caller's DB transaction.
 */
export async function setEntryTags(userId: number, transactionId: number, names: readonly string[], tx: DBOrTx): Promise<void> {
  const ids = await resolveTagIds(userId, names, tx);
  await tx.delete(transactionTags).where(eq(transactionTags.transactionId, transactionId));
  if (ids.length > 0) {
    await tx.insert(transactionTags).values(ids.map((tagId) => ({ transactionId, tagId })));
  }
}

const LOAD_CHUNK = 10_000;

/**
 * Internal: every tag link of the user's entries, as names per entry (sorted), for the backup. One query.
 */
export async function loadAllEntryTags(db: DBOrTx, userId: number): Promise<Map<number, string[]>> {
  const out = new Map<number, string[]>();
  const rows = await db
    .select({ transactionId: transactionTags.transactionId, name: tags.name })
    .from(transactionTags)
    .innerJoin(tags, eq(tags.id, transactionTags.tagId))
    .where(eq(tags.userId, userId));
  for (const r of rows) out.set(r.transactionId, [...(out.get(r.transactionId) ?? []), r.name]);
  for (const [id, names] of out) out.set(id, sortTagNames(names));
  return out;
}

/**
 * Internal: the tag names of each of `transactionIds` (one query per 10 000 ids), sorted by `sortTagNames`. Entries without tags are
 * absent from the map. The ids come from the caller's user-scoped query.
 */
export async function loadEntryTags(db: DBOrTx, transactionIds: readonly number[]): Promise<Map<number, string[]>> {
  const out = new Map<number, string[]>();
  const ids = [...new Set(transactionIds)];
  // One query for a page of entries; an export of tens of thousands is read in slices (bind-parameter limit).
  for (let i = 0; i < ids.length; i += LOAD_CHUNK) {
    const rows = await db
      .select({ transactionId: transactionTags.transactionId, name: tags.name })
      .from(transactionTags)
      .innerJoin(tags, eq(tags.id, transactionTags.tagId))
      .where(inArray(transactionTags.transactionId, ids.slice(i, i + LOAD_CHUNK)));
    for (const r of rows) out.set(r.transactionId, [...(out.get(r.transactionId) ?? []), r.name]);
  }
  for (const [id, names] of out) out.set(id, sortTagNames(names));
  return out;
}

/**
 * Rename a tag. The name follows the tag rules (field `name`). Changing only its letter case is allowed. When another
 * of the user's tags already has the name (ignoring case), the two are **merged**: this tag's entries get that tag
 * (an entry that had both keeps one) and this tag is deleted, in one DB transaction; the other tag keeps its own
 * spelling. NOT_FOUND for a missing or another user's tag.
 */
export async function renameTag(
  userId: number,
  tagId: number,
  input: { name: unknown },
): Promise<{ tag: TagView; mergedFrom: string | null }> {
  const name = normalizeTagName(input.name);
  if (!isPgId(tagId)) throw new ServiceError("NOT_FOUND", "Tag not found.");
  const db = await getDb();
  try {
    return await db.transaction(async (tx) => {
      const [current] = await tx
        .select({ id: tags.id, name: tags.name })
        .from(tags)
        .where(and(eq(tags.id, tagId), eq(tags.userId, userId)))
        .for("update");
      if (!current) throw new ServiceError("NOT_FOUND", "Tag not found.");
      const [target] = await tx
        .select({ id: tags.id, name: tags.name })
        .from(tags)
        .where(and(eq(tags.userId, userId), ne(tags.id, tagId), nameIn([name])))
        .for("update");
      if (!target) {
        await tx.update(tags).set({ name }).where(eq(tags.id, tagId));
        return { tag: (await getTag(userId, tagId, tx))!, mergedFrom: null };
      }
      // Merge: every entry of this tag gets the target (an entry that already has it keeps one row), then this tag goes.
      await tx.execute(sql`
        insert into ${transactionTags} (transaction_id, tag_id)
        select transaction_id, ${target.id} from ${transactionTags} where tag_id = ${tagId}
        on conflict do nothing`);
      await tx.delete(tags).where(eq(tags.id, tagId));
      return { tag: (await getTag(userId, target.id, tx))!, mergedFrom: current.name };
    });
  } catch (err) {
    // Another request created a tag of that name between the read and the update.
    if (isUniqueViolation(err)) {
      throw new ServiceError("CONFLICT", `A tag named “${name}” was just added. Try again to merge into it.`, "name");
    }
    throw err;
  }
}

/** Delete a tag: it is removed from its entries, which stay. NOT_FOUND for a missing or another user's tag. */
export async function deleteTag(userId: number, tagId: number): Promise<{ name: string; transactionCount: number }> {
  const db = await getDb();
  return await db.transaction(async (tx) => {
    const tag = await getTag(userId, tagId, tx);
    if (!tag) throw new ServiceError("NOT_FOUND", "Tag not found.");
    await tx.delete(tags).where(and(eq(tags.id, tagId), eq(tags.userId, userId)));
    return { name: tag.name, transactionCount: tag.transactionCount };
  });
}
