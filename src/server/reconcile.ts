import "server-only";
import { and, asc, eq, lte, sql } from "drizzle-orm";
import { getDb, type DBOrTx } from "@/db";
import { categories, transactions, walletGroups, wallets, type CategoryKind } from "@/db/schema";
import { ServiceError } from "@/lib/errors";
import { assertDate, isPgId } from "./_validate";
import { getTransaction, type TransactionView } from "./transactions";
import { closedWalletMessage, signedAmountSql } from "./wallets";

/** The name of the category a reconciliation files its entry under, and the entry's note. */
export const BALANCE_ADJUSTMENT = "Balance adjustment";

export type ReconcileResult = {
  /** The wallet's balance at the end of `date` before the adjustment. */
  trackedBalanceMinor: number;
  actualBalanceMinor: number;
  /** actual − tracked: positive → an income entry, negative → an expense, 0 → nothing recorded. */
  differenceMinor: number;
  /** The entry recorded, or null when the balance already matched. */
  transaction: TransactionView | null;
  /** True when the "Balance adjustment" category of that kind was created for this entry. */
  categoryCreated: boolean;
};

const ownEntries = (userId: number, walletId: number, through: string) =>
  and(eq(transactions.walletId, walletId), eq(transactions.userId, userId), lte(transactions.date, through));

/**
 * A wallet's balance at the end of `date`: the initial balance plus every entry dated on or before it (transfers
 * included). Later-dated entries are left out, as on the wallet page, where they are "projected". Null when the
 * wallet is not the user's.
 */
export async function getWalletBalanceOn(
  userId: number,
  walletId: number,
  date: string,
  db?: DBOrTx,
): Promise<number | null> {
  const day = assertDate(date);
  if (!isPgId(walletId)) return null;
  const [row] = await (db ?? (await getDb()))
    .select({
      balanceMinor: sql<number>`${wallets.initialBalanceMinor} + coalesce(sum(${signedAmountSql}), 0)`.mapWith(Number),
    })
    .from(wallets)
    .leftJoin(transactions, ownEntries(userId, walletId, day))
    .where(and(eq(wallets.id, walletId), eq(wallets.userId, userId)))
    .groupBy(wallets.id);
  return row?.balanceMinor ?? null;
}

/**
 * For the reconcile form's live preview: the wallet's initial balance and, for every date up to `through` that has
 * entries, the balance at the end of it (`[date, closingMinor]`, ascending). The balance at the end of any day is the
 * closing of the last listed date on or before it, or the initial balance. Null when the wallet is not the user's.
 */
export async function listWalletClosingBalances(
  userId: number,
  walletId: number,
  through: string,
): Promise<{ initialBalanceMinor: number; closings: [string, number][] } | null> {
  const day = assertDate(through, "through");
  if (!isPgId(walletId)) return null;
  const db = await getDb();
  const [wallet] = await db
    .select({ initialBalanceMinor: wallets.initialBalanceMinor })
    .from(wallets)
    .where(and(eq(wallets.id, walletId), eq(wallets.userId, userId)));
  if (!wallet) return null;
  const perDay = await db
    .select({ date: transactions.date, net: sql<number>`sum(${signedAmountSql})`.mapWith(Number) })
    .from(transactions)
    .where(ownEntries(userId, walletId, day))
    .groupBy(transactions.date)
    .orderBy(asc(transactions.date));
  let balance = wallet.initialBalanceMinor;
  const closings = perDay.map((r): [string, number] => {
    balance += r.net;
    return [r.date, balance];
  });
  return { initialBalanceMinor: wallet.initialBalanceMinor, closings };
}

/**
 * The user's "Balance adjustment" category of `kind` (name compared ignoring case, like every category name), created
 * when there is none. An archived one is used as it is and stays archived: reconciling never fails on it and never
 * changes the user's category settings. Read FOR SHARE, as `createTransaction` does, so a concurrent kind change
 * waits for the entry.
 */
