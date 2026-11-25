import "server-only";
import { and, asc, eq, getTableColumns, sql, type SQL } from "drizzle-orm";
import { getDb, type DBOrTx } from "@/db";
import { transactions, walletGroups, wallets, type Wallet } from "@/db/schema";
import { isValidCurrency } from "@/lib/currencies";
import { ServiceError } from "@/lib/errors";
import { assertDate, assertId, isPgId, normalizeName } from "./_validate";
import { getDefaultGroupId, getOpenGroupRow } from "./wallet-groups";

export type WalletView = {
  id: number;
  groupId: number;
  groupName: string;
  /** The group's position (wallets are listed by group in this order where they are grouped). */
  groupPosition: number;
  /** The group is archived: the wallet is then hidden wherever archived wallets are (its own `archivedAt` is kept). */
  groupArchived: boolean;
  name: string;
  currency: string;
  initialBalanceMinor: number;
  /** Every entry on the wallet, future-dated ones included (a wallet with entries cannot be deleted). */
  transactionCount: number;
  archivedAt: Date | null;
  createdAt: Date;
};

/**
 * A wallet with its balance, from `listWallets` / `getWallet` given `balanceOn` (the caller's today, `todayInZone`,
 * wherever the balance is shown as the current one). There is no balance without that day, so a page cannot show
 * one that counts the future-dated entries by mistake.
 */
export type WalletWithBalance = WalletView & {
  /** The day the balance is at the end of (`YYYY-MM-DD`). */
  balanceOn: string;
  /** Initial balance + every entry dated on or before `balanceOn` (transfers included). */
  balanceMinor: number;
  /**
   * The net of the entries dated after `balanceOn` (0 when there are none): `balanceMinor + laterChangeMinor` is the
   * "projected" balance the wallet page and /wallets mention. Not a balance; never sum it into one.
   */
  laterChangeMinor: number;
};

/** SQL expression: signed effect of a transaction row on its wallet balance. */
export const signedAmountSql = sql<number>`case
  when ${transactions.kind} in ('income', 'transfer_in') then ${transactions.amountMinor}
  else -${transactions.amountMinor} end`;

const walletViewColumns = {
  id: wallets.id,
  groupId: wallets.groupId,
  groupName: walletGroups.name,
  groupPosition: walletGroups.position,
  groupArchived: sql<boolean>`${walletGroups.archivedAt} is not null`.mapWith(Boolean),
  name: wallets.name,
  currency: wallets.currency,
  initialBalanceMinor: wallets.initialBalanceMinor,
  transactionCount: sql<number>`count(${transactions.id})`.mapWith(Number),
  archivedAt: wallets.archivedAt,
  createdAt: wallets.createdAt,
};

/** The balance columns of a `WalletWithBalance` at the end of `day` (already validated). */
const balanceColumns = (day: string) => ({
  balanceOn: sql<string>`${day}::text`,
  balanceMinor: sql<number>`${wallets.initialBalanceMinor} + coalesce(sum(${signedAmountSql}) filter (where ${transactions.date} <= ${day}), 0)`.mapWith(Number),
  laterChangeMinor: sql<number>`coalesce(sum(${signedAmountSql}) filter (where ${transactions.date} > ${day}), 0)`.mapWith(Number),
});

function selectWalletViews(db: DBOrTx, userId: number, extra: SQL | undefined, balanceOn: string | undefined) {
  const columns = balanceOn === undefined ? walletViewColumns : { ...walletViewColumns, ...balanceColumns(balanceOn) };
  return db
    .select(columns)
    .from(wallets)
    .innerJoin(walletGroups, eq(walletGroups.id, wallets.groupId))
    .leftJoin(transactions, eq(transactions.walletId, wallets.id))
    .where(extra ? and(eq(wallets.userId, userId), extra) : eq(wallets.userId, userId))
    .groupBy(wallets.id, walletGroups.id);
}

type ListWalletsOptions = { includeArchived?: boolean; groupId?: number };

/**
 * The user's wallets: active first, then archived, each by name. Archived excluded unless asked — and so are the
 * wallets of an archived group (they count as archived wherever archived wallets are hidden). With `balanceOn`
 * (`YYYY-MM-DD`, the user's today for a current balance) each comes with its balance at the end of that day.
 */
