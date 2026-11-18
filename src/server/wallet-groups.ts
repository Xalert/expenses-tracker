import "server-only";
import { and, asc, eq, sql } from "drizzle-orm";
import { getDb, type DBOrTx } from "@/db";
import { walletGroups, wallets, type WalletGroup } from "@/db/schema";
import { ServiceError } from "@/lib/errors";
import { isGroupColor, type GroupColor } from "@/lib/group-colors";
import { MAX_ID, assertId, normalizeName } from "./_validate";

export type WalletGroupView = {
  id: number;
  name: string;
  /** Display order (ascending, then id). Unique per user in practice, with gaps after a delete. */
  position: number;
  color: GroupColor | null;
  archivedAt: Date | null;
  walletCount: number;
  createdAt: Date;
};

export const MAX_GROUP_NAME_LENGTH = 40;
export const DEFAULT_GROUP_NAME = "Personal";

const normalizeGroupName = (value: unknown) => normalizeName(value, "name", MAX_GROUP_NAME_LENGTH);

/** `undefined` stays undefined (unchanged); null or "" is no colour; anything else must be in the palette. */
function normalizeColor(value: unknown): GroupColor | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (!isGroupColor(value)) throw new ServiceError("VALIDATION", "Choose a colour from the list.", "color");
  return value;
}

function selectViews(db: DBOrTx, userId: number, extra?: ReturnType<typeof eq>) {
  return db
    .select({
      id: walletGroups.id,
      name: walletGroups.name,
      position: walletGroups.position,
      color: sql<GroupColor | null>`${walletGroups.color}`,
      archivedAt: walletGroups.archivedAt,
      walletCount: sql<number>`count(${wallets.id})`.mapWith(Number),
      createdAt: walletGroups.createdAt,
    })
    .from(walletGroups)
    .leftJoin(wallets, eq(wallets.groupId, walletGroups.id))
    .where(extra ? and(eq(walletGroups.userId, userId), extra) : eq(walletGroups.userId, userId))
    .groupBy(walletGroups.id);
}

/** A colour stored before the palette changed reads as none. */
const cleanView = (g: WalletGroupView): WalletGroupView => (isGroupColor(g.color) || g.color === null ? g : { ...g, color: null });

/**
 * The user's groups with their wallet counts (archived wallets included), by position, then id. Archived groups are
 * included (callers split them off: `archivedAt !== null`).
 */
export async function listWalletGroups(userId: number): Promise<WalletGroupView[]> {
  const rows = await selectViews(await getDb(), userId).orderBy(asc(walletGroups.position), asc(walletGroups.id));
  return rows.map(cleanView);
}

