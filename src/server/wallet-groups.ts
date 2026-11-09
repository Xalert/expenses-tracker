import "server-only";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import { getDb, type DBOrTx } from "@/db";
import { walletGroups, wallets, type WalletGroup } from "@/db/schema";
import { ServiceError } from "@/lib/errors";
import { assertId, normalizeName } from "./_validate";

export type WalletGroupView = { id: number; name: string; walletCount: number; createdAt: Date };

export const MAX_GROUP_NAME_LENGTH = 40;
export const DEFAULT_GROUP_NAME = "Personal";

const normalizeGroupName = (value: unknown) => normalizeName(value, "name", MAX_GROUP_NAME_LENGTH);

function selectViews(userId: number, extra?: ReturnType<typeof eq>) {
  return getDb()
    .select({
      id: walletGroups.id,
      name: walletGroups.name,
      walletCount: sql<number>`count(${wallets.id})`,
      createdAt: walletGroups.createdAt,
    })
    .from(walletGroups)
    .leftJoin(wallets, eq(wallets.groupId, walletGroups.id))
    .where(extra ? and(eq(walletGroups.userId, userId), extra) : eq(walletGroups.userId, userId))
    .groupBy(walletGroups.id);
}

/** The user's groups with their wallet counts (archived wallets included), by name ignoring case, then id. */
export function listWalletGroups(userId: number): WalletGroupView[] {
  return selectViews(userId)
    .orderBy(sql`${walletGroups.name} collate nocase`, asc(walletGroups.id))
    .all();
}

/** One owned group or null. */
export function getWalletGroup(userId: number, groupId: number): WalletGroupView | null {
  if (typeof groupId !== "number" || !Number.isSafeInteger(groupId)) return null;
  return selectViews(userId, eq(walletGroups.id, groupId)).get() ?? null;
}

/** Internal: the owned group row or NOT_FOUND. */
export function getOwnedGroupRow(userId: number, groupId: number, tx: DBOrTx = getDb(), field = "groupId"): WalletGroup {
  const row =
    typeof groupId === "number" && Number.isSafeInteger(groupId)
      ? tx
          .select()
          .from(walletGroups)
          .where(and(eq(walletGroups.id, groupId), eq(walletGroups.userId, userId)))
          .get()
      : undefined;
  if (!row) throw new ServiceError("NOT_FOUND", "Group not found.", field);
  return row;
}

/** The id of the user's oldest group (lowest id): where a wallet goes when nobody chose a group. */
export function getDefaultGroupId(userId: number, tx: DBOrTx = getDb()): number {
  const row = tx
    .select({ id: walletGroups.id })
    .from(walletGroups)
    .where(eq(walletGroups.userId, userId))
    .orderBy(asc(walletGroups.id))
    .limit(1)
    .get();
  if (!row) throw new ServiceError("NOT_FOUND", "Group not found.", "groupId");
  return row.id;
}

/** Create `Personal` when the user has no group at all. Idempotent; pass the transaction handle in registration. */
export function seedDefaultGroup(userId: number, tx: DBOrTx = getDb()): void {
  const has = tx.select({ id: walletGroups.id }).from(walletGroups).where(eq(walletGroups.userId, userId)).limit(1).get();
  if (!has) tx.insert(walletGroups).values({ userId, name: DEFAULT_GROUP_NAME }).run();
}

function duplicateError(name: string): ServiceError {
  return new ServiceError("CONFLICT", `You already have a group called “${name}”.`, "name");
}

function assertNameFree(tx: DBOrTx, userId: number, name: string, exceptId?: number): void {
  const folded = name.toLowerCase();
  const others = tx
    .select({ name: walletGroups.name })
    .from(walletGroups)
    .where(and(eq(walletGroups.userId, userId), exceptId === undefined ? undefined : ne(walletGroups.id, exceptId)))
    .all();
  const clash = others.find((g) => g.name.toLowerCase() === folded);
  if (clash) throw duplicateError(clash.name);
}

/** Create a group. Name rules as for categories: 1–40 characters, unique per user ignoring case. */
export function createWalletGroup(userId: number, input: { name: string }): WalletGroupView {
  const name = normalizeGroupName(input.name);
  const id = getDb().transaction((tx) => {
    assertNameFree(tx, userId, name);
    return tx.insert(walletGroups).values({ userId, name }).returning({ id: walletGroups.id }).get().id;
  });
  return getWalletGroup(userId, id)!;
}

/** Rename an owned group. Changing only the letter case of its own name is allowed. */
export function renameWalletGroup(userId: number, groupId: number, input: { name: string }): WalletGroupView {
  assertId(groupId, "groupId", "group");
  const name = normalizeGroupName(input.name);
  getDb().transaction((tx) => {
    const current = getOwnedGroupRow(userId, groupId, tx);
    if (current.name === name) return;
    assertNameFree(tx, userId, name, current.id);
    tx.update(walletGroups)
      .set({ name })
      .where(and(eq(walletGroups.id, current.id), eq(walletGroups.userId, userId)))
      .run();
  });
  return getWalletGroup(userId, groupId)!;
}

/** Delete an owned, empty group that is not the user's last one; CONFLICT otherwise. */
export function deleteWalletGroup(userId: number, groupId: number): void {
  getDb().transaction((tx) => {
    const group = getOwnedGroupRow(userId, groupId, tx);
    const used = tx.select({ id: wallets.id }).from(wallets).where(eq(wallets.groupId, group.id)).limit(1).get();
    if (used) {
      throw new ServiceError(
        "CONFLICT",
        `“${group.name}” still has wallets. Move or delete them first.`,
        "groupId",
      );
    }
    const other = tx
      .select({ id: walletGroups.id })
      .from(walletGroups)
      .where(and(eq(walletGroups.userId, userId), ne(walletGroups.id, group.id)))
      .limit(1)
      .get();
    if (!other) throw new ServiceError("CONFLICT", "You need at least one group. Create another one first.", "groupId");
    tx.delete(walletGroups).where(and(eq(walletGroups.id, group.id), eq(walletGroups.userId, userId))).run();
  });
}
