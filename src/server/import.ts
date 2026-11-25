import "server-only";
import { and, eq, isNull, sql } from "drizzle-orm";
import { getDb, type DBOrTx } from "@/db";
import {
  budgets,
  categories,
  manualRates,
  recurringTransactions,
  tags,
  transactions,
  transactionTags,
  transfers,
  walletGroups,
  wallets,
  type CategoryKind,
} from "@/db/schema";
import { tagKey } from "@/lib/tags";
import { ensureTagIds } from "./tags";
import { parseCsv, stripBom } from "@/lib/csv";
import { IMPORT_MAX_BYTES, IMPORT_MAX_FILES, IMPORT_MAX_ROWS } from "@/lib/constants";
import { resolveTimeZone } from "@/lib/dates";
import { parseRateInput } from "@/lib/fx";
import { listTransferRows } from "./export";
import { assertId } from "./_validate";
import { getUserTimeZone } from "./users";
import { getDefaultGroupId, getOpenGroupRow, nextGroupPosition } from "./wallet-groups";
import { backupFormat } from "./import-formats/backup";
import {
  addTally,
  type BudgetSpec,
  categoryKey,
  type CategorySpec,
  emptyParsed,
  fmtCount,
  specBuilder,
  walletKey,
  type EntrySpec,
  type GroupSpec,
  type ImportContext,
  type ImportFormat,
  type ImportFormatId,
  type ImportNotice,
  type ImportProblem,
  type ImportSource,
  type Loc,
  type ManualRateSpec,
  type ParsedFile,
  type TransferSpec,
  type WalletSpec,
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
   * The importing browser's IANA time zone. Spendee's UTC timestamps are dated in the account's time zone when it has
   * one, else in this one; missing or invalid (and no account zone) → UTC.
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
  /**
   * `group` is the name of the group the wallet goes into (an existing one, or one of `groupsToCreate`). `described`:
   * the file gives the wallet's initial balance and archived state (a backup always; a CSV in a `wallet` row);
   * otherwise it starts at 0 and active.
   */
  walletsToCreate: { name: string; currency: string; archived: boolean; group: string; described: boolean }[];
  /**
   * Groups named by a backup (its `groups` list, then its wallets' `group`) or by a CSV's `group` cells that the account does not have yet;
   * created by the import, last in the order, with the list's colour and archived state.
   */
  groupsToCreate: string[];
  /** `archived: true` (present only then): a backup's archived category, or a CSV category row's, created archived. */
  categoriesToCreate: { name: string; kind: CategoryKind; archived?: true }[];
  /**
   * Backup only: the file's own exchange rates the account lacks (a rate for a currency and date the account already
   * has is kept as it is, never replaced).
   */
  manualRatesToAdd: number;
  /** Backup only: repeating entries the account lacks (created), and those it already has (skipped). */
  recurringToAdd: number;
  duplicateRecurring: number;
  /**
   * Backup only: the file's budgets the account lacks (the overall one, or one for a category that has none, created
   * or existing). A budget the account already has is kept as it is, never replaced.
   */
  budgetsToAdd: number;
  /**
   * Tags the account lacks (by name, ignoring case) that the import creates: those an added entry carries (CSV `tags`,
   * backup entry `tags`) and, from a backup, every tag of its `tags` list.
   */
  tagsToCreate: string[];
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
export async function previewImport(userId: number, input: ImportInput, opts: ImportOptions = {}): Promise<ImportPreview> {
  const parsed = parseImportFiles(input, opts, await getUserTimeZone(userId));
  if (parsed.file.problems.length) return summarize(parsed, null);
  const db = await getDb();
  // A transaction only so the read-only plan sees one consistent snapshot of the account.
  return await db.transaction(async (tx) => summarize(parsed, await planImport(tx, userId, parsed.file, opts)));
}

/**
 * Re-run the whole validation and planning (nothing from a previous preview is trusted) and, when there are no
 * problems, write everything in one DB transaction. With problems nothing is written and `imported` is false.
 */
export async function runImport(userId: number, input: ImportInput, opts: ImportOptions = {}): Promise<ImportResult> {
  const parsed = parseImportFiles(input, opts, await getUserTimeZone(userId));
  if (parsed.file.problems.length) return { ...summarize(parsed, null), imported: false };
  const db = await getDb();
  return await db.transaction(async (tx) => {
    const plan = await planImport(tx, userId, parsed.file, opts);
    const summary = summarize(parsed, plan);
    if (!summary.ok) return { ...summary, imported: false };
    await writePlan(tx, userId, parsed.file, plan);
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

/** The account's zone (already checked) wins over the browser's; with neither, UTC. */
function importContext(opts: ImportOptions, accountTimeZone: string | null): ImportContext {
  const unpairedTransfersAsEntries = opts.unpairedTransfersAsEntries === true;
  if (accountTimeZone) {
    return { timeZone: accountTimeZone, timeZoneSource: "account", timeZoneFallback: false, unpairedTransfersAsEntries };
  }
  const sent = typeof opts.timeZone === "string" && opts.timeZone.trim() !== "";
  const { timeZone, fallback } = resolveTimeZone(opts.timeZone);
  return { timeZone, timeZoneSource: sent && !fallback ? "browser" : "none", timeZoneFallback: fallback, unpairedTransfersAsEntries };
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
export function parseImportFile(fileText: string, opts: ImportOptions = {}, accountTimeZone: string | null = null): ParsedFile {
  return parseImportFiles(fileText, opts, accountTimeZone).file;
}

/**
 * Parse a selection into one `ParsedFile`: limits on the whole selection, identical files used once, a backup only
 * on its own, each file parsed by its detected format, then merged (wallets by name + currency, categories by
 * kind + name) and finished by each format's `finalize` (Spendee pairs transfer rows across files here).
 * `accountTimeZone` is the account's zone (`getUserTimeZone`), which takes precedence over `opts.timeZone`.
 */
export function parseImportFiles(
  input: ImportInput,
  opts: ImportOptions = {},
  accountTimeZone: string | null = null,
): ParsedSelection {
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
  const ctx = importContext(opts, accountTimeZone);

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
        brokenTransferRows: parsed.brokenTransferRows.map((b) => ({ ...b, loc: tag(b.loc) })),
        wallets: parsed.wallets.map((w) => ({
          ...w,
          ...(w.detailsLoc ? { detailsLoc: tag(w.detailsLoc) } : {}),
          ...(w.groupLoc ? { groupLoc: tag(w.groupLoc) } : {}),
        })),
      });
      return;
    }
    const walletMap = parsed.wallets.map((w) => merger.walletFor(w.name, w.currency));
    parsed.wallets.forEach((w, k) => mergeWalletDetails(combined, walletMap[k], w, tag));
    const categoryMap = parsed.categories.map((c) => merger.categoryFor(c.kind, c.name));
    parsed.categories.forEach((c, k) => mergeCategoryDetails(combined, categoryMap[k], c, tag));
    const tagMap = parsed.tags.map((t) => merger.tagFor(t.name));
    parsed.tags.forEach((t, k) => {
      if (t.listed) combined.tags[tagMap[k]].listed = true;
    });
    combined.entries.push(
      ...parsed.entries.map((e) => ({
        ...e,
        wallet: walletMap[e.wallet],
        category: categoryMap[e.category],
        ...(e.tags ? { tags: e.tags.map((i) => tagMap[i]) } : {}),
        loc: tag(e.loc),
      })),
    );
    combined.transfers.push(
      ...parsed.transfers.map((t) => ({ ...t, from: walletMap[t.from], to: walletMap[t.to], loc: tag(t.loc) })),
    );
    combined.transferLegs.push(...parsed.transferLegs.map((l) => ({ ...l, wallet: walletMap[l.wallet], loc: tag(l.loc) })));
    combined.brokenTransferRows.push(...parsed.brokenTransferRows.map((b) => ({ ...b, loc: tag(b.loc) })));
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

const where = (loc: Loc | undefined) =>
  loc ? `${loc.file ? `“${loc.file}”, ` : ""}${loc.line !== undefined ? `line ${loc.line}` : (loc.path ?? "")}` : "another row";

/**
 * Merging a file's wallet into the selection's: its details (a CSV wallet row) and group are taken when the selection
 * has none yet; two files that describe the same wallet differently are a problem at the later one.
 */
function mergeWalletDetails(combined: ParsedFile, idx: number, src: WalletSpec, tag: <T extends object>(x: T) => T) {
  const dst = combined.wallets[idx];
  const label = `“${dst.name}” (${dst.currency})`;
  if (src.detailsLoc) {
    if (!dst.detailsLoc) {
      dst.initialBalanceMinor = src.initialBalanceMinor;
      dst.archived = src.archived;
      if (src.archivedAt) dst.archivedAt = src.archivedAt;
      dst.detailsLoc = tag(src.detailsLoc);
    } else if (
      dst.initialBalanceMinor !== src.initialBalanceMinor ||
      dst.archived !== src.archived ||
      (dst.archivedAt ?? null) !== (src.archivedAt ?? null)
    ) {
      combined.problems.push(
        tag({ ...src.detailsLoc, message: `wallet: Wallet ${label} is described differently in ${where(dst.detailsLoc)}.` }),
      );
    }
  }
  if (src.group !== undefined) {
    if (dst.group === undefined) {
      dst.group = src.group;
      dst.groupLoc = src.groupLoc ? tag(src.groupLoc) : undefined;
    } else if (dst.group.toLowerCase() !== src.group.toLowerCase()) {
      combined.problems.push(
        tag({
          ...(src.groupLoc ?? {}),
          message: `group: Wallet ${label} is put in group “${dst.group}” in ${where(dst.groupLoc)}; a wallet can only be in one group.`,
        }),
      );
    }
  }
}

/** As `mergeWalletDetails`, for a CSV category row (kind + archived date): the first file's wins, a different one is a problem. */
function mergeCategoryDetails(combined: ParsedFile, idx: number, src: CategorySpec, tag: <T extends object>(x: T) => T) {
  if (!src.detailsLoc) return;
  const dst = combined.categories[idx];
  if (!dst.detailsLoc) {
    dst.archived = src.archived;
    if (src.archivedAt) dst.archivedAt = src.archivedAt;
    dst.detailsLoc = tag(src.detailsLoc);
  } else if (Boolean(dst.archived) !== Boolean(src.archived) || (dst.archivedAt ?? null) !== (src.archivedAt ?? null)) {
    combined.problems.push(
      tag({
        ...src.detailsLoc,
        message: `category: Category “${dst.name}” (${dst.kind}) is described differently in ${where(dst.detailsLoc)}.`,
      }),
    );
  }
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

/**
 * `archived`: the account's wallet takes no new entries (it is archived, or its group is: then `archivedGroup` names
 * the group).
 */
type WalletTarget = { id: number | null; archived: boolean; archivedGroup?: string };

type Plan = {
  walletTargets: WalletTarget[]; // per file wallet; id null → created
  /** File wallet indexes to create, in file order. */
  walletsToCreate: number[];
  /** Per file wallet to create: the target group's name, and its id (null → it is in `groupsToCreate`). */
  walletGroups: Map<number, { name: string; id: number | null }>;
  /**
   * Group names to create (first spelling wins): a backup's `groups` list first (its order), then the groups only
   * wallets name, in file order.
   */
  groupsToCreate: string[];
  /** Colour and archived state of a group to create, by lower-cased name (from the backup's `groups` list). */
  groupDetails: Map<string, GroupSpec>;
  /** Per file category: the existing id, or null when it will be created. */
  categoryTargets: (number | null)[];
  /** Per file category: true when it matched an archived category of the account. */
  categoryArchived: boolean[];
  categoriesToCreate: number[];
  manualRatesToAdd: ManualRateSpec[];
  /** Per file repeating entry: the account's identical rule (skipped, entries link to it), or null → created. */
  recurringTargets: (number | null)[];
  /** File repeating-entry indexes to create, in file order. */
  recurringToCreate: number[];
  budgetsToAdd: BudgetSpec[];
  /** Non-blocking notes from planning (e.g. rates the account already had for a date). */
  notices: ImportNotice[];
  /** File tag indexes the account lacks that the import creates (used by an added entry, or listed by a backup). */
  tagsToCreate: number[];
  entriesToAdd: EntrySpec[];
  transfersToAdd: TransferSpec[];
  duplicateTransactions: number;
  duplicateTransfers: number;
  problems: ImportProblem[];
};

async function planImport(tx: DBOrTx, userId: number, parsed: ParsedFile, opts: ImportOptions): Promise<Plan> {
  const skipDuplicates = opts.skipDuplicates ?? true;
  const problems: ImportProblem[] = [];

  // Wallets ------------------------------------------------------------------------------------------
  // A wallet of an archived group counts as archived (as in the entry services): it takes no new entries.
  const existingWallets = await tx
    .select({
      id: wallets.id,
      name: wallets.name,
      currency: wallets.currency,
      archivedAt: wallets.archivedAt,
      groupName: walletGroups.name,
      groupArchivedAt: walletGroups.archivedAt,
    })
    .from(wallets)
    .innerJoin(walletGroups, eq(walletGroups.id, wallets.groupId))
    .where(eq(wallets.userId, userId))
    .orderBy(wallets.id);
  const candidates = new Map<string, (WalletTarget & { id: number })[]>();
  for (const w of existingWallets) {
    const key = walletKey(w.name, w.currency);
    const list = candidates.get(key) ?? [];
    const archivedGroup = w.archivedAt === null && w.groupArchivedAt !== null ? w.groupName : undefined;
    list.push({ id: w.id, archived: w.archivedAt !== null || archivedGroup !== undefined, archivedGroup });
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
      ? await getDefaultGroupId(userId, tx)
      : (await getOpenGroupRow(userId, assertId(opts.groupId, "groupId", "group"), tx)).id;
  parsed.wallets.forEach((w, i) => {
    const k = used.get(w.key) ?? 0;
    used.set(w.key, k + 1);
    const match = candidates.get(w.key)?.[parsed.walletMatching === "by-position" ? k : 0];
    if (match) walletTargets.push(match);
    else {
      walletTargets.push({ id: null, archived: false });
      walletsToCreate.push(i);
    }
  });

  // Groups of the wallets to create -----------------------------------------------------------------
  const groupRows = await tx
    .select({ id: walletGroups.id, name: walletGroups.name })
    .from(walletGroups)
    .where(eq(walletGroups.userId, userId))
    .orderBy(walletGroups.id);
  const groupByFolded = new Map(groupRows.map((g) => [g.name.toLowerCase(), g]));
  const targetGroup = groupRows.find((g) => g.id === targetGroupId)!;
  const walletGroups_ = new Map<number, { name: string; id: number | null }>();
  const groupsToCreate: string[] = [];
  const plannedGroups = new Set<string>();
  // A backup's own list: every group it names that the account lacks is created (empty ones too), in its order.
  const groupDetails = new Map<string, GroupSpec>();
  for (const g of parsed.groups ?? []) {
    const folded = g.name.toLowerCase();
    if (groupByFolded.has(folded) || plannedGroups.has(folded)) continue;
    plannedGroups.add(folded);
    groupsToCreate.push(g.name);
    groupDetails.set(folded, g);
  }
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
  const existingCategories = new Map<string, { id: number; archived: boolean }>();
  for (const c of await tx
    .select({ id: categories.id, name: categories.name, kind: categories.kind, archivedAt: categories.archivedAt })
    .from(categories)
    .where(eq(categories.userId, userId))
    .orderBy(categories.id)) {
    const key = categoryKey(c.kind, c.name);
    if (!existingCategories.has(key)) existingCategories.set(key, { id: c.id, archived: c.archivedAt !== null });
  }
  const categoryTargets = parsed.categories.map((c) => existingCategories.get(c.key)?.id ?? null);
  const categoryArchived = parsed.categories.map((c) => existingCategories.get(c.key)?.archived ?? false);
  const categoriesToCreate = categoryTargets.flatMap((id, i) => (id === null ? [i] : []));

  // Manual exchange rates (backup): added when the account has none for that currency and date; an existing one is
  // kept, even when it differs (import adds, never changes).
  const manualRatesToAdd: ManualRateSpec[] = [];
  const notices: ImportNotice[] = [];
  if (parsed.manualRates?.length) {
    const existingRates = new Map(
      (
        await tx
          .select({ currency: manualRates.currency, effectiveDate: manualRates.effectiveDate, base: manualRates.base, rate: manualRates.rate })
          .from(manualRates)
          .where(eq(manualRates.userId, userId))
      ).map((r) => [`${r.currency}|${r.effectiveDate}`, r]),
    );
    let kept = 0;
    for (const r of parsed.manualRates) {
      const existing = existingRates.get(`${r.currency}|${r.effectiveDate}`);
      if (!existing) manualRatesToAdd.push(r);
      else if (existing.base !== r.base || parseRateInput(existing.rate) !== r.rate) kept++;
    }
    if (kept > 0) {
      notices.push({
        code: "manual-rates-kept",
        count: kept,
        message:
          `${kept === 1 ? "1 exchange rate" : `${fmtCount(kept)} exchange rates`} in the backup differ from the rate you ` +
          `already have for that currency and date; your own ${kept === 1 ? "is" : "are"} kept. Change ${kept === 1 ? "it" : "them"} on the Rates page if needed.`,
      });
    }
  }

  // Repeating entries (backup): one the account already has — same wallet, category, amount, note and schedule —
  // is skipped (its next date and paused state are the account's own); any other is created (import adds, never
  // changes). A rule whose wallet or category is created by this import is always new.
  const recurringTargets: (number | null)[] = [];
  const recurringToCreate: number[] = [];
  if (parsed.recurring?.length) {
    const existingRules = await tx
      .select()
      .from(recurringTransactions)
      .where(eq(recurringTransactions.userId, userId))
      .orderBy(recurringTransactions.id);
    const taken = new Set<number>();
    parsed.recurring.forEach((r, i) => {
      const walletId = walletTargets[r.wallet].id;
      const categoryId = categoryTargets[r.category];
      const same = existingRules.find(
        (e) =>
          !taken.has(e.id) &&
          e.walletId === walletId &&
          e.categoryId === categoryId &&
          e.kind === r.kind &&
          e.amountMinor === r.amountMinor &&
          e.note === r.note &&
          e.frequency === r.frequency &&
          e.interval === r.interval &&
          e.startDate === r.startDate &&
          e.endDate === r.endDate,
      );
      if (same) taken.add(same.id);
      else recurringToCreate.push(i);
      recurringTargets.push(same?.id ?? null);
    });
  }

  // Budgets (backup): added for the overall budget and for categories (existing or created) that have none; an
  // existing budget is kept, even when the file's differs (import adds, never changes; as the rates above).
  const budgetsToAdd: BudgetSpec[] = [];
  if (parsed.budgets?.length) {
    const existingBudgets = new Map(
      (
        await tx
          .select({ categoryId: budgets.categoryId, currency: budgets.currency, amountMinor: budgets.amountMinor })
          .from(budgets)
          .where(eq(budgets.userId, userId))
      ).map((b) => [b.categoryId, b]),
    );
    let kept = 0;
    for (const b of parsed.budgets) {
      const target = b.category === null ? null : categoryTargets[b.category];
      const existing = b.category !== null && target === null ? undefined : existingBudgets.get(target);
      if (!existing) budgetsToAdd.push(b);
      else if (existing.currency !== b.currency || existing.amountMinor !== b.amountMinor) kept++;
    }
    if (kept > 0) {
      notices.push({
        code: "budgets-kept",
        count: kept,
        message:
          `${kept === 1 ? "1 budget" : `${fmtCount(kept)} budgets`} in the backup differ from the budget you already have ` +
          `for that category; your own ${kept === 1 ? "is" : "are"} kept. Change ${kept === 1 ? "it" : "them"} on the Categories page if needed.`,
      });
    }
  }

  // Existing entries as multisets (only needed when skipping duplicates) ------------------------------
  // In a CSV a wallet *is* its name + currency, so two same-named wallets of the account count as one for
  // duplicate detection (re-importing an export of such an account must still add nothing). A backup keeps
  // wallets apart by id.
  const keyById = new Map(existingWallets.map((w) => [w.id, walletKey(w.name, w.currency)]));
  const ident = (walletId: number) => (parsed.walletMatching === "merge" ? keyById.get(walletId)! : String(walletId));
  const entryCounts = new Map<string, number>();
  const transferCounts = new Map<string, number>();
  if (skipDuplicates) {
    const groups = await tx
      .select({
        walletId: transactions.walletId,
        kind: transactions.kind,
        categoryId: transactions.categoryId,
        date: transactions.date,
        amountMinor: transactions.amountMinor,
        note: transactions.note,
        n: sql<number>`count(*)`.mapWith(Number),
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
      );
    for (const g of groups) {
      const key = entryKey(ident(g.walletId), g.kind, g.categoryId!, g.date, g.amountMinor, g.note);
      entryCounts.set(key, (entryCounts.get(key) ?? 0) + g.n);
    }
    for (const t of await listTransferRows(userId, tx)) {
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
    const group = walletTargets[fileWallet].archivedGroup;
    problems.push({
      ...loc,
      message:
        group === undefined
          ? `Wallet “${w.name}” (${w.currency}) is archived in your account, so nothing new can be added to it. ` +
            "Unarchive it first, or remove these rows."
          : `Wallet “${w.name}” (${w.currency}) is in the archived group “${group}” in your account, so nothing new ` +
            "can be added to it. Unarchive the group first, or remove these rows.",
    });
  };
  // Same rule for categories: an archived category of the account takes no new entries (duplicates still skip).
  const archivedCategoryProblem = (loc: Loc, fileCategory: number) => {
    const c = parsed.categories[fileCategory];
    problems.push({
      ...loc,
      message:
        `Category “${c.name}” (${c.kind}) is archived in your account, so nothing new can be added to it. ` +
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
    else if (categoryArchived[e.category]) archivedCategoryProblem(e.loc, e.category);
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

  // Tags: matched by name ignoring case; a missing one is created when an entry the import adds carries it, or when a
  // backup lists it. A duplicate entry adds nothing, not even its tags (import adds, never changes).
  const existingTagIds = new Map<string, number>();
  if (parsed.tags.length > 0) {
    for (const t of await tx.select({ id: tags.id, name: tags.name }).from(tags).where(eq(tags.userId, userId))) {
      existingTagIds.set(tagKey(t.name), t.id);
    }
  }
  const neededTags = new Set<number>(parsed.tags.flatMap((t, i) => (t.listed ? [i] : [])));
  for (const e of entriesToAdd) for (const i of e.tags ?? []) neededTags.add(i);
  const tagsToCreate = [...neededTags].filter((i) => !existingTagIds.has(parsed.tags[i].key)).sort((a, b) => a - b);

  // Report problems in file order (entries and transfers are interleaved in a CSV).
  const sortedProblems = sortByLocation(problems);

  return {
    walletTargets,
    walletsToCreate,
    walletGroups: walletGroups_,
    groupsToCreate,
    groupDetails,
    categoryTargets,
    categoryArchived,
    categoriesToCreate,
    manualRatesToAdd,
    recurringTargets,
    recurringToCreate,
    budgetsToAdd,
    notices,
    tagsToCreate,
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
      return {
        name: w.name,
        currency: w.currency,
        archived: w.archived,
        group: plan!.walletGroups.get(i)!.name,
        described: w.detailsLoc !== undefined,
      };
    }),
    groupsToCreate: plan?.groupsToCreate ?? [],
    categoriesToCreate: (plan?.categoriesToCreate ?? []).map((i) => ({
      name: parsed.categories[i].name,
      kind: parsed.categories[i].kind,
      ...(parsed.categories[i].archived ? { archived: true as const } : {}),
    })),
    manualRatesToAdd: plan?.manualRatesToAdd.length ?? 0,
    recurringToAdd: plan?.recurringToCreate.length ?? 0,
    duplicateRecurring: plan ? plan.recurringTargets.length - plan.recurringToCreate.length : 0,
    budgetsToAdd: plan?.budgetsToAdd.length ?? 0,
    tagsToCreate: (plan?.tagsToCreate ?? []).map((i) => parsed.tags[i].name),
    problems: problems.slice(0, MAX_PROBLEMS_SHOWN).map(publicLocation),
    problemCount: problems.length,
    notices: [...parsed.notices, ...(plan?.notices ?? [])].map(publicLocation),
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

/** Rows per multi-row INSERT: 9 bound columns × 1000 stays far below Postgres' 65 535 bind-parameter limit. */
const CHUNK = 1000;

function chunks<T>(items: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function writePlan(tx: DBOrTx, userId: number, parsed: ParsedFile, plan: Plan): Promise<void> {
  const now = new Date();

  const createdGroupIds = new Map<string, number>();
  let position = await nextGroupPosition(tx, userId);
  for (const name of plan.groupsToCreate) {
    const details = plan.groupDetails.get(name.toLowerCase());
    const [group] = await tx
      .insert(walletGroups)
      .values({
        userId,
        name,
        position: position++,
        color: details?.color ?? null,
        archivedAt: details?.archived ? now : null,
        createdAt: now,
      })
      .returning({ id: walletGroups.id });
    createdGroupIds.set(name.toLowerCase(), group.id);
  }

  const walletIds = plan.walletTargets.map((t) => t.id);
  for (const i of plan.walletsToCreate) {
    const w = parsed.wallets[i];
    const target = plan.walletGroups.get(i)!;
    const [created] = await tx
      .insert(wallets)
      .values({
        userId,
        groupId: target.id ?? createdGroupIds.get(target.name.toLowerCase())!,
        name: w.name,
        currency: w.currency,
        initialBalanceMinor: w.initialBalanceMinor,
        // A backup (or a CSV wallet row) restores archived wallets as archived (their history is inserted below, bypassing the
        // "no new transactions on archived wallets" rule on purpose: it is a restore, not new activity).
        // The original archived date when the file has one (backup `archivedAt`, CSV `archived`), else the import's.
        archivedAt: w.archived ? (w.archivedAt ? new Date(w.archivedAt) : now) : null,
        createdAt: now,
      })
      .returning({ id: wallets.id });
    walletIds[i] = created.id;
  }

  const categoryIds = [...plan.categoryTargets];
  for (const i of plan.categoriesToCreate) {
    const c = parsed.categories[i];
    const [created] = await tx
      .insert(categories)
      // An archived category (backup flag, CSV category row) is restored archived, with its history (a restore, as for
      // wallets), on the file's date when it has one, else as of the import.
      .values({
        userId,
        name: c.name,
        kind: c.kind,
        archivedAt: c.archived ? (c.archivedAt ? new Date(c.archivedAt) : now) : null,
        // A backup's colour, only on the categories the import creates (existing ones keep theirs).
        color: c.color ?? null,
        createdAt: now,
      })
      .returning({ id: categories.id });
    categoryIds[i] = created.id;
  }

  if (plan.budgetsToAdd.length > 0) {
    await tx
      .insert(budgets)
      .values(
        plan.budgetsToAdd.map((b) => ({
          userId,
          categoryId: b.category === null ? null : categoryIds[b.category]!,
          currency: b.currency,
          amountMinor: b.amountMinor,
          createdAt: now,
        })),
      )
      // Planned against this transaction's snapshot; a budget set meanwhile is kept.
      .onConflictDoNothing();
  }

  for (const chunk of chunks(plan.manualRatesToAdd)) {
    await tx
      .insert(manualRates)
      .values(chunk.map((r) => ({ userId, currency: r.currency, base: r.base, effectiveDate: r.effectiveDate, rate: r.rate, createdAt: now })))
      // Planned against this transaction's snapshot; a rate set meanwhile for the same date is kept.
      .onConflictDoNothing({ target: [manualRates.userId, manualRates.currency, manualRates.effectiveDate] });
  }

  // Repeating entries before the entries that link to them. Created as the file has them (next date, paused); a
  // next date already past is caught up by the next request, like any rule.
  const recurringIds = [...plan.recurringTargets];
  for (const i of plan.recurringToCreate) {
    const r = parsed.recurring![i];
    const [created] = await tx
      .insert(recurringTransactions)
      .values({
        userId,
        walletId: walletIds[r.wallet]!,
        kind: r.kind,
        categoryId: categoryIds[r.category]!,
        amountMinor: r.amountMinor,
        note: r.note,
        frequency: r.frequency,
        interval: r.interval,
        startDate: r.startDate,
        endDate: r.endDate,
        nextDate: r.nextDate,
        pausedAt: r.paused && r.nextDate !== null ? now : null,
        createdAt: now,
      })
      .returning({ id: recurringTransactions.id });
    recurringIds[i] = created.id;
  }

  // Tags: the ones to create (unused ones a backup lists too) and those the added entries carry, by name.
  const tagNames = new Set<number>(plan.tagsToCreate);
  for (const e of plan.entriesToAdd) for (const i of e.tags ?? []) tagNames.add(i);
  const tagIdOf = await ensureTagIds(
    userId,
    [...tagNames].map((i) => parsed.tags[i].name),
    tx,
  );

  for (const chunk of chunks(plan.entriesToAdd)) {
    // Identity values are assigned in VALUES order within one INSERT, so the ascending ids line up with `chunk`.
    const ids = (
      await tx
      .insert(transactions)
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
          recurringId: e.recurring === undefined ? null : recurringIds[e.recurring],
          createdAt: now,
        })),
      )
      .returning({ id: transactions.id })
    )
      .map((r) => r.id)
      .sort((a, b) => a - b);
    if (ids.length !== chunk.length) throw new Error("Transaction insert returned an unexpected number of rows.");
    const links = chunk.flatMap((e, j) =>
      [...new Set((e.tags ?? []).map((i) => tagIdOf.get(parsed.tags[i].name)!))].map((tagId) => ({ transactionId: ids[j], tagId })),
    );
    for (const part of chunks(links, CHUNK * 5)) await tx.insert(transactionTags).values(part);
  }

  for (const chunk of chunks(plan.transfersToAdd, CHUNK / 2)) {
    // Identity values are assigned in VALUES order within one INSERT, so the ascending ids line up with `chunk`.
    const ids = (
      await tx
        .insert(transfers)
        .values(chunk.map((t) => ({ userId, date: t.date, note: t.note, createdAt: now })))
        .returning({ id: transfers.id })
    )
      .map((r) => r.id)
      .sort((a, b) => a - b);
    if (ids.length !== chunk.length) throw new Error("Transfer insert returned an unexpected number of rows.");
    await tx
      .insert(transactions)
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
      );
  }
}
