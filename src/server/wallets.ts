import "server-only";
import { and, asc, eq, sql, type SQL } from "drizzle-orm";
import { getDb, type DBOrTx } from "@/db";
import { transactions, walletGroups, wallets, type Wallet } from "@/db/schema";
import { isValidCurrency } from "@/lib/currencies";
import { ServiceError } from "@/lib/errors";
import { assertId, normalizeName } from "./_validate";
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

function selectWalletViews(userId: number, extra?: SQL) {
  return getDb()
    .select({
      id: wallets.id,
      groupId: wallets.groupId,
      groupName: walletGroups.name,
      name: wallets.name,
      currency: wallets.currency,
      initialBalanceMinor: wallets.initialBalanceMinor,
      balanceMinor: sql<number>`${wallets.initialBalanceMinor} + coalesce(sum(${signedAmountSql}), 0)`,
      transactionCount: sql<number>`count(${transactions.id})`,
      archivedAt: wallets.archivedAt,
      createdAt: wallets.createdAt,
    })
    .from(wallets)
    .innerJoin(walletGroups, eq(walletGroups.id, wallets.groupId))
    .leftJoin(transactions, eq(transactions.walletId, wallets.id))
    .where(extra ? and(eq(wallets.userId, userId), extra) : eq(wallets.userId, userId))
    .groupBy(wallets.id);
}

/** The user's wallets with balances: active first, then archived, each by name. Archived excluded unless asked. */
export function listWallets(
  userId: number,
  opts: { includeArchived?: boolean; groupId?: number } = {},
): WalletView[] {
  const conds: SQL[] = [];
  if (!opts.includeArchived) conds.push(sql`${wallets.archivedAt} is null`);
  if (opts.groupId !== undefined) conds.push(eq(wallets.groupId, opts.groupId));
  const q = selectWalletViews(userId, conds.length ? and(...conds) : undefined);
  return q
    .orderBy(sql`${wallets.archivedAt} is not null`, sql`${wallets.name} collate nocase`, asc(wallets.id))
    .all();
}

/** One owned wallet (archived or not) with its balance, or null. */
export function getWallet(userId: number, walletId: number): WalletView | null {
  return selectWalletViews(userId, eq(wallets.id, walletId)).get() ?? null;
}

/** Internal: the owned wallet row or NOT_FOUND. */
export function getOwnedWalletRow(userId: number, walletId: number, tx: DBOrTx = getDb(), field = "walletId"): Wallet {
  const row = tx
    .select()
    .from(wallets)
    .where(and(eq(wallets.id, walletId), eq(wallets.userId, userId)))
    .get();
  if (!row) throw new ServiceError("NOT_FOUND", "Wallet not found.", field);
  return row;
}

function assertInitialBalance(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new ServiceError("VALIDATION", "Enter a valid initial balance.", "initialBalance");
  }
  return value;
}

export function createWallet(
  userId: number,
  input: { name: string; currency: string; initialBalanceMinor: number; groupId?: number },
): WalletView {
  const name = normalizeName(input.name);
  const currency = typeof input.currency === "string" ? input.currency.trim().toUpperCase() : "";
  if (!isValidCurrency(currency)) throw new ServiceError("VALIDATION", "Choose a valid currency.", "currency");
  const initialBalanceMinor = assertInitialBalance(input.initialBalanceMinor ?? 0);

  const row = getDb().transaction((tx) => {
    const groupId =
      input.groupId === undefined
        ? getDefaultGroupId(userId, tx)
        : getOwnedGroupRow(userId, assertId(input.groupId, "groupId", "group"), tx).id;
    return tx
      .insert(wallets)
      .values({ userId, groupId, name, currency, initialBalanceMinor })
      .returning({ id: wallets.id })
      .get();
  });
  return getWallet(userId, row.id)!;
}

/** Update name, initial balance and (when given) group. The currency is immutable. */
export function updateWallet(
  userId: number,
  walletId: number,
  input: { name: string; initialBalanceMinor: number; groupId?: number },
): WalletView {
  assertId(walletId, "walletId", "wallet");
  getOwnedWalletRow(userId, walletId);
  const name = normalizeName(input.name);
  const initialBalanceMinor = assertInitialBalance(input.initialBalanceMinor);
  getDb().transaction((tx) => {
    const groupId =
      input.groupId === undefined ? undefined : getOwnedGroupRow(userId, assertId(input.groupId, "groupId", "group"), tx).id;
    tx.update(wallets)
      .set({ name, initialBalanceMinor, ...(groupId === undefined ? {} : { groupId }) })
      .where(and(eq(wallets.id, walletId), eq(wallets.userId, userId)))
      .run();
  });
  return getWallet(userId, walletId)!;
}

/** Hide from pickers and dashboard totals; history stays visible. Idempotent. */
export function archiveWallet(userId: number, walletId: number): WalletView {
  const row = getOwnedWalletRow(userId, walletId);
  if (!row.archivedAt) {
    getDb()
      .update(wallets)
      .set({ archivedAt: new Date() })
      .where(and(eq(wallets.id, walletId), eq(wallets.userId, userId)))
      .run();
  }
  return getWallet(userId, walletId)!;
}

export function unarchiveWallet(userId: number, walletId: number): WalletView {
  getOwnedWalletRow(userId, walletId);
  getDb()
    .update(wallets)
    .set({ archivedAt: null })
    .where(and(eq(wallets.id, walletId), eq(wallets.userId, userId)))
    .run();
  return getWallet(userId, walletId)!;
}

/** Delete a wallet that has no transactions; CONFLICT otherwise (archive it instead). */
export function deleteWallet(userId: number, walletId: number): void {
  const db = getDb();
  db.transaction((tx) => {
    getOwnedWalletRow(userId, walletId, tx);
    const used = tx
      .select({ id: transactions.id })
      .from(transactions)
      .where(eq(transactions.walletId, walletId))
      .limit(1)
      .get();
    if (used) {
      throw new ServiceError("CONFLICT", "This wallet has transactions. Archive it instead of deleting it.");
    }
    tx.delete(wallets).where(and(eq(wallets.id, walletId), eq(wallets.userId, userId))).run();
  });
}
