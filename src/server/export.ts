import "server-only";
import { and, asc, eq, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDb, type DBOrTx } from "@/db";
import { categories, transactions, transfers, walletGroups, wallets } from "@/db/schema";
import { BACKUP_APP, BACKUP_VERSION, type Backup } from "@/lib/backup-format";
import { CONTEXT_KIND, CONTEXT_VERSION, type ContextExport } from "@/lib/context-format";
import { escapeFormula, toCsv } from "@/lib/csv";
import { minorToInputValue } from "@/lib/money";
import { filterConditions, type TransactionFilters } from "./transactions";

/**
 * Column order of the transactions CSV (export writes exactly these; import requires the first five). `group` and
 * `archived` were added later and are optional on import, so older files still import unchanged.
 */
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
  "group",
  "archived",
] as const;

/** Read-only transactions of the exports see one consistent snapshot. */
const SNAPSHOT = { isolationLevel: "repeatable read", accessMode: "read only" } as const;

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
export async function listTransferRows(userId: number, tx?: DBOrTx): Promise<TransferRow[]> {
  return (tx ?? (await getDb()))
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
    .orderBy(asc(transfers.date), asc(transfers.id));
}

/**
 * The whole account as a versioned backup. Ids in the file are local (1..n per list, in export order); the
 * user's email, password hash and sessions are never included.
 */
export async function buildBackup(userId: number, now: Date = new Date()): Promise<Backup> {
  const db = await getDb();
  return await db.transaction(async (tx) => {
    const walletRows = await tx.select().from(wallets).where(eq(wallets.userId, userId)).orderBy(asc(wallets.id));
    const groupRows = await tx
      .select({ id: walletGroups.id, name: walletGroups.name, color: walletGroups.color, archivedAt: walletGroups.archivedAt })
      .from(walletGroups)
      .where(eq(walletGroups.userId, userId))
      .orderBy(asc(walletGroups.position), asc(walletGroups.id));
    const groupName = new Map(groupRows.map((g) => [g.id, g.name]));
    const categoryRows = await tx
      .select()
      .from(categories)
      .where(eq(categories.userId, userId))
      .orderBy(asc(categories.id));
    const txRows = await tx
      .select()
      .from(transactions)
      .where(and(eq(transactions.userId, userId), isNull(transactions.transferId)))
      .orderBy(asc(transactions.date), asc(transactions.id));
    const transferRows = await listTransferRows(userId, tx);

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
        ...(w.archivedAt ? { archivedAt: w.archivedAt.toISOString() } : {}),
        group: groupName.get(w.groupId),
      })),
      // In display order: the array order is the position on import.
      groups: groupRows.map((g) => ({ name: g.name, color: g.color, archived: g.archivedAt !== null })),
      categories: categoryRows.map((c) => ({
        id: categoryRef.get(c.id)!,
        name: c.name,
        kind: c.kind,
        archived: c.archivedAt !== null,
      })),
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
  }, SNAPSHOT);
}

/**
 * The "Wallets & categories" context file: every wallet (name, currency, archived, group) and category (name, kind) of the
 * account, in creation order, and nothing else (no ids, balances or transactions). Made for companion tools such as
 * the Statement Importer artifact.
 */
export async function buildContext(userId: number, now: Date = new Date()): Promise<ContextExport> {
  const db = await getDb();
  return await db.transaction(async (tx) => {
    const walletRows = await tx
      .select({ name: wallets.name, currency: wallets.currency, archivedAt: wallets.archivedAt, group: walletGroups.name })
      .from(wallets)
      .innerJoin(walletGroups, eq(walletGroups.id, wallets.groupId))
      .where(eq(wallets.userId, userId))
      .orderBy(asc(wallets.id));
    const categoryRows = await tx
      .select({ name: categories.name, kind: categories.kind })
      .from(categories)
      .where(eq(categories.userId, userId))
      .orderBy(asc(categories.id));
    return {
      app: BACKUP_APP,
      kind: CONTEXT_KIND,
      version: CONTEXT_VERSION,
      exportedAt: now.toISOString(),
      wallets: walletRows.map((w) => ({ name: w.name, currency: w.currency, archived: w.archivedAt !== null, group: w.group })),
      categories: categoryRows.map((c) => ({ name: c.name, kind: c.kind })),
    };
  }, SNAPSHOT);
}

export type CsvExportFilters = Omit<TransactionFilters, "limit" | "offset">;

