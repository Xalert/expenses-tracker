import "server-only";
import { and, eq, isNull, sql } from "drizzle-orm";
import { getDb, type DBOrTx } from "@/db";
import { categories, transactions, transfers, wallets, type CategoryKind } from "@/db/schema";
import { parseCsv, stripBom } from "@/lib/csv";
import { IMPORT_MAX_BYTES, IMPORT_MAX_ROWS } from "@/lib/constants";
import { listTransferRows } from "./export";
import { backupFormat } from "./import-formats/backup";
import {
  categoryKey,
  emptyParsed,
  walletKey,
  type EntrySpec,
  type ImportFormat,
  type ImportFormatId,
  type ImportNotice,
  type ImportProblem,
  type ImportSource,
  type Loc,
  type ParsedFile,
  type TransferSpec,
} from "./import-formats/shared";
import { spendeeFormat } from "./import-formats/spendee";
import { transactionsCsvFormat } from "./import-formats/transactions-csv";

// ---------------------------------------------------------------------------------------------------------
// Public API

export { IMPORT_MAX_BYTES, IMPORT_MAX_ROWS };
export type { ImportFormatId, ImportNotice, ImportProblem };
/** Problems returned to the UI; `problemCount` always has the total. */
export const MAX_PROBLEMS_SHOWN = 50;

export type ImportOptions = {
  /** Skip entries that already exist in the account (multiset comparison). Default true. */
  skipDuplicates?: boolean;
};

export type ImportPreview = {
  /** Detected from the content; null when the file is empty or could not be classified. */
  format: ImportFormatId | null;
  /** How the UI names the format ("Backup (JSON)", "Transactions (CSV)", "Spendee export"); null with `format`. */
  formatLabel: string | null;
  /** True when there are no problems, i.e. `runImport` would write exactly these numbers. */
  ok: boolean;
  transactionsToAdd: number;
  transfersToAdd: number;
  duplicateTransactions: number;
  duplicateTransfers: number;
  walletsToCreate: { name: string; currency: string; archived: boolean }[];
  categoriesToCreate: { name: string; kind: CategoryKind }[];
  /** The first `MAX_PROBLEMS_SHOWN` problems, in file order. */
  problems: ImportProblem[];
  problemCount: number;
  /** Non-blocking information about the file (e.g. amounts that were rounded). Never affects `ok`. */
  notices: ImportNotice[];
};

export type ImportResult = ImportPreview & { imported: boolean };

/** Parse, validate and plan an import without writing anything. */
export function previewImport(userId: number, fileText: string, opts: ImportOptions = {}): ImportPreview {
  const parsed = parseImportFile(fileText);
  if (parsed.problems.length) return summarize(parsed, null);
  return getDb().transaction((tx) => summarize(parsed, planImport(tx, userId, parsed, opts)));
}

/**
 * Re-run the whole validation and planning (nothing from a previous preview is trusted) and, when there are no
 * problems, write everything in one DB transaction. With problems nothing is written and `imported` is false.
 */
export function runImport(userId: number, fileText: string, opts: ImportOptions = {}): ImportResult {
  const parsed = parseImportFile(fileText);
  if (parsed.problems.length) return { ...summarize(parsed, null), imported: false };
  return getDb().transaction((tx) => {
    const plan = planImport(tx, userId, parsed, opts);
    const summary = summarize(parsed, plan);
    if (!summary.ok) return { ...summary, imported: false };
    writePlan(tx, userId, parsed, plan);
    return { ...summary, imported: true };
  });
}

// ---------------------------------------------------------------------------------------------------------
// Formats: each one is a module in ./import-formats that detects and parses its files into a `ParsedFile`.
// The first format whose `detect` accepts the file wins, so order matters: the native CSV accepts anything and
// comes last. Adding a provider = one module + one entry here; the planner and writer never see the format.

const FORMATS: readonly ImportFormat[] = [backupFormat, spendeeFormat, transactionsCsvFormat];

const formatLabel = (id: ImportFormatId | null) => FORMATS.find((f) => f.id === id)?.label ?? null;