/** One owned group (archived or not) or null. */
export async function getWalletGroup(userId: number, groupId: number, db?: DBOrTx): Promise<WalletGroupView | null> {
  if (typeof groupId !== "number" || !Number.isSafeInteger(groupId) || groupId > MAX_ID) return null;
  const [row] = await selectViews(db ?? (await getDb()), userId, eq(walletGroups.id, groupId));
  return row ? cleanView(row) : null;
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

/**
 * Internal: the owned group row a wallet may be put into — NOT_FOUND when it is not the user's, VALIDATION when it is
 * archived, unless it is `keepGroupId` (the group the wallet is already in: saving a wallet never forces it out).
 */
export async function getOpenGroupRow(
  userId: number,
  groupId: number,
  tx?: DBOrTx,
  keepGroupId?: number,
  field = "groupId",
): Promise<WalletGroup> {
  const row = await getOwnedGroupRow(userId, groupId, tx, field);
  if (row.archivedAt && row.id !== keepGroupId) {
    throw new ServiceError("VALIDATION", `“${row.name}” is archived. Unarchive it first or choose another group.`, field);
  }
  return row;
}

/**
 * The id of the user's oldest unarchived group (lowest id): where a wallet goes when nobody chose a group. There is
 * always one (the last unarchived group cannot be archived); the oldest group of all is the fallback.
 */
export async function getDefaultGroupId(userId: number, tx?: DBOrTx): Promise<number> {
  const db = tx ?? (await getDb());
  const [row] = await db
    .select({ id: walletGroups.id })
    .from(walletGroups)
    .where(eq(walletGroups.userId, userId))
    .orderBy(sql`${walletGroups.archivedAt} is not null`, asc(walletGroups.id))
    .limit(1);
  if (!row) throw new ServiceError("NOT_FOUND", "Group not found.", "groupId");
  return row.id;
}

/** Create `Personal` when the user has no group at all. Idempotent; pass the transaction handle in registration. */
export async function seedDefaultGroup(userId: number, tx?: DBOrTx): Promise<void> {
  const db = tx ?? (await getDb());
  const [has] = await db.select({ id: walletGroups.id }).from(walletGroups).where(eq(walletGroups.userId, userId)).limit(1);
  if (!has) await db.insert(walletGroups).values({ userId, name: DEFAULT_GROUP_NAME, position: 1 });
}

/**
 * Internal: lock the user's group rows for the rest of the transaction (so two concurrent changes to the order or the
 * archive state cannot both pass their checks) and return them by position, then id.
 */
async function lockGroups(tx: DBOrTx, userId: number): Promise<WalletGroup[]> {
  return tx
    .select()
    .from(walletGroups)
    .where(eq(walletGroups.userId, userId))
    .orderBy(asc(walletGroups.position), asc(walletGroups.id))
    .for("update");
}

/** Internal: the position after the user's last group (1 for the first). Pass the groups from `lockGroups`. */
export function nextPosition(groups: { position: number }[]): number {
  return groups.reduce((max, g) => Math.max(max, g.position), 0) + 1;
}

/** Internal: `nextPosition` read from the database (the importer creates groups with it). */
export async function nextGroupPosition(tx: DBOrTx, userId: number): Promise<number> {
  const [row] = await tx
    .select({ max: sql<number | null>`max(${walletGroups.position})`.mapWith(Number) })
    .from(walletGroups)
    .where(eq(walletGroups.userId, userId));
  return (row?.max ?? 0) + 1;
}

function duplicateError(name: string): ServiceError {
  return new ServiceError("CONFLICT", `You already have a group called “${name}”.`, "name");
}

function assertNameFree(groups: { id: number; name: string }[], name: string, exceptId?: number): void {
  const folded = name.toLowerCase();
  const clash = groups.find((g) => g.id !== exceptId && g.name.toLowerCase() === folded);
  if (clash) throw duplicateError(clash.name);
}

/**
 * Create a group, last in the order. Name rules as for categories: 1–40 characters, unique per user ignoring case.
 * `color`: one of `GROUP_COLORS`, or null / omitted for none.
 */
export async function createWalletGroup(
  userId: number,
  input: { name: string; color?: string | null },
): Promise<WalletGroupView> {
  const name = normalizeGroupName(input.name);
  const color = normalizeColor(input.color) ?? null;
  const db = await getDb();
  const id = await db.transaction(async (tx) => {
    const groups = await lockGroups(tx, userId);
    assertNameFree(groups, name);
    const [row] = await tx
      .insert(walletGroups)
      .values({ userId, name, color, position: nextPosition(groups) })
      .returning({ id: walletGroups.id });
    return row.id;
  });
  return (await getWalletGroup(userId, id))!;
}

/**
 * Rename an owned group and / or change its colour (`color` omitted → unchanged, null or "" → none). Changing only
 * the letter case of its own name is allowed.
 */
export async function renameWalletGroup(
  userId: number,
  groupId: number,
  input: { name: string; color?: string | null },
): Promise<WalletGroupView> {
  assertId(groupId, "groupId", "group");
  const name = normalizeGroupName(input.name);
  const color = normalizeColor(input.color);
  const db = await getDb();
  await db.transaction(async (tx) => {
    const groups = await lockGroups(tx, userId);
    const current = groups.find((g) => g.id === groupId);
    if (!current) throw new ServiceError("NOT_FOUND", "Group not found.", "groupId");
    if (current.name !== name) assertNameFree(groups, name, current.id);
    await tx
      .update(walletGroups)
      .set({ name, ...(color === undefined ? {} : { color }) })
      .where(and(eq(walletGroups.id, current.id), eq(walletGroups.userId, userId)));
  });
  return (await getWalletGroup(userId, groupId))!;
}

/**
 * Move an owned group one place up or down: it swaps positions with its neighbour among the groups of the same
 * archived state (active groups and archived groups are ordered on their own). At either end nothing changes.
 */
export async function moveWalletGroup(userId: number, groupId: number, direction: "up" | "down"): Promise<WalletGroupView> {
  assertId(groupId, "groupId", "group");
  if (direction !== "up" && direction !== "down") throw new ServiceError("VALIDATION", "Choose up or down.", "direction");
  const db = await getDb();
  await db.transaction(async (tx) => {
    const all = await lockGroups(tx, userId);
    const current = all.find((g) => g.id === groupId);
    if (!current) throw new ServiceError("NOT_FOUND", "Group not found.", "groupId");
    const peers = all.filter((g) => (g.archivedAt === null) === (current.archivedAt === null));
    const i = peers.indexOf(current);
    const other = peers[direction === "up" ? i - 1 : i + 1];
    if (!other) return;
    // Positions may tie (all 0 from an old row); renumber the user's groups 1..n first so a swap always moves.
    if (new Set(all.map((g) => g.position)).size !== all.length) {
      for (const [k, g] of all.entries()) {
        g.position = k + 1;
        await tx.update(walletGroups).set({ position: g.position }).where(eq(walletGroups.id, g.id));
      }
    }
    await tx.update(walletGroups).set({ position: other.position }).where(eq(walletGroups.id, current.id));
    await tx.update(walletGroups).set({ position: current.position }).where(eq(walletGroups.id, other.id));
  });
  return (await getWalletGroup(userId, groupId))!;
}

/**
 * Archive an owned group: it leaves the switcher and the group pickers, and its wallets count as archived wherever
 * archived wallets are hidden (their own archived flag is untouched). CONFLICT for the user's last unarchived group.
 * Archiving an archived group changes nothing.
 */
export async function archiveWalletGroup(userId: number, groupId: number): Promise<WalletGroupView> {
  assertId(groupId, "groupId", "group");
  const db = await getDb();
  await db.transaction(async (tx) => {
    const all = await lockGroups(tx, userId);
    const current = all.find((g) => g.id === groupId);
    if (!current) throw new ServiceError("NOT_FOUND", "Group not found.", "groupId");
    if (current.archivedAt) return;
    if (!all.some((g) => g.id !== current.id && g.archivedAt === null)) {
      throw new ServiceError(
        "CONFLICT",
        "You need at least one group that is not archived. Create or unarchive another group first.",
        "groupId",
      );
    }
    await tx
      .update(walletGroups)
      .set({ archivedAt: new Date() })
      .where(and(eq(walletGroups.id, current.id), eq(walletGroups.userId, userId)));
  });
  return (await getWalletGroup(userId, groupId))!;
}

/** Unarchive an owned group (no-op when it is not archived). */
export async function unarchiveWalletGroup(userId: number, groupId: number): Promise<WalletGroupView> {
  assertId(groupId, "groupId", "group");
  const group = await getOwnedGroupRow(userId, groupId);
  await (await getDb())
    .update(walletGroups)
    .set({ archivedAt: null })
    .where(and(eq(walletGroups.id, group.id), eq(walletGroups.userId, userId)));
  return (await getWalletGroup(userId, groupId))!;
}

/**
 * Delete an owned, empty group; CONFLICT while it has wallets, and for the user's last unarchived group (which also
 * covers the last group of all). An archived empty group can always be deleted.
 */
export async function deleteWalletGroup(userId: number, groupId: number): Promise<void> {
  const db = await getDb();
  await db.transaction(async (tx) => {
    await getOwnedGroupRow(userId, groupId, tx);
    const all = await lockGroups(tx, userId);
    const group = all.find((g) => g.id === groupId)!;
    const [used] = await tx.select({ id: wallets.id }).from(wallets).where(eq(wallets.groupId, group.id)).limit(1);
    if (used) {
      throw new ServiceError(
        "CONFLICT",
        `“${group.name}” still has wallets. Move or delete them first.`,
        "groupId",
      );
    }
    if (group.archivedAt === null && !all.some((g) => g.id !== group.id && g.archivedAt === null)) {
      throw new ServiceError(
        "CONFLICT",
        all.length > 1
          ? "You need at least one group that is not archived. Unarchive or create another group first."
          : "You need at least one group. Create another one first.",
        "groupId",
      );
    }
    await tx.delete(walletGroups).where(and(eq(walletGroups.id, group.id), eq(walletGroups.userId, userId)));
  });
}

/** SQL condition on `wallets.group_id` for queries that do not join `wallet_groups`: the group is not archived. */
export const walletInOpenGroupSql = sql`${wallets.groupId} in (select id from wallet_groups where archived_at is null)`;