export async function listWallets(
  userId: number,
  opts: ListWalletsOptions & { balanceOn: string },
): Promise<WalletWithBalance[]>;
export async function listWallets(
  userId: number,
  opts?: ListWalletsOptions & { balanceOn?: undefined },
): Promise<WalletView[]>;
export async function listWallets(
  userId: number,
  opts: ListWalletsOptions & { balanceOn?: string } = {},
): Promise<WalletView[] | WalletWithBalance[]> {
  const balanceOn = opts.balanceOn === undefined ? undefined : assertDate(opts.balanceOn, "balanceOn");
  const db = await getDb();
  const conds: SQL[] = [];
  if (!opts.includeArchived) conds.push(sql`${wallets.archivedAt} is null and ${walletGroups.archivedAt} is null`);
  if (opts.groupId !== undefined) conds.push(eq(wallets.groupId, opts.groupId));
  const q = selectWalletViews(db, userId, conds.length ? and(...conds) : undefined, balanceOn);
  return q.orderBy(sql`${wallets.archivedAt} is not null`, sql`lower(${wallets.name})`, asc(wallets.id));
}

/** One owned wallet (archived or not), or null; with `balanceOn`, with its balance at the end of that day. */
export async function getWallet(userId: number, walletId: number, opts: { balanceOn: string }): Promise<WalletWithBalance | null>;
export async function getWallet(userId: number, walletId: number, opts?: { balanceOn?: undefined }): Promise<WalletView | null>;
export async function getWallet(
  userId: number,
  walletId: number,
  opts: { balanceOn?: string } = {},
): Promise<WalletView | WalletWithBalance | null> {
  const balanceOn = opts.balanceOn === undefined ? undefined : assertDate(opts.balanceOn, "balanceOn");
  if (!isPgId(walletId)) return null;
  const [row] = await selectWalletViews(await getDb(), userId, eq(wallets.id, walletId), balanceOn);
  return row ?? null;
}

/**
 * Internal: the owned wallet row or NOT_FOUND, with `groupName` and `groupArchived` (its group is archived: the
 * entry services then refuse new entries on it, as on an archived wallet).
 */
export async function getOwnedWalletRow(
  userId: number,
  walletId: number,
  tx?: DBOrTx,
  field = "walletId",
): Promise<Wallet & { groupName: string; groupArchived: boolean }> {
  const db = tx ?? (await getDb());
  const [row] = !isPgId(walletId)
    ? []
    : await db
        .select({
          ...getTableColumns(wallets),
          groupName: walletGroups.name,
          groupArchived: sql<boolean>`${walletGroups.archivedAt} is not null`.mapWith(Boolean),
        })
        .from(wallets)
        .innerJoin(walletGroups, eq(walletGroups.id, wallets.groupId))
        .where(and(eq(wallets.id, walletId), eq(wallets.userId, userId)));
  if (!row) throw new ServiceError("NOT_FOUND", "Wallet not found.", field);
  return row;
}

/**
 * Internal, for the entry services: why `wallet` takes no new entries (it is archived, or its group is), else null.
 * `subject` starts the message ("This wallet", "The source wallet").
 */
export function closedWalletMessage(
  wallet: { archivedAt: Date | null; groupArchived: boolean; groupName: string },
  subject: string,
): string | null {
  if (wallet.archivedAt) return `${subject} is archived.`;
  if (wallet.groupArchived) return `${subject} is in the archived group “${wallet.groupName}”. Unarchive the group first.`;
  return null;
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
        : (await getOpenGroupRow(userId, assertId(input.groupId, "groupId", "group"), tx)).id;
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
  const current = await getOwnedWalletRow(userId, walletId);
  const name = normalizeName(input.name);
  const initialBalanceMinor = assertInitialBalance(input.initialBalanceMinor);
  const db = await getDb();
  await db.transaction(async (tx) => {
    // Moving into an archived group is refused; staying in one (the wallet is already there) is not.
    const groupId =
      input.groupId === undefined
        ? undefined
        : (await getOpenGroupRow(userId, assertId(input.groupId, "groupId", "group"), tx, current.groupId)).id;
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