export function parseImportFile(fileText: string): ParsedFile {
  if (typeof fileText !== "string") return emptyParsed(null, [{ message: "No file was received." }]);
  if (Buffer.byteLength(fileText, "utf8") > IMPORT_MAX_BYTES) {
    return emptyParsed(null, [
      { message: `The file is larger than ${IMPORT_MAX_BYTES / 1024 / 1024} MB. Split it into smaller files.` },
    ]);
  }
  const body = stripBom(fileText).trimStart();
  if (!body) return emptyParsed(null, [{ message: "The file is empty." }]);
  let header: string[] | undefined;
  const source: ImportSource = {
    text: fileText,
    body,
    csvHeader: () =>
      (header ??= (parseCsv(fileText, { maxRecords: 0 }).records[0]?.cells ?? []).map((c) => c.trim().toLowerCase())),
  };
  const format = FORMATS.find((f) => f.detect(source)) ?? transactionsCsvFormat;
  return format.parse(source);
}

// ---------------------------------------------------------------------------------------------------------
// Planning: match against the account, find duplicates, apply the archived-wallet rule

type WalletTarget = { id: number | null; archived: boolean };

type Plan = {
  walletTargets: WalletTarget[]; // per file wallet; id null → created
  /** File wallet indexes to create, in file order. */
  walletsToCreate: number[];
  /** Category key → existing id, or null when it will be created. */
  categoryTargets: (number | null)[];
  categoriesToCreate: number[];
  entriesToAdd: EntrySpec[];
  transfersToAdd: TransferSpec[];
  duplicateTransactions: number;
  duplicateTransfers: number;
  problems: ImportProblem[];
};

