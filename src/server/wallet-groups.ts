import "server-only";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import { getDb, type DBOrTx } from "@/db";
import { walletGroups, wallets, type WalletGroup } from "@/db/schema";
import { ServiceError } from "@/lib/errors";
import { MAX_ID, assertId, normalizeName } from "./_validate";

export type WalletGroupView = { id: number; name: string; walletCount: number; createdAt: Date };

export const MAX_GROUP_NAME_LENGTH = 40;
export const DEFAULT_GROUP_NAME = "Personal";

const normalizeGroupName = (value: unknown) => normalizeName(value, "name", MAX_GROUP_NAME_LENGTH);

function selectViews(db: DBOrTx, userId: number, extra?: ReturnType<typeof eq>) {
  return db
    .select({
      id: walletGroups.id,
      name: walletGroups.name,
      walletCount: sql<number>`count(${wallets.id})`.mapWith(Number),
      createdAt: walletGroups.createdAt,
    })
    .from(walletGroups)
    .leftJoin(wallets, eq(wallets.groupId, walletGroups.id))
    .where(extra ? and(eq(walletGroups.userId, userId), extra) : eq(walletGroups.userId, userId))
    .groupBy(walletGroups.id);
}

/** The user's groups with their wallet counts (archived wallets included), by name ignoring case, then id. */
export async function listWalletGroups(userId: number): Promise<WalletGroupView[]> {
  return selectViews(await getDb(), userId).orderBy(sql`lower(${walletGroups.name})`, asc(walletGroups.id));
}

/** One owned group or null. */
export async function getWalletGroup(userId: number, groupId: number, db?: DBOrTx): Promise<WalletGroupView | null> {
  if (typeof groupId !== "number" || !Number.isSafeInteger(groupId) || groupId > MAX_ID) return null;
  const [row] = await selectViews(db ?? (await getDb()), userId, eq(walletGroups.id, groupId));
  return row ?? null;
}

/** Internal: the owned group row or NOT_FOUND. */
export async function getOwnedGroupRow(
  userId: number,
  groupId: number,
  tx?: DBOrTx,
  field = "groupId",
): Promise<WalletGroup> {
  const db = tx ?? (await getDb());
  const [row] =
    typeof groupId === "number" && Number.isSafeInteger(groupId) && groupId <= MAX_ID
      ? await db
          .select()
          .from(walletGroups)
          .where(and(eq(walletGroups.id, groupId), eq(walletGroups.userId, userId)))
      : [];
  if (!row) throw new ServiceError("NOT_FOUND", "Group not found.", field);
  return row;
}

/** The id of the user's oldest group (lowest id): where a wallet goes when nobody chose a group. */
export async function getDefaultGroupId(userId: number, tx?: DBOrTx): Promise<number> {
  const db = tx ?? (await getDb());
  const [row] = await db
    .select({ id: walletGroups.id })
    .from(walletGroups)
    .where(eq(walletGroups.userId, userId))
    .orderBy(asc(walletGroups.id))
    .limit(1);
  if (!row) throw new ServiceError("NOT_FOUND", "Group not found.", "groupId");
  return row.id;
}

/** Create `Personal` when the user has no group at all. Idempotent; pass the transaction handle in registration. */
export async function seedDefaultGroup(userId: number, tx?: DBOrTx): Promise<void> {
  const db = tx ?? (await getDb());
  const [has] = await db.select({ id: walletGroups.id }).from(walletGroups).where(eq(walletGroups.userId, userId)).limit(1);
  if (!has) await db.insert(walletGroups).values({ userId, name: DEFAULT_GROUP_NAME });
}

function duplicateError(name: string): ServiceError {
  return new ServiceError("CONFLICT", `You already have a group called “${name}”.`, "name");
}

async function assertNameFree(tx: DBOrTx, userId: number, name: string, exceptId?: number): Promise<void> {
  const folded = name.toLowerCase();
  const others = await tx
    .select({ name: walletGroups.name })
    .from(walletGroups)
    .where(and(eq(walletGroups.userId, userId), exceptId === undefined ? undefined : ne(walletGroups.id, exceptId)));
  const clash = others.find((g) => g.name.toLowerCase() === folded);
  if (clash) throw duplicateError(clash.name);
}

/** Create a group. Name rules as for categories: 1–40 characters, unique per user ignoring case. */
export async function createWalletGroup(userId: number, input: { name: string }): Promise<WalletGroupView> {
  const name = normalizeGroupName(input.name);
  const db = await getDb();
  const id = await db.transaction(async (tx) => {
    await assertNameFree(tx, userId, name);
    const [row] = await tx.insert(walletGroups).values({ userId, name }).returning({ id: walletGroups.id });
    return row.id;
  });
  return (await getWalletGroup(userId, id))!;
}

/** Rename an owned group. Changing only the letter case of its own name is allowed. */
export async function renameWalletGroup(
  userId: number,
  groupId: number,
  input: { name: string },
): Promise<WalletGroupView> {
  assertId(groupId, "groupId", "group");
  const name = normalizeGroupName(input.name);
  const db = await getDb();
  await db.transaction(async (tx) => {
    const current = await getOwnedGroupRow(userId, groupId, tx);
    if (current.name === name) return;
    await assertNameFree(tx, userId, name, current.id);
    await tx
      .update(walletGroups)
      .set({ name })
      .where(and(eq(walletGroups.id, current.id), eq(walletGroups.userId, userId)));
  });
  return (await getWalletGroup(userId, groupId))!;
}

/** Delete an owned, empty group that is not the user's last one; CONFLICT otherwise. */
export async function deleteWalletGroup(userId: number, groupId: number): Promise<void> {
  const db = await getDb();
  await db.transaction(async (tx) => {
    const group = await getOwnedGroupRow(userId, groupId, tx);
    const [used] = await tx.select({ id: wallets.id }).from(wallets).where(eq(wallets.groupId, group.id)).limit(1);
    if (used) {
      throw new ServiceError(
        "CONFLICT",
        `“${group.name}” still has wallets. Move or delete them first.`,
        "groupId",
      );
    }
    const [other] = await tx
      .select({ id: walletGroups.id })
      .from(walletGroups)
      .where(and(eq(walletGroups.userId, userId), ne(walletGroups.id, group.id)))
      .limit(1);
    if (!other) throw new ServiceError("CONFLICT", "You need at least one group. Create another one first.", "groupId");
    await tx.delete(walletGroups).where(and(eq(walletGroups.id, group.id), eq(walletGroups.userId, userId)));
  });
}
