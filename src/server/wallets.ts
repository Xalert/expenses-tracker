import "server-only";
import { and, asc, eq, sql, type SQL } from "drizzle-orm";
import { getDb, type DBOrTx } from "@/db";
import { transactions, walletGroups, wallets, type Wallet } from "@/db/schema";
import { isValidCurrency } from "@/lib/currencies";
import { ServiceError } from "@/lib/errors";
import { assertId, isPgId, normalizeName } from "./_validate";
import { getDefaultGroupId, getOwnedGroupRow } from "./wallet-groups";

export type WalletView = {
  id: number;
  groupId: number;
  groupName: string;
  name: string;
  currency: string;
  initialBalanceMinor: number;
  balanceMinor: number;
  transactionCount: number;
  archivedAt: Date | null;
  createdAt: Date;
};

/** SQL expression: signed effect of a transaction row on its wallet balance. */
export const signedAmountSql = sql<number>`case
  when ${transactions.kind} in ('income', 'transfer_in') then ${transactions.amountMinor}
  else -${transactions.amountMinor} end`;

function selectWalletViews(db: DBOrTx, userId: number, extra?: SQL) {
  return db
    .select({
      id: wallets.id,
      groupId: wallets.groupId,
      groupName: walletGroups.name,
      name: wallets.name,
      currency: wallets.currency,
      initialBalanceMinor: wallets.initialBalanceMinor,
      balanceMinor: sql<number>`${wallets.initialBalanceMinor} + coalesce(sum(${signedAmountSql}), 0)`.mapWith(Number),
      transactionCount: sql<number>`count(${transactions.id})`.mapWith(Number),
      archivedAt: wallets.archivedAt,
      createdAt: wallets.createdAt,
    })
    .from(wallets)
    .innerJoin(walletGroups, eq(walletGroups.id, wallets.groupId))
    .leftJoin(transactions, eq(transactions.walletId, wallets.id))
    .where(extra ? and(eq(wallets.userId, userId), extra) : eq(wallets.userId, userId))
    .groupBy(wallets.id, walletGroups.name);
}

/** The user's wallets with balances: active first, then archived, each by name. Archived excluded unless asked. */
export async function listWallets(
  userId: number,
  opts: { includeArchived?: boolean; groupId?: number } = {},
): Promise<WalletView[]> {
  const db = await getDb();
  const conds: SQL[] = [];
  if (!opts.includeArchived) conds.push(sql`${wallets.archivedAt} is null`);
  if (opts.groupId !== undefined) conds.push(eq(wallets.groupId, opts.groupId));
  const q = selectWalletViews(db, userId, conds.length ? and(...conds) : undefined);
  return q.orderBy(sql`${wallets.archivedAt} is not null`, sql`lower(${wallets.name})`, asc(wallets.id));
}

/** One owned wallet (archived or not) with its balance, or null. */
export async function getWallet(userId: number, walletId: number, db?: DBOrTx): Promise<WalletView | null> {
  if (!isPgId(walletId)) return null;
  const [row] = await selectWalletViews(db ?? (await getDb()), userId, eq(wallets.id, walletId));
  return row ?? null;
}

/** Internal: the owned wallet row or NOT_FOUND. */
export async function getOwnedWalletRow(userId: number, walletId: number, tx?: DBOrTx, field = "walletId"): Promise<Wallet> {
  const db = tx ?? (await getDb());
  const [row] = !isPgId(walletId)
    ? []
    : await db
    .select()
    .from(wallets)
    .where(and(eq(wallets.id, walletId), eq(wallets.userId, userId)));
  if (!row) throw new ServiceError("NOT_FOUND", "Wallet not found.", field);
  return row;
}

function assertInitialBalance(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new ServiceError("VALIDATION", "Enter a valid initial balance.", "initialBalance");
  }
  return value;
}

export async function createWallet(
  userId: number,
  input: { name: string; currency: string; initialBalanceMinor: number; groupId?: number },
): Promise<WalletView> {
  const name = normalizeName(input.name);
  const currency = typeof input.currency === "string" ? input.currency.trim().toUpperCase() : "";
  if (!isValidCurrency(currency)) throw new ServiceError("VALIDATION", "Choose a valid currency.", "currency");
  const initialBalanceMinor = assertInitialBalance(input.initialBalanceMinor ?? 0);

  const db = await getDb();
  const row = await db.transaction(async (tx) => {
    const groupId =
      input.groupId === undefined
        ? await getDefaultGroupId(userId, tx)
        : (await getOwnedGroupRow(userId, assertId(input.groupId, "groupId", "group"), tx)).id;
    const [created] = await tx
      .insert(wallets)
      .values({ userId, groupId, name, currency, initialBalanceMinor })
      .returning({ id: wallets.id });
    return created;
  });
  return (await getWallet(userId, row.id))!;
}

/** Update name, initial balance and (when given) group. The currency is immutable. */
export async function updateWallet(
  userId: number,
  walletId: number,
  input: { name: string; initialBalanceMinor: number; groupId?: number },
): Promise<WalletView> {
  assertId(walletId, "walletId", "wallet");
  await getOwnedWalletRow(userId, walletId);
  const name = normalizeName(input.name);
  const initialBalanceMinor = assertInitialBalance(input.initialBalanceMinor);
  const db = await getDb();
  await db.transaction(async (tx) => {
    const groupId =
      input.groupId === undefined
        ? undefined
        : (await getOwnedGroupRow(userId, assertId(input.groupId, "groupId", "group"), tx)).id;
    await tx
      .update(wallets)
      .set({ name, initialBalanceMinor, ...(groupId === undefined ? {} : { groupId }) })
      .where(and(eq(wallets.id, walletId), eq(wallets.userId, userId)));
  });
  return (await getWallet(userId, walletId))!;
}

/** Hide from pickers and dashboard totals; history stays visible. Idempotent. */
export async function archiveWallet(userId: number, walletId: number): Promise<WalletView> {
  const row = await getOwnedWalletRow(userId, walletId);
  if (!row.archivedAt) {
    await (await getDb())
      .update(wallets)
      .set({ archivedAt: new Date() })
      .where(and(eq(wallets.id, walletId), eq(wallets.userId, userId)));
  }
  return (await getWallet(userId, walletId))!;
}

export async function unarchiveWallet(userId: number, walletId: number): Promise<WalletView> {
  await getOwnedWalletRow(userId, walletId);
  await (await getDb())
    .update(wallets)
    .set({ archivedAt: null })
    .where(and(eq(wallets.id, walletId), eq(wallets.userId, userId)));
  return (await getWallet(userId, walletId))!;
}

/** Delete a wallet that has no transactions; CONFLICT otherwise (archive it instead). */
export async function deleteWallet(userId: number, walletId: number): Promise<void> {
  const db = await getDb();
  await db.transaction(async (tx) => {
    await getOwnedWalletRow(userId, walletId, tx);
    const [used] = await tx
      .select({ id: transactions.id })
      .from(transactions)
      .where(eq(transactions.walletId, walletId))
      .limit(1);
    if (used) {
      throw new ServiceError("CONFLICT", "This wallet has transactions. Archive it instead of deleting it.");
    }
    await tx.delete(wallets).where(and(eq(wallets.id, walletId), eq(wallets.userId, userId)));
  });
}
