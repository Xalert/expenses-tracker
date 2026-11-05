import "server-only";
import { and, asc, eq, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { getDb, type DBOrTx } from "@/db";
import { categories, transactions, transfers, wallets } from "@/db/schema";
import { BACKUP_APP, BACKUP_VERSION, type Backup } from "@/lib/backup-format";
import { escapeFormula, toCsv } from "@/lib/csv";
import { minorToInputValue } from "@/lib/money";
import { filterConditions, type TransactionFilters } from "./transactions";

/** Column order of the transactions CSV (export writes exactly these; import requires the first five). */
export const CSV_COLUMNS = [
  "date",
  "type",
  "wallet",
  "currency",
  "amount",
  "category",
  "note",
  "to_wallet",
  "to_currency",
  "to_amount",
] as const;

const outLeg = alias(transactions, "out_leg");
const inLeg = alias(transactions, "in_leg");

export type TransferRow = {
  id: number;
  date: string;
  note: string | null;
  fromWalletId: number;
  amountMinor: number;
  toWalletId: number;
  receivedAmountMinor: number;
};

/** Internal: every transfer of the user with both legs, oldest first (date, id). One query. */
export function listTransferRows(userId: number, tx: DBOrTx = getDb()): TransferRow[] {
  return tx
    .select({
      id: transfers.id,
      date: transfers.date,
      note: transfers.note,
      fromWalletId: outLeg.walletId,
      amountMinor: outLeg.amountMinor,
      toWalletId: inLeg.walletId,
      receivedAmountMinor: inLeg.amountMinor,
    })
    .from(transfers)
    .innerJoin(outLeg, and(eq(outLeg.transferId, transfers.id), eq(outLeg.kind, "transfer_out")))
    .innerJoin(inLeg, and(eq(inLeg.transferId, transfers.id), eq(inLeg.kind, "transfer_in")))
    .where(eq(transfers.userId, userId))
    .orderBy(asc(transfers.date), asc(transfers.id))
    .all();
}

/**
 * The whole account as a versioned backup. Ids in the file are local (1..n per list, in export order); the
 * user's email, password hash and sessions are never included.
 */
export function buildBackup(userId: number, now: Date = new Date()): Backup {
  const db = getDb();
  return db.transaction((tx) => {
    const walletRows = tx.select().from(wallets).where(eq(wallets.userId, userId)).orderBy(asc(wallets.id)).all();
    const categoryRows = tx
      .select()
      .from(categories)
      .where(eq(categories.userId, userId))
      .orderBy(asc(categories.id))
      .all();
    const txRows = tx
      .select()
      .from(transactions)
      .where(and(eq(transactions.userId, userId), isNull(transactions.transferId)))
      .orderBy(asc(transactions.date), asc(transactions.id))
      .all();
    const transferRows = listTransferRows(userId, tx);

    const walletRef = new Map(walletRows.map((w, i) => [w.id, i + 1]));
    const currencyOf = new Map(walletRows.map((w) => [w.id, w.currency]));
    const categoryRef = new Map(categoryRows.map((c, i) => [c.id, i + 1]));

    return {
      app: BACKUP_APP,
      version: BACKUP_VERSION,
      exportedAt: now.toISOString(),
      wallets: walletRows.map((w) => ({
        id: walletRef.get(w.id)!,
        name: w.name,
        currency: w.currency,
        initialBalanceMinor: w.initialBalanceMinor,
        initialBalance: minorToInputValue(w.initialBalanceMinor, w.currency),
        archived: w.archivedAt !== null,
      })),
      categories: categoryRows.map((c) => ({ id: categoryRef.get(c.id)!, name: c.name, kind: c.kind })),
      transactions: txRows.map((t) => ({
        date: t.date,
        kind: t.kind as "expense" | "income",
        walletId: walletRef.get(t.walletId)!,
        categoryId: categoryRef.get(t.categoryId!)!,
        amountMinor: t.amountMinor,
        amount: minorToInputValue(t.amountMinor, currencyOf.get(t.walletId)!),
        note: t.note,
      })),
      transfers: transferRows.map((t) => ({
        date: t.date,
        note: t.note,
        fromWalletId: walletRef.get(t.fromWalletId)!,
        toWalletId: walletRef.get(t.toWalletId)!,
        amountMinor: t.amountMinor,
        amount: minorToInputValue(t.amountMinor, currencyOf.get(t.fromWalletId)!),
        receivedAmountMinor: t.receivedAmountMinor,
        receivedAmount: minorToInputValue(t.receivedAmountMinor, currencyOf.get(t.toWalletId)!),
      })),
    };
  });
}

export type CsvExportFilters = Omit<TransactionFilters, "limit" | "offset">;

/**
 * Transactions as CSV (UTF-8 with BOM, CRLF), oldest first. Same filters as `/transactions`, no pagination.
 * A transfer is one row (`wallet` → `to_wallet`) and is included when either of its legs matches the filters.
 * Text cells are protected against spreadsheet formula injection (`escapeFormula`).
 */
export function buildTransactionsCsv(userId: number, filters: CsvExportFilters = {}): string {
  const db = getDb();
  return db.transaction((tx) => {
    const where = filterConditions(userId, filters);
    const walletRows = tx
      .select({ id: wallets.id, name: wallets.name, currency: wallets.currency })
      .from(wallets)
      .where(eq(wallets.userId, userId))
      .all();
    const walletById = new Map(walletRows.map((w) => [w.id, w]));
    const categoryName = new Map(
      tx
        .select({ id: categories.id, name: categories.name })
        .from(categories)
        .where(eq(categories.userId, userId))
        .all()
        .map((c) => [c.id, c.name]),
    );

    const matching = tx
      .select({
        kind: transactions.kind,
        walletId: transactions.walletId,
        categoryId: transactions.categoryId,
        amountMinor: transactions.amountMinor,
        date: transactions.date,
        note: transactions.note,
        transferId: transactions.transferId,
      })
      .from(transactions)
      .where(where)
      .orderBy(asc(transactions.date), asc(transactions.id))
      .all();

    const needTransfers = matching.some((r) => r.transferId !== null);
    const transferById = needTransfers ? new Map(listTransferRows(userId, tx).map((t) => [t.id, t])) : new Map();

    const rows: string[][] = [[...CSV_COLUMNS]];
    const seenTransfers = new Set<number>();
    const text = (s: string | null | undefined) => escapeFormula(s ?? "");

    for (const r of matching) {
      if (r.transferId === null) {
        const w = walletById.get(r.walletId)!;
        rows.push([
          r.date,
          r.kind,
          text(w.name),
          w.currency,
          minorToInputValue(r.amountMinor, w.currency),
          text(categoryName.get(r.categoryId!)),
          text(r.note),
          "",
          "",
          "",
        ]);
        continue;
      }
      if (seenTransfers.has(r.transferId)) continue;
      seenTransfers.add(r.transferId);
      const t: TransferRow | undefined = transferById.get(r.transferId);
      if (!t) continue;
      const from = walletById.get(t.fromWalletId)!;
      const to = walletById.get(t.toWalletId)!;
      rows.push([
        t.date,
        "transfer",
        text(from.name),
        from.currency,
        minorToInputValue(t.amountMinor, from.currency),
        "",
        text(t.note),
        text(to.name),
        to.currency,
        minorToInputValue(t.receivedAmountMinor, to.currency),
      ]);
    }
    return toCsv(rows);
  });
}