async function adjustmentCategory(tx: DBOrTx, userId: number, kind: CategoryKind): Promise<{ id: number; created: boolean }> {
  const find = async () => {
    const rows = await tx
      .select({ id: categories.id, name: categories.name, archivedAt: categories.archivedAt })
      .from(categories)
      .where(and(eq(categories.userId, userId), eq(categories.kind, kind)))
      .orderBy(asc(categories.id))
      .for("share");
    const folded = BALANCE_ADJUSTMENT.toLowerCase();
    const matches = rows.filter((c) => c.name.toLowerCase() === folded);
    // Names are unique per kind ignoring case, so there is at most one; prefer an active one all the same.
    return matches.find((c) => !c.archivedAt) ?? matches[0];
  };
  const existing = await find();
  if (existing) return { id: existing.id, created: false };
  // A concurrent reconcile of another wallet may insert the same row: do nothing then, and read the one it made.
  const [inserted] = await tx
    .insert(categories)
    .values({ userId, kind, name: BALANCE_ADJUSTMENT })
    .onConflictDoNothing()
    .returning({ id: categories.id });
  if (inserted) return { id: inserted.id, created: true };
  const after = await find();
  if (!after) throw new Error("Balance adjustment category vanished");
  return { id: after.id, created: false };
}

/**
 * Bring a wallet's tracked balance in line with its real one. `actualBalanceMinor` (any sign) is what the wallet
 * really held at the end of `date` (`YYYY-MM-DD`, not after `today`, the user's today from the caller); the difference
 * from the tracked balance at the end of that day (`getWalletBalanceOn`) is recorded as one ordinary entry dated that
 * day: income when positive, expense when negative, in the "Balance adjustment" category of that kind (created when
 * missing), note "Balance adjustment". A zero difference records nothing. Refused like any new entry for an archived
 * wallet or one in an archived group (VALIDATION); another user's wallet is NOT_FOUND. The wallet row is locked for
 * the read and the write, so two submissions cannot both add the difference.
 */
export async function reconcileWallet(
  userId: number,
  walletId: number,
  input: { actualBalanceMinor: number; date: string },
  opts: { today: string },
): Promise<ReconcileResult> {
  if (!isPgId(walletId)) throw new ServiceError("NOT_FOUND", "Wallet not found.");
  const actualBalanceMinor = input.actualBalanceMinor;
  if (typeof actualBalanceMinor !== "number" || !Number.isSafeInteger(actualBalanceMinor)) {
    throw new ServiceError("VALIDATION", "Enter the wallet's actual balance.", "actualBalance");
  }
  const date = assertDate(input.date);
  const today = assertDate(opts.today, "today");
  if (date > today) throw new ServiceError("VALIDATION", "Choose today or an earlier date.", "date");

  const db = await getDb();
  const outcome = await db.transaction(async (tx) => {
    const [wallet] = await tx
      .select({
        archivedAt: wallets.archivedAt,
        groupName: walletGroups.name,
        groupArchived: sql<boolean>`${walletGroups.archivedAt} is not null`.mapWith(Boolean),
      })
      .from(wallets)
      .innerJoin(walletGroups, eq(walletGroups.id, wallets.groupId))
      .where(and(eq(wallets.id, walletId), eq(wallets.userId, userId)))
      .for("update", { of: wallets });
    if (!wallet) throw new ServiceError("NOT_FOUND", "Wallet not found.");
    const closed = closedWalletMessage(wallet, "This wallet");
    if (closed) throw new ServiceError("VALIDATION", closed);

    const trackedBalanceMinor = (await getWalletBalanceOn(userId, walletId, date, tx))!;
    const differenceMinor = actualBalanceMinor - trackedBalanceMinor;
    if (!Number.isSafeInteger(differenceMinor)) {
      throw new ServiceError("VALIDATION", "That balance is too far from the tracked one.", "actualBalance");
    }
    if (differenceMinor === 0) {
      return { trackedBalanceMinor, differenceMinor, transactionId: null, categoryCreated: false };
    }
    const kind: CategoryKind = differenceMinor > 0 ? "income" : "expense";
    const category = await adjustmentCategory(tx, userId, kind);
    const [row] = await tx
      .insert(transactions)
      .values({
        userId,
        walletId,
        kind,
        categoryId: category.id,
        amountMinor: Math.abs(differenceMinor),
        date,
        note: BALANCE_ADJUSTMENT,
        transferId: null,
      })
      .returning({ id: transactions.id });
    return { trackedBalanceMinor, differenceMinor, transactionId: row.id, categoryCreated: category.created };
  });

  return {
    trackedBalanceMinor: outcome.trackedBalanceMinor,
    actualBalanceMinor,
    differenceMinor: outcome.differenceMinor,
    transaction: outcome.transactionId === null ? null : await getTransaction(userId, outcome.transactionId),
    categoryCreated: outcome.categoryCreated,
  };
}