function planImport(tx: DBOrTx, userId: number, parsed: ParsedFile, opts: ImportOptions): Plan {
  const skipDuplicates = opts.skipDuplicates ?? true;
  const problems: ImportProblem[] = [];

  // Wallets ------------------------------------------------------------------------------------------
  const existingWallets = tx
    .select({ id: wallets.id, name: wallets.name, currency: wallets.currency, archivedAt: wallets.archivedAt })
    .from(wallets)
    .where(eq(wallets.userId, userId))
    .orderBy(wallets.id)
    .all();
  const candidates = new Map<string, { id: number; archived: boolean }[]>();
  for (const w of existingWallets) {
    const key = walletKey(w.name, w.currency);
    const list = candidates.get(key) ?? [];
    list.push({ id: w.id, archived: w.archivedAt !== null });
    candidates.set(key, list);
  }
  if (parsed.walletMatching === "merge") {
    // Prefer an active wallet, then the oldest.
    for (const list of candidates.values()) list.sort((a, b) => Number(a.archived) - Number(b.archived) || a.id - b.id);
  }
  const used = new Map<string, number>();
  const walletTargets: WalletTarget[] = [];
  const walletsToCreate: number[] = [];
  parsed.wallets.forEach((w, i) => {
    const k = used.get(w.key) ?? 0;
    used.set(w.key, k + 1);
    const match = candidates.get(w.key)?.[parsed.walletMatching === "by-position" ? k : 0];
    if (match) walletTargets.push({ id: match.id, archived: match.archived });
    else {
      walletTargets.push({ id: null, archived: false });
      walletsToCreate.push(i);
    }
  });

  // Categories ---------------------------------------------------------------------------------------
  const existingCategories = new Map<string, number>();
  for (const c of tx
    .select({ id: categories.id, name: categories.name, kind: categories.kind })
    .from(categories)
    .where(eq(categories.userId, userId))
    .orderBy(categories.id)
    .all()) {
    const key = categoryKey(c.kind, c.name);
    if (!existingCategories.has(key)) existingCategories.set(key, c.id);
  }
  const categoryTargets = parsed.categories.map((c) => existingCategories.get(c.key) ?? null);
  const categoriesToCreate = categoryTargets.flatMap((id, i) => (id === null ? [i] : []));

  // Existing entries as multisets (only needed when skipping duplicates) ------------------------------
  // In a CSV a wallet *is* its name + currency, so two same-named wallets of the account count as one for
  // duplicate detection (re-importing an export of such an account must still add nothing). A backup keeps
  // wallets apart by id.
  const keyById = new Map(existingWallets.map((w) => [w.id, walletKey(w.name, w.currency)]));
  const ident = (walletId: number) => (parsed.walletMatching === "merge" ? keyById.get(walletId)! : String(walletId));
  const entryCounts = new Map<string, number>();
  const transferCounts = new Map<string, number>();
  if (skipDuplicates) {
    const groups = tx
      .select({
        walletId: transactions.walletId,
        kind: transactions.kind,
        categoryId: transactions.categoryId,
        date: transactions.date,
        amountMinor: transactions.amountMinor,
        note: transactions.note,
        n: sql<number>`count(*)`,
      })
      .from(transactions)
      .where(and(eq(transactions.userId, userId), isNull(transactions.transferId)))
      .groupBy(
        transactions.walletId,
        transactions.kind,
        transactions.categoryId,
        transactions.date,
        transactions.amountMinor,
        transactions.note,
      )
      .all();
    for (const g of groups) {
      const key = entryKey(ident(g.walletId), g.kind, g.categoryId!, g.date, g.amountMinor, g.note);
      entryCounts.set(key, (entryCounts.get(key) ?? 0) + g.n);
    }
    for (const t of listTransferRows(userId, tx)) {
      const key = transferKey(ident(t.fromWalletId), ident(t.toWalletId), t.date, t.amountMinor, t.receivedAmountMinor, t.note);
      transferCounts.set(key, (transferCounts.get(key) ?? 0) + 1);
    }
  }

  /** Consume one matching existing entry, if any (multiset subtraction). */
  const takeDuplicate = (counts: Map<string, number>, key: string) => {
    const n = counts.get(key) ?? 0;
    if (n <= 0) return false;
    counts.set(key, n - 1);
    return true;
  };
  const archivedProblem = (loc: Loc, fileWallet: number) => {
    const w = parsed.wallets[fileWallet];
    problems.push({
      ...loc,
      message:
        `Wallet “${w.name}” (${w.currency}) is archived in your account, so nothing new can be added to it. ` +
        "Unarchive it first, or remove these rows.",
    });
  };

  const entriesToAdd: EntrySpec[] = [];
  let duplicateTransactions = 0;
  for (const e of parsed.entries) {
    const wallet = walletTargets[e.wallet];
    const categoryId = categoryTargets[e.category];
    if (
      skipDuplicates &&
      wallet.id !== null &&
      categoryId !== null &&
      takeDuplicate(entryCounts, entryKey(ident(wallet.id), e.kind, categoryId, e.date, e.amountMinor, e.note))
    ) {
      duplicateTransactions++;
      continue;
    }
    if (wallet.archived) archivedProblem(e.loc, e.wallet);
    entriesToAdd.push(e);
  }

  const transfersToAdd: TransferSpec[] = [];
  let duplicateTransfers = 0;
  for (const t of parsed.transfers) {
    const from = walletTargets[t.from];
    const to = walletTargets[t.to];
    if (from.id !== null && from.id === to.id) {
      problems.push({ ...t.loc, message: "A transfer needs two different wallets." });
      continue;
    }
    if (
      skipDuplicates &&
      from.id !== null &&
      to.id !== null &&
      takeDuplicate(
        transferCounts,
        transferKey(ident(from.id), ident(to.id), t.date, t.amountMinor, t.receivedAmountMinor, t.note),
      )
    ) {
      duplicateTransfers++;
      continue;
    }
    if (from.archived) archivedProblem(t.loc, t.from);
    else if (to.archived) archivedProblem(t.loc, t.to);
    transfersToAdd.push(t);
  }

  // Report problems in file order (entries and transfers are interleaved in a CSV).
  problems.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));

  return {
    walletTargets,
    walletsToCreate,
    categoryTargets,
    categoriesToCreate,
    entriesToAdd,
    transfersToAdd,
    duplicateTransactions,
    duplicateTransfers,
    problems,
  };
}

function entryKey(wallet: string, kind: string, categoryId: number, date: string, amount: number, note: string | null) {
  return `${wallet}|${kind}|${categoryId}|${date}|${amount}|${note ?? ""}`;
}

function transferKey(from: string, to: string, date: string, sent: number, received: number, note: string | null) {
  return `${from}|${to}|${date}|${sent}|${received}|${note ?? ""}`;
}

