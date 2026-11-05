import "server-only";
import type { CategoryKind } from "@/db/schema";
import { parseCsv, type CsvRecord } from "@/lib/csv";
import { isValidCurrency } from "@/lib/currencies";
import { IMPORT_MAX_ROWS } from "@/lib/constants";
import { isServiceError } from "@/lib/errors";
import { currencyDecimals } from "@/lib/money";
import { MAX_CATEGORY_NAME_LENGTH } from "../categories";
import { normalizeName } from "../_validate";

// The importer's format-agnostic parsed form, and the helpers the format parsers share. A format module turns a
// file into a `ParsedFile`; planning, duplicate detection and writing (src/server/import.ts) only see this.

/** One thing wrong with the file: a CSV line number or a JSON path, plus a readable message. Blocks the import. */
export type ImportProblem = { line?: number; path?: string; message: string };

/**
 * Something the user should know about the file that does not block the import (e.g. amounts that were rounded).
 * `code` is stable for tests and the UI; `count` is how many rows it concerns.
 */
export type ImportNotice = { code: string; message: string; count?: number };

export type ImportFormatId = "backup" | "csv" | "spendee";

export type Loc = { line?: number; path?: string };

export type WalletSpec = {
  name: string;
  currency: string;
  initialBalanceMinor: number;
  archived: boolean;
  /** lower(name) + currency: how wallets are matched against the account. */
  key: string;
};
export type CategorySpec = { name: string; kind: CategoryKind; key: string };
export type EntrySpec = {
  kind: CategoryKind;
  wallet: number; // index into wallets
  category: number; // index into categories
  amountMinor: number;
  date: string;
  note: string | null;
  loc: Loc;
};
export type TransferSpec = {
  from: number;
  to: number;
  amountMinor: number;
  receivedAmountMinor: number;
  date: string;
  note: string | null;
  loc: Loc;
};

export type ParsedFile = {
  format: ImportFormatId | null;
  /**
   * `by-position`: backup — the k-th file wallet with a given name + currency matches the k-th such wallet in the
   * account (by id), so two same-named wallets survive a round trip. `merge`: CSV — wallets are only identified
   * by name + currency, one file wallet per key, matched to an active wallet when there is one.
   */
  walletMatching: "by-position" | "merge";
  wallets: WalletSpec[];
  categories: CategorySpec[];
  entries: EntrySpec[];
  transfers: TransferSpec[];
  problems: ImportProblem[];
  notices: ImportNotice[];
};

/** What a format module gets to look at when deciding whether a file is its own. */
export type ImportSource = {
  /** The file as uploaded (parsers that use `parseCsv` take this; it strips the BOM itself). */
  text: string;
  /** BOM stripped, leading whitespace trimmed. Never empty. */
  body: string;
  /** Header cells of the file read as CSV (trimmed, lower-cased); computed on first use. */
  csvHeader(): string[];
};

/** A file format the importer understands: one module per format, registered in src/server/import.ts. */
export type ImportFormat = {
  id: ImportFormatId;
  /** Shown in the preview, e.g. "Spendee export". */
  label: string;
  detect(source: ImportSource): boolean;
  parse(source: ImportSource): ParsedFile;
};

export const walletKey = (name: string, currency: string) => `${name.toLowerCase()}\u0000${currency}`;
export const categoryKey = (kind: string, name: string) => `${kind}\u0000${name.toLowerCase()}`;

export function emptyParsed(format: ParsedFile["format"], problems: ImportProblem[] = []): ParsedFile {
  return {
    format,
    walletMatching: "merge",
    wallets: [],
    categories: [],
    entries: [],
    transfers: [],
    problems,
    notices: [],
  };
}

/** Run a `_validate` helper and turn its ServiceError into a problem message. */
export function check<T>(fn: () => T, onError: (message: string) => void): T | undefined {
  try {
    return fn();
  } catch (err) {
    if (!isServiceError(err)) throw err;
    onError(err.message);
    return undefined;
  }
}