/**
 * Transactions as CSV (UTF-8 with BOM, CRLF), oldest first. Same filters as `/transactions`, no pagination.
 * A transfer is one row (`wallet` → `to_wallet`) and is included when either of its legs matches the filters.
 * Wallet rows (type `wallet`: initial balance, group, archived date) come first, before the entries.
 * Text cells are protected against spreadsheet formula injection (`escapeFormula`).
 */
export async function buildTransactionsCsv(userId: number, filters: CsvExportFilters = {}): Promise<string> {
  const db = await getDb();
  return await db.transaction(async (tx) => {
    const where = filterConditions(userId, filters);
    const walletRows = await tx
      .select({
        id: wallets.id,
        name: wallets.name,
        currency: wallets.currency,
        initialBalanceMinor: wallets.initialBalanceMinor,
        archivedAt: wallets.archivedAt,
        groupId: wallets.groupId,
        group: walletGroups.name,
      })
      .from(wallets)
      .innerJoin(walletGroups, eq(walletGroups.id, wallets.groupId))
      .where(eq(wallets.userId, userId))
      .orderBy(asc(wallets.id));
    const walletById = new Map(walletRows.map((w) => [w.id, w]));
    const keyOf = (w: { name: string; currency: string }) => `${w.name.toLowerCase()}\u0000${w.currency}`;
    // Same-named wallets of one currency are one wallet in a CSV; its group is that of the wallet an import would
    // send the rows to (the oldest active one, else the oldest), on every row, so the file names one group per wallet.
    const groupOfKey = new Map<string, string>();
    for (const w of [...walletRows].sort((a, b) => Number(a.archivedAt !== null) - Number(b.archivedAt !== null) || a.id - b.id)) {
      if (!groupOfKey.has(keyOf(w))) groupOfKey.set(keyOf(w), w.group);
    }
    const categoryName = new Map(
      (
        await tx
          .select({ id: categories.id, name: categories.name })
          .from(categories)
          .where(eq(categories.userId, userId))
      ).map((c) => [c.id, c.name]),
    );

    const matching = await tx
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
      .orderBy(asc(transactions.date), asc(transactions.id));

    const needTransfers = matching.some((r) => r.transferId !== null);
    const transferById = needTransfers ? new Map((await listTransferRows(userId, tx)).map((t) => [t.id, t])) : new Map();

    const entryRows: string[][] = [];
    const seenTransfers = new Set<number>();
    const text = (s: string | null | undefined) => escapeFormula(s ?? "");
    /** Wallets the exported rows use, for the wallet rows written first. */
    const usedWallets = new Set<number>();

    for (const r of matching) {
      if (r.transferId === null) {
        const w = walletById.get(r.walletId)!;
        usedWallets.add(w.id);
        entryRows.push([
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
          text(groupOfKey.get(keyOf(w))),
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
      usedWallets.add(from.id).add(to.id);
      entryRows.push([
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
        text(groupOfKey.get(keyOf(from))),
        "",
      ]);
    }

    // Wallet rows (type `wallet`) first: initial balance in `amount`, group, archived date. Every wallet the rows use;
    // with no filter other than the wallet / group scope, every wallet in that scope too (unused ones included).
    const scopeOnly = !filters.kind && !filters.categoryId && !filters.month && !filters.from && !filters.to && !filters.q;
    const inScope = (w: (typeof walletRows)[number]) =>
      filters.walletId !== undefined ? w.id === filters.walletId : filters.groupId === undefined || w.groupId === filters.groupId;
    // In a CSV a wallet *is* its name + currency, so same-named wallets of one currency share one wallet row: the
    // initial balances are summed (the merged wallet keeps the total) and it is archived only when all of them are (on
    // the latest date).
    const byKey = new Map<string, (typeof walletRows)[number][]>();
    for (const w of walletRows) {
      if (!usedWallets.has(w.id) && !(scopeOnly && inScope(w))) continue;
      byKey.set(keyOf(w), [...(byKey.get(keyOf(w)) ?? []), w]);
    }
    const walletLines = [...byKey.values()].map((same) => {
      const main = same[0];
      const archived = same.every((w) => w.archivedAt !== null)
        ? new Date(Math.max(...same.map((w) => w.archivedAt!.getTime())))
        : null;
      const initial = same.reduce((n, w) => n + w.initialBalanceMinor, 0);
      return [
        "",
        "wallet",
        text(main.name),
        main.currency,
        minorToInputValue(initial, main.currency),
        "",
        "",
        "",
        "",
        "",
        text(groupOfKey.get(keyOf(main))),
        archived ? archived.toISOString().slice(0, 10) : "",
      ];
    });
    return toCsv([[...CSV_COLUMNS], ...walletLines, ...entryRows]);
  }, SNAPSHOT);
}
