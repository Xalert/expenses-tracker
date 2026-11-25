import "server-only";
import { and, asc, eq, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDb, type DBOrTx } from "@/db";
import {
  budgets,
  categories,
  manualRates,
  recurringTransactions,
  tags,
  transactions,
  transfers,
  walletGroups,
  wallets,
} from "@/db/schema";
import { BACKUP_APP, BACKUP_VERSION, type Backup } from "@/lib/backup-format";
import { isGroupColor } from "@/lib/group-colors";
import { CONTEXT_KIND, CONTEXT_VERSION, type ContextExport } from "@/lib/context-format";
import { escapeFormula, toCsv } from "@/lib/csv";
import { minorToInputValue } from "@/lib/money";
import { joinTags, sortTagNames } from "@/lib/tags";
import { loadAllEntryTags, loadEntryTags } from "./tags";
import { filterConditions, type TransactionFilters } from "./transactions";

/**
 * Column order of the transactions CSV (export writes exactly these; import requires the first five). `group`,
 * `archived`, `kind` (category rows) and `tags` (an entry's tags, ", "-separated) were added later and are optional
 * on import, so older files still import unchanged; new columns go last.
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
  "kind",
  "tags",
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
    const rateRows = await tx
      .select({ currency: manualRates.currency, base: manualRates.base, effectiveDate: manualRates.effectiveDate, rate: manualRates.rate })
      .from(manualRates)
      .where(eq(manualRates.userId, userId))
      .orderBy(asc(manualRates.currency), asc(manualRates.effectiveDate));
    const ruleRows = await tx
      .select()
      .from(recurringTransactions)
      .where(eq(recurringTransactions.userId, userId))
      .orderBy(asc(recurringTransactions.id));
    const budgetRows = await tx
      .select({ categoryId: budgets.categoryId, currency: budgets.currency, amountMinor: budgets.amountMinor })
      .from(budgets)
      .where(eq(budgets.userId, userId))
      .orderBy(asc(budgets.id));
    const categoryNameOf = new Map(categoryRows.map((c) => [c.id, c.name]));
    const tagRows = await tx.select({ name: tags.name }).from(tags).where(eq(tags.userId, userId)).orderBy(asc(tags.id));
    const tagsOf = await loadAllEntryTags(tx, userId);

    const walletRef = new Map(walletRows.map((w, i) => [w.id, i + 1]));
    const currencyOf = new Map(walletRows.map((w) => [w.id, w.currency]));
    const categoryRef = new Map(categoryRows.map((c, i) => [c.id, i + 1]));
    const categoryById = new Map(categoryRows.map((c) => [c.id, c]));
    const ruleRef = new Map(ruleRows.map((r, i) => [r.id, i + 1]));

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
        ...(c.archivedAt ? { archivedAt: c.archivedAt.toISOString() } : {}),
        ...(isGroupColor(c.color) ? { color: c.color } : {}),
      })),
      transactions: txRows.map((t) => ({
        date: t.date,
        kind: t.kind as "expense" | "income",
        walletId: walletRef.get(t.walletId)!,
        categoryId: categoryRef.get(t.categoryId!)!,
        amountMinor: t.amountMinor,
        amount: minorToInputValue(t.amountMinor, currencyOf.get(t.walletId)!),
        note: t.note,
        ...(t.recurringId !== null && ruleRef.has(t.recurringId) ? { recurringId: ruleRef.get(t.recurringId)! } : {}),
        ...(tagsOf.has(t.id) ? { tags: tagsOf.get(t.id)! } : {}),
      })),
      // Every tag of the account, unused ones too, by name (ignoring case).
      tags: sortTagNames(tagRows.map((t) => t.name)).map((name) => ({ name })),
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
      // The user's own exchange rates (/rates); the provider's rates are shared and not part of an account.
      manualRates: rateRows.map((r) => ({ currency: r.currency, base: r.base, effectiveDate: r.effectiveDate, rate: r.rate })),
      // The repeating entries, in creation order; the category by kind + name.
      recurring: ruleRows.map((r) => ({
        id: ruleRef.get(r.id)!,
        walletId: walletRef.get(r.walletId)!,
        kind: r.kind,
        category: categoryById.get(r.categoryId)!.name,
        amountMinor: r.amountMinor,
        amount: minorToInputValue(r.amountMinor, currencyOf.get(r.walletId)!),
        note: r.note,
        frequency: r.frequency,
        interval: r.interval,
        startDate: r.startDate,
        endDate: r.endDate,
        nextDate: r.nextDate,
        paused: r.pausedAt !== null,
      })),
      // The overall budget first (no `category`), then the category budgets in the order they were first set. A budget
      // names its expense category (names are unique per kind).
      budgets: budgetRows
        .map((b) => ({
          ...(b.categoryId === null ? {} : { category: categoryNameOf.get(b.categoryId)! }),
          currency: b.currency,
          amountMinor: b.amountMinor,
          amount: minorToInputValue(b.amountMinor, b.currency),
        }))
        .sort((a, b) => (a.category === undefined ? -1 : b.category === undefined ? 1 : 0)),
    };
  }, SNAPSHOT);
}

/**
 * The "Wallets & categories" context file: every wallet (name, currency, archived, group) and category (name, kind, archived) of the
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
      .select({ name: categories.name, kind: categories.kind, archivedAt: categories.archivedAt })
      .from(categories)
      .where(eq(categories.userId, userId))
      .orderBy(asc(categories.id));
    return {
      app: BACKUP_APP,
      kind: CONTEXT_KIND,
      version: CONTEXT_VERSION,
      exportedAt: now.toISOString(),
      wallets: walletRows.map((w) => ({ name: w.name, currency: w.currency, archived: w.archivedAt !== null, group: w.group })),
      categories: categoryRows.map((c) => ({ name: c.name, kind: c.kind, archived: c.archivedAt !== null })),
    };
  }, SNAPSHOT);
}

export type CsvExportFilters = Omit<TransactionFilters, "limit" | "offset">;

/**
 * Transactions as CSV (UTF-8 with BOM, CRLF), oldest first. Same filters as `/transactions`, no pagination.
 * A transfer is one row (`wallet` → `to_wallet`) and is included when either of its legs matches the filters.
 * Wallet rows (type `wallet`: initial balance, group, archived date) come first, then category rows (type `category`:
 * kind and archived date, for the archived categories the rows use), then the entries.
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
    const categoryRows = await tx
      .select({ id: categories.id, name: categories.name, kind: categories.kind, archivedAt: categories.archivedAt })
      .from(categories)
      .where(eq(categories.userId, userId))
      .orderBy(asc(categories.id));
    const categoryName = new Map(categoryRows.map((c) => [c.id, c.name]));
    /** Categories the exported rows use, for the category rows of the archived ones. */
    const usedCategories = new Set<number>();

    const matching = await tx
      .select({
        id: transactions.id,
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

    const tagsOf = await loadEntryTags(
      tx,
      matching.filter((r) => r.transferId === null).map((r) => r.id),
    );
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
        usedCategories.add(r.categoryId!);
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
          "",
          text(joinTags(tagsOf.get(r.id) ?? [])),
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
        "",
        "",
      ]);
    }

    // Wallet rows (type `wallet`) first: initial balance in `amount`, group, archived date. Every wallet the rows use;
    // with no filter other than the wallet / group scope, every wallet in that scope too (unused ones included).
    const scopeOnly = !filters.kind && !filters.categoryId && !filters.tagId && !filters.month && !filters.from && !filters.to && !filters.q;
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
        "",
        "",
      ];
    });
    // Category rows (type `category`) next: one per archived category the exported rows use, with its kind and the
    // date it was archived, so an import that creates it archives it too. Active categories need no row.
    const categoryLines = categoryRows
      .filter((c) => c.archivedAt !== null && usedCategories.has(c.id))
      .map((c) => ["", "category", "", "", "", text(c.name), "", "", "", "", "", c.archivedAt!.toISOString().slice(0, 10), c.kind, ""]);
    return toCsv([[...CSV_COLUMNS], ...walletLines, ...categoryLines, ...entryRows]);
  }, SNAPSHOT);
}