export const normalizeWalletName = (v: unknown) => normalizeName(v, "name");
export const normalizeCategoryName = (v: unknown) => normalizeName(v, "name", MAX_CATEGORY_NAME_LENGTH);

export function amountHint(currency: string): string {
  const d = currencyDecimals(currency);
  return d === 0 ? `${currency} has no decimals` : `${currency} allows up to ${d} decimal${d === 1 ? "" : "s"}`;
}

export function fmtCount(n: number): string {
  return n.toLocaleString("en-US");
}

/** A currency cell: trimmed, upper-cased, must be a supported ISO 4217 code. */
export function currencyCell(raw: string, column: string, problem: (c: string, m: string) => void): string | null {
  const code = raw.trim().toUpperCase();
  if (!code) {
    problem(column, "Required: a 3-letter currency code such as EUR.");
    return null;
  }
  if (!isValidCurrency(code)) {
    problem(column, `“${raw.trim()}” is not a supported ISO 4217 currency code.`);
    return null;
  }
  return code;
}

/**
 * For spreadsheet-like formats, where a wallet *is* its name + currency and a category its kind + name: one file
 * wallet / category per key, created on first use.
 */
export function specBuilder(out: ParsedFile) {
  const walletByKey = new Map<string, number>();
  const categoryByKey = new Map<string, number>();
  return {
    walletFor(name: string, currency: string): number {
      const key = walletKey(name, currency);
      let idx = walletByKey.get(key);
      if (idx === undefined) {
        idx = out.wallets.length;
        walletByKey.set(key, idx);
        out.wallets.push({ name, currency, initialBalanceMinor: 0, archived: false, key });
      }
      return idx;
    },
    categoryFor(kind: CategoryKind, name: string): number {
      const key = categoryKey(kind, name);
      let idx = categoryByKey.get(key);
      if (idx === undefined) {
        idx = out.categories.length;
        categoryByKey.set(key, idx);
        out.categories.push({ name, kind, key });
      }
      return idx;
    },
  };
}

/**
 * Read a CSV file with a header row: quoting errors, an empty file, missing required columns and the row limit
 * become problems on `out` (and `null` is returned). Otherwise returns the column positions (by lower-cased
 * header name; the first occurrence wins) and the non-blank data rows.
 */
export function readCsvTable<C extends string>(
  text: string,
  out: ParsedFile,
  columns: { required: readonly C[]; optional: readonly C[]; describe: (missing: C[]) => string },
): { col: Map<C, number>; rows: CsvRecord[] } | null {
  const { records, errors } = parseCsv(text);
  if (errors.length) {
    out.problems.push(...errors.map((e) => ({ line: e.line, message: e.message })));
    return null;
  }
  const [header, ...rest] = records;
  if (!header) {
    out.problems.push({ message: "The file is empty." });
    return null;
  }
  const known = new Set<string>([...columns.required, ...columns.optional]);
  const col = new Map<C, number>();
  header.cells.forEach((cell, i) => {
    const name = cell.trim().toLowerCase() as C;
    if (known.has(name) && !col.has(name)) col.set(name, i);
  });
  const missing = columns.required.filter((c) => !col.has(c));
  if (missing.length) {
    out.problems.push({ line: header.line, message: columns.describe(missing) });
    return null;
  }
  const rows = rest.filter((r) => r.cells.some((c) => c.trim() !== ""));
  if (rows.length > IMPORT_MAX_ROWS) {
    out.problems.push({
      message: `The file has ${fmtCount(rows.length)} rows; the limit is ${fmtCount(IMPORT_MAX_ROWS)} per import. Split it into smaller files.`,
    });
    return null;
  }
  return { col, rows };
}

/** Cell accessor for one row: an absent column or a short row reads as "". */
export function cellReader<C extends string>(col: Map<C, number>, cells: string[]) {
  return (c: C) => {
    const i = col.get(c);
    return i === undefined ? "" : (cells[i] ?? "");
  };
}