function summarize(parsed: ParsedFile, plan: Plan | null): ImportPreview {
  const problems = plan ? [...parsed.problems, ...plan.problems] : parsed.problems;
  return {
    format: parsed.format,
    formatLabel: formatLabel(parsed.format),
    ok: problems.length === 0,
    transactionsToAdd: plan?.entriesToAdd.length ?? 0,
    transfersToAdd: plan?.transfersToAdd.length ?? 0,
    duplicateTransactions: plan?.duplicateTransactions ?? 0,
    duplicateTransfers: plan?.duplicateTransfers ?? 0,
    walletsToCreate: (plan?.walletsToCreate ?? []).map((i) => {
      const w = parsed.wallets[i];
      return { name: w.name, currency: w.currency, archived: w.archived };
    }),
    categoriesToCreate: (plan?.categoriesToCreate ?? []).map((i) => ({
      name: parsed.categories[i].name,
      kind: parsed.categories[i].kind,
    })),
    problems: problems.slice(0, MAX_PROBLEMS_SHOWN),
    problemCount: problems.length,
    notices: parsed.notices,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Writing (inside the caller's DB transaction)

/** Rows per multi-row INSERT: 9 bound columns × 1000 stays far below SQLite's 32 766 variable limit. */
const CHUNK = 1000;

function chunks<T>(items: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function writePlan(tx: DBOrTx, userId: number, parsed: ParsedFile, plan: Plan): void {
  const now = new Date();

  const walletIds = plan.walletTargets.map((t) => t.id);
  for (const i of plan.walletsToCreate) {
    const w = parsed.wallets[i];
    walletIds[i] = tx
      .insert(wallets)
      .values({
        userId,
        name: w.name,
        currency: w.currency,
        initialBalanceMinor: w.initialBalanceMinor,
        // A backup restores archived wallets as archived (their history is inserted below, bypassing the
        // "no new transactions on archived wallets" rule on purpose: it is a restore, not new activity).
        archivedAt: w.archived ? now : null,
        createdAt: now,
      })
      .returning({ id: wallets.id })
      .get().id;
  }

  const categoryIds = [...plan.categoryTargets];
  for (const i of plan.categoriesToCreate) {
    const c = parsed.categories[i];
    categoryIds[i] = tx
      .insert(categories)
      .values({ userId, name: c.name, kind: c.kind, createdAt: now })
      .returning({ id: categories.id })
      .get().id;
  }

  for (const chunk of chunks(plan.entriesToAdd)) {
    tx.insert(transactions)
      .values(
        chunk.map((e) => ({
          userId,
          walletId: walletIds[e.wallet]!,
          kind: e.kind,
          categoryId: categoryIds[e.category]!,
          amountMinor: e.amountMinor,
          date: e.date,
          note: e.note,
          transferId: null,
          createdAt: now,
        })),
      )
      .run();
  }

  for (const chunk of chunks(plan.transfersToAdd, CHUNK / 2)) {
    // SQLite assigns rowids in VALUES order within one INSERT, so the ascending ids line up with `chunk`.
    const ids = tx
      .insert(transfers)
      .values(chunk.map((t) => ({ userId, date: t.date, note: t.note, createdAt: now })))
      .returning({ id: transfers.id })
      .all()
      .map((r) => r.id)
      .sort((a, b) => a - b);
    if (ids.length !== chunk.length) throw new Error("Transfer insert returned an unexpected number of rows.");
    tx.insert(transactions)
      .values(
        chunk.flatMap((t, j) => [
          {
            userId,
            walletId: walletIds[t.from]!,
            kind: "transfer_out" as const,
            categoryId: null,
            amountMinor: t.amountMinor,
            date: t.date,
            note: t.note,
            transferId: ids[j],
            createdAt: now,
          },
          {
            userId,
            walletId: walletIds[t.to]!,
            kind: "transfer_in" as const,
            categoryId: null,
            amountMinor: t.receivedAmountMinor,
            date: t.date,
            note: t.note,
            transferId: ids[j],
            createdAt: now,
          },
        ]),
      )
      .run();
  }
}
