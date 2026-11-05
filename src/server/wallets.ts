import "server-only";
import { and, asc, eq, sql, type SQL } from "drizzle-orm";
import { getDb, type DBOrTx } from "@/db";
import { transactions, wallets, type Wallet } from "@/db/schema";
import { isValidCurrency } from "@/lib/currencies";
import { ServiceError } from "@/lib/errors";
import { assertId, normalizeName } from "./_validate";

export type WalletView = {
  id: number;
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
      name: wallets.name,
      currency: wallets.currency,
      initialBalanceMinor: wallets.initialBalanceMinor,
      balanceMinor: sql<number>`${wallets.initialBalanceMinor} + coalesce(sum(${signedAmountSql}), 0)`,
      transactionCount: sql<number>`count(${transactions.id})`,
      archivedAt: wallets.archivedAt,
      createdAt: wallets.createdAt,
    })
    .from(wallets)
    .leftJoin(transactions, eq(transactions.walletId, wallets.id))
    .where(extra ? and(eq(wallets.userId, userId), extra) : eq(wallets.userId, userId))
    .groupBy(wallets.id);
}

/** The user's wallets with balances: active first, then archived, each by name. Archived excluded unless asked. */
export function listWallets(userId: number, opts: { includeArchived?: boolean } = {}): WalletView[] {
  const q = selectWalletViews(userId, opts.includeArchived ? undefined : sql`${wallets.archivedAt} is null`);
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
  input: { name: string; currency: string; initialBalanceMinor: number },
): WalletView {
  const name = normalizeName(input.name);
  const currency = typeof input.currency === "string" ? input.currency.trim().toUpperCase() : "";
  if (!isValidCurrency(currency)) throw new ServiceError("VALIDATION", "Choose a valid currency.", "currency");
  const initialBalanceMinor = assertInitialBalance(input.initialBalanceMinor ?? 0);

  const row = getDb()
    .insert(wallets)
    .values({ userId, name, currency, initialBalanceMinor })
    .returning({ id: wallets.id })
    .get();
  return getWallet(userId, row.id)!;
}

/** Update name and initial balance. The currency is immutable. */
export function updateWallet(
  userId: number,
  walletId: number,
  input: { name: string; initialBalanceMinor: number },
): WalletView {
  assertId(walletId, "walletId", "wallet");
  getOwnedWalletRow(userId, walletId);
  const name = normalizeName(input.name);
  const initialBalanceMinor = assertInitialBalance(input.initialBalanceMinor);
  getDb()
    .update(wallets)
    .set({ name, initialBalanceMinor })
    .where(and(eq(wallets.id, walletId), eq(wallets.userId, userId)))
    .run();
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
