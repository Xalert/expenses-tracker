import "server-only";
import { and, eq, isNull, sql } from "drizzle-orm";
import { getDb, type DBOrTx } from "@/db";
import { categories, transactions, transfers, walletGroups, wallets, type CategoryKind } from "@/db/schema";
import { parseCsv, stripBom } from "@/lib/csv";
import { IMPORT_MAX_BYTES, IMPORT_MAX_FILES, IMPORT_MAX_ROWS } from "@/lib/constants";
import { resolveTimeZone } from "@/lib/dates";
import { listTransferRows } from "./export";
import { assertId } from "./_validate";
import { getDefaultGroupId, getOwnedGroupRow } from "./wallet-groups";
import { backupFormat } from "./import-formats/backup";
import {
  addTally,
  categoryKey,
  emptyParsed,
  fmtCount,
  specBuilder,
  walletKey,
  type EntrySpec,
  type ImportContext,
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

export { IMPORT_MAX_BYTES, IMPORT_MAX_FILES, IMPORT_MAX_ROWS };
export type { ImportFormatId, ImportNotice, ImportProblem };
/** Problems returned to the UI; `problemCount` always has the total. */
export const MAX_PROBLEMS_SHOWN = 50;

export type ImportOptions = {
  /** Skip entries that already exist in the account (multiset comparison). Default true. */
  skipDuplicates?: boolean;
  /**
   * The importing browser's IANA time zone. Timestamps with a UTC offset (Spendee) are dated in it. Missing or
   * invalid → UTC (with a notice saying so).
   */
  timeZone?: string;
  /** Import transfer rows that have no partner as income / expense in a "Transfer" category. Default false. */
  unpairedTransfersAsEntries?: boolean;
  /**
   * The wallet group wallets created by the import go into (the selected scope); a backup's per-wallet `group` takes
   * precedence. Omitted → the user's default group. NOT_FOUND (field `groupId`) when it is not the user's.
   */
  groupId?: number;
};

/** One uploaded file. `name` is only used to label the file in the preview, problems and notices. */
export type ImportFileInput = { name: string; text: string };

export type ImportFileSummary = {
  name: string;
  format: ImportFormatId | null;
  formatLabel: string | null;
  /** Data rows (CSV) or transactions + transfers (backup) read from the file; null when it was not read (a
   * duplicate, or the selection was refused before parsing). */
  rows: number | null;
  /** Set when the file's content is identical to an earlier file of the selection; it is then used once. */
  duplicateOf?: string;
};

export type ImportPreview = {
  /** The format shared by every file; null when the files differ, or the file is empty / unclassified. */
  format: ImportFormatId | null;
  /** How the UI names the format ("Backup (JSON)", "Transactions (CSV)", "Spendee export"); with several formats, joined with " + ". */
  formatLabel: string | null;
  /** The selected files in order, with the format detected for each. */
  files: ImportFileSummary[];
  /** True when there are no problems, i.e. `runImport` would write exactly these numbers. */
  ok: boolean;
  transactionsToAdd: number;
  transfersToAdd: number;
  duplicateTransactions: number;
  duplicateTransfers: number;
  /** `group` is the name of the group the wallet goes into (an existing one, or one of `groupsToCreate`). */
  walletsToCreate: { name: string; currency: string; archived: boolean; group: string }[];
  /** Groups named by a backup that the account does not have yet; created by the import. */
  groupsToCreate: string[];
  categoriesToCreate: { name: string; kind: CategoryKind }[];
  /** The first `MAX_PROBLEMS_SHOWN` problems, in file order (with `file` set when there are several files). */
  problems: ImportProblem[];
  problemCount: number;
  /** Non-blocking information about the file (e.g. amounts that were rounded). Never affects `ok`. */
  notices: ImportNotice[];
  /**
   * Transfer rows without a partner (Spendee). With `unpairedTransfersAsEntries` off they are problems; the UI
   * offers the option whenever this is > 0.
   */
  unpairedTransfers: number;
};

export type ImportResult = ImportPreview & { imported: boolean };

/** What the services accept: one file's text (unnamed), or a selection of named files imported as one. */
export type ImportInput = string | ImportFileInput[];

/** Parse, validate and plan an import without writing anything. */
export function previewImport(userId: number, input: ImportInput, opts: ImportOptions = {}): ImportPreview {
  const parsed = parseImportFiles(input, opts);
  if (parsed.file.problems.length) return summarize(parsed, null);
  return getDb().transaction((tx) => summarize(parsed, planImport(tx, userId, parsed.file, opts)));
}

/**
 * Re-run the whole validation and planning (nothing from a previous preview is trusted) and, when there are no
 * problems, write everything in one DB transaction. With problems nothing is written and `imported` is false.
 */
export function runImport(userId: number, input: ImportInput, opts: ImportOptions = {}): ImportResult {
  const parsed = parseImportFiles(input, opts);
  if (parsed.file.problems.length) return { ...summarize(parsed, null), imported: false };
  return getDb().transaction((tx) => {
    const plan = planImport(tx, userId, parsed.file, opts);
    const summary = summarize(parsed, plan);
    if (!summary.ok) return { ...summary, imported: false };
    writePlan(tx, userId, parsed.file, plan);
    return { ...summary, imported: true };
  });
}

// ---------------------------------------------------------------------------------------------------------
// Formats: each one is a module in ./import-formats that detects and parses its files into a `ParsedFile`.
// The first format whose `detect` accepts the file wins, so order matters: the native CSV accepts anything and
// comes last. Adding a provider = one module + one entry here; the planner and writer never see the format.

const FORMATS: readonly ImportFormat[] = [backupFormat, spendeeFormat, transactionsCsvFormat];

const formatLabel = (id: ImportFormatId | null) => FORMATS.find((f) => f.id === id)?.label ?? null;
const MB = IMPORT_MAX_BYTES / 1024 / 1024;

type ParsedSelection = { file: ParsedFile; files: ImportFileSummary[] };

function importContext(opts: ImportOptions): ImportContext {
  const { timeZone, fallback } = resolveTimeZone(opts.timeZone);
  return { timeZone, timeZoneFallback: fallback, unpairedTransfersAsEntries: opts.unpairedTransfersAsEntries === true };
}

function makeSource(fileText: string): ImportSource | null {
  const body = stripBom(fileText).trimStart();
  if (!body) return null;
  let header: string[] | undefined;
  return {
    text: fileText,
    body,
    csvHeader: () =>
      (header ??= (parseCsv(fileText, { maxRecords: 0 }).records[0]?.cells ?? []).map((c) => c.trim().toLowerCase())),
  };
}

const detectFormat = (source: ImportSource) => FORMATS.find((f) => f.detect(source)) ?? transactionsCsvFormat;

/** Parse one file on its own (no selection-wide steps). Kept for callers that only need the parsed form. */
export function parseImportFile(fileText: string, opts: ImportOptions = {}): ParsedFile {
  return parseImportFiles(fileText, opts).file;
}

/**
 * Parse a selection into one `ParsedFile`: limits on the whole selection, identical files used once, a backup only
 * on its own, each file parsed by its detected format, then merged (wallets by name + currency, categories by
 * kind + name) and finished by each format's `finalize` (Spendee pairs transfer rows across files here).
 */
export function parseImportFiles(input: ImportInput, opts: ImportOptions = {}): ParsedSelection {
  const fail = (message: string, files: ImportFileSummary[] = []): ParsedSelection => ({
    file: emptyParsed(null, [{ message }]),
    files,
  });
  if (typeof input === "string") input = [{ name: "", text: input }];
  if (!Array.isArray(input) || input.length === 0) return fail("No file was received.");
  if (input.some((f) => typeof f?.text !== "string")) return fail("No file was received.");
  const single = input.length === 1;
  if (input.length > IMPORT_MAX_FILES) {
    return fail(`${input.length} files were selected; the limit is ${IMPORT_MAX_FILES} per import.`);
  }
  const bytes = input.reduce((n, f) => n + Buffer.byteLength(f.text, "utf8"), 0);
  if (bytes > IMPORT_MAX_BYTES) {
    return fail(
      single
        ? `The file is larger than ${MB} MB. Split it into smaller files.`
        : `The selected files are larger than ${MB} MB in total. Import them in smaller groups.`,
    );
  }
  const ctx = importContext(opts);

  // Classify every file; identical content is used once.
  const firstByText = new Map<string, string>();
  const files: ImportFileSummary[] = [];
  const parts: { name: string; format: ImportFormat | null; source: ImportSource | null }[] = [];
  for (const f of input) {
    const name = typeof f.name === "string" ? f.name : "";
    const source = makeSource(f.text);
    const format = source ? detectFormat(source) : null;
    const summary: ImportFileSummary = { name, format: format?.id ?? null, formatLabel: format?.label ?? null, rows: null };
    files.push(summary);
    const earlier = firstByText.get(f.text);
    if (earlier !== undefined) {
      summary.duplicateOf = earlier;
      continue;
    }
    firstByText.set(f.text, name);
    parts.push({ name, format, source });
  }
  const used = files.filter((f) => f.duplicateOf === undefined);
  if (parts.length > 1 && parts.some((p) => p.format?.id === "backup")) {
    const backups = used.filter((f) => f.format === "backup").map((f) => `“${f.name}”`);
    return fail(
      `A backup has to be imported on its own: ${backups.join(", ")} ${backups.length === 1 ? "is a backup" : "are backups"}, ` +
        "but other files were selected with it. Import the backup by itself.",
      files,
    );
  }

  // Parse each file, then merge.
  const named = !single;
  const combined = emptyParsed(null);
  const merger = specBuilder(combined);
  parts.forEach((part, fileIndex) => {
    const summary = used[fileIndex];
    const tag = <T extends object>(x: T): T => (named ? { ...x, file: part.name, fileIndex } : { ...x, fileIndex });
    if (!part.source || !part.format) {
      combined.problems.push(tag({ message: "The file is empty." }));
      return;
    }
    const parsed = part.format.parse(part.source, ctx);
    summary.rows = parsed.rowCount;
    if (parts.length === 1) {
      // One file: its parsed form is the selection (a backup keeps its by-position wallet matching).
      Object.assign(combined, parsed, {
        problems: parsed.problems.map(tag),
        notices: parsed.notices.map(tag),
        entries: parsed.entries.map((e) => ({ ...e, loc: tag(e.loc) })),
        transfers: parsed.transfers.map((t) => ({ ...t, loc: tag(t.loc) })),
        transferLegs: parsed.transferLegs.map((l) => ({ ...l, loc: tag(l.loc) })),
      });
      return;
    }
    const walletMap = parsed.wallets.map((w) => merger.walletFor(w.name, w.currency));
    const categoryMap = parsed.categories.map((c) => merger.categoryFor(c.kind, c.name));
    combined.entries.push(
      ...parsed.entries.map((e) => ({ ...e, wallet: walletMap[e.wallet], category: categoryMap[e.category], loc: tag(e.loc) })),
    );
    combined.transfers.push(
      ...parsed.transfers.map((t) => ({ ...t, from: walletMap[t.from], to: walletMap[t.to], loc: tag(t.loc) })),
    );
    combined.transferLegs.push(...parsed.transferLegs.map((l) => ({ ...l, wallet: walletMap[l.wallet], loc: tag(l.loc) })));
    combined.problems.push(...parsed.problems.map(tag));
    combined.notices.push(...parsed.notices.map(tag));
    combined.rowCount += parsed.rowCount;
    for (const [k, n] of parsed.tallies) addTally(combined, k, n);
  });
  const formatIds = [...new Set(used.map((f) => f.format))];
  combined.format = formatIds.length === 1 ? formatIds[0] : null;

  if (!single && combined.rowCount > IMPORT_MAX_ROWS) {
    return fail(
      `The selected files have ${fmtCount(combined.rowCount)} rows in total; the limit is ${fmtCount(IMPORT_MAX_ROWS)} per import. ` +
        "Import them in smaller groups.",
      files,
    );
  }

  // Selection-wide steps of each format present (e.g. Spendee transfer pairing), then file order for problems.
  for (const format of FORMATS) {
    if (format.finalize && parts.some((p) => p.format === format)) format.finalize(combined, ctx);
  }
  combined.problems = sortByLocation(combined.problems);

  const duplicates = files.filter((f) => f.duplicateOf !== undefined);
  for (const d of duplicates) {
    combined.notices.unshift({
      code: "duplicate-file",
      count: 1,
      file: d.name,
      message: `“${d.name}” has the same content as “${d.duplicateOf}”, so it is imported once.`,
    });
  }
  return { file: combined, files };
}

/** File order, then line order; problems without a line (whole-file problems) first within their file. */
function sortByLocation<T extends Loc>(items: T[]): T[] {
  return items
    .map((x, k) => ({ x, k }))
    .sort((a, b) => (a.x.fileIndex ?? -1) - (b.x.fileIndex ?? -1) || (a.x.line ?? 0) - (b.x.line ?? 0) || a.k - b.k)
    .map(({ x }) => x);
}

// ---------------------------------------------------------------------------------------------------------
// Planning: match against the account, find duplicates, apply the archived-wallet rule

type WalletTarget = { id: number | null; archived: boolean };

type Plan = {
  walletTargets: WalletTarget[]; // per file wallet; id null → created
  /** File wallet indexes to create, in file order. */
  walletsToCreate: number[];
  /** Per file wallet to create: the target group's name, and its id (null → it is in `groupsToCreate`). */
  walletGroups: Map<number, { name: string; id: number | null }>;
  /** Group names to create (first spelling wins), in file order. */
  groupsToCreate: string[];
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
  const targetGroupId =
    opts.groupId === undefined
      ? getDefaultGroupId(userId, tx)
      : getOwnedGroupRow(userId, assertId(opts.groupId, "groupId", "group"), tx).id;
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

  // Groups of the wallets to create -----------------------------------------------------------------
  const groupRows = tx
    .select({ id: walletGroups.id, name: walletGroups.name })
    .from(walletGroups)
    .where(eq(walletGroups.userId, userId))
    .orderBy(walletGroups.id)
    .all();
  const groupByFolded = new Map(groupRows.map((g) => [g.name.toLowerCase(), g]));
  const targetGroup = groupRows.find((g) => g.id === targetGroupId)!;
  const walletGroups_ = new Map<number, { name: string; id: number | null }>();
  const groupsToCreate: string[] = [];
  const plannedGroups = new Set<string>();
  for (const i of walletsToCreate) {
    const named = parsed.wallets[i].group;
    if (named === undefined) {
      walletGroups_.set(i, { name: targetGroup.name, id: targetGroup.id });
      continue;
    }
    const folded = named.toLowerCase();
    const existing = groupByFolded.get(folded);
    if (existing) {
      walletGroups_.set(i, { name: existing.name, id: existing.id });
      continue;
    }
    if (!plannedGroups.has(folded)) {
      plannedGroups.add(folded);
      groupsToCreate.push(named);
    }
    const first = groupsToCreate.find((n) => n.toLowerCase() === folded)!;
    walletGroups_.set(i, { name: first, id: null });
  }

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
  const sortedProblems = sortByLocation(problems);

  return {
    walletTargets,
    walletsToCreate,
    walletGroups: walletGroups_,
    groupsToCreate,
    categoryTargets,
    categoriesToCreate,
    entriesToAdd,
    transfersToAdd,
    duplicateTransactions,
    duplicateTransfers,
    problems: sortedProblems,
  };
}

function entryKey(wallet: string, kind: string, categoryId: number, date: string, amount: number, note: string | null) {
  return `${wallet}|${kind}|${categoryId}|${date}|${amount}|${note ?? ""}`;
}

function transferKey(from: string, to: string, date: string, sent: number, received: number, note: string | null) {
  return `${from}|${to}|${date}|${sent}|${received}|${note ?? ""}`;
}

function summarize({ file: parsed, files }: ParsedSelection, plan: Plan | null): ImportPreview {
  const problems = plan ? [...parsed.problems, ...plan.problems] : parsed.problems;
  const labels = [...new Set(files.filter((f) => f.duplicateOf === undefined && f.formatLabel).map((f) => f.formatLabel!))];
  return {
    format: parsed.format,
    formatLabel: parsed.format ? formatLabel(parsed.format) : labels.length ? labels.join(" + ") : null,
    files,
    ok: problems.length === 0,
    transactionsToAdd: plan?.entriesToAdd.length ?? 0,
    transfersToAdd: plan?.transfersToAdd.length ?? 0,
    duplicateTransactions: plan?.duplicateTransactions ?? 0,
    duplicateTransfers: plan?.duplicateTransfers ?? 0,
    walletsToCreate: (plan?.walletsToCreate ?? []).map((i) => {
      const w = parsed.wallets[i];
      return { name: w.name, currency: w.currency, archived: w.archived, group: plan!.walletGroups.get(i)!.name };
    }),
    groupsToCreate: plan?.groupsToCreate ?? [],
    categoriesToCreate: (plan?.categoriesToCreate ?? []).map((i) => ({
      name: parsed.categories[i].name,
      kind: parsed.categories[i].kind,
    })),
    problems: problems.slice(0, MAX_PROBLEMS_SHOWN).map(publicLocation),
    problemCount: problems.length,
    notices: parsed.notices.map(publicLocation),
    unpairedTransfers: parsed.unpairedTransferRows,
  };
}

/** Drop the internal `fileIndex` (and an unset `file`) from what is sent to the UI. */
function publicLocation<T extends { file?: string }>(x: T): T {
  const out = { ...x } as T & { fileIndex?: number };
  delete out.fileIndex;
  if (!out.file) delete out.file;
  return out;
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

  const createdGroupIds = new Map<string, number>();
  for (const name of plan.groupsToCreate) {
    createdGroupIds.set(
      name.toLowerCase(),
      tx.insert(walletGroups).values({ userId, name, createdAt: now }).returning({ id: walletGroups.id }).get().id,
    );
  }

  const walletIds = plan.walletTargets.map((t) => t.id);
  for (const i of plan.walletsToCreate) {
    const w = parsed.wallets[i];
    const target = plan.walletGroups.get(i)!;
    walletIds[i] = tx
      .insert(wallets)
      .values({
        userId,
        groupId: target.id ?? createdGroupIds.get(target.name.toLowerCase())!,
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
