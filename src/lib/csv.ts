// Small, dependency-free RFC 4180 CSV reader/writer. Pure: safe on the server and in tests.
//
// Reading is tolerant of what spreadsheets do to files: optional UTF-8 BOM, `,` / `;` / tab delimiter
// (detected from the header line), CRLF or LF (or lone CR) line endings, quoted cells with embedded
// delimiters, newlines and doubled quotes. Every record carries the physical line it starts on, so callers can
// report problems as "line 12" even when earlier cells span several lines.

export type CsvDelimiter = "," | ";" | "\t";

export type CsvRecord = {
  /** 1-based physical line the record starts on (the header is usually line 1). */
  line: number;
  cells: string[];
};

export type CsvParseError = { line: number; message: string };

export type CsvParseResult = {
  delimiter: CsvDelimiter;
  /** Records in file order, header included. Completely empty lines are skipped. */
  records: CsvRecord[];
  /** Malformed quoting. When non-empty, `records` stops at the first broken record. */
  errors: CsvParseError[];
};

const BOM = "﻿";
const DELIMITERS: CsvDelimiter[] = [",", ";", "\t"];

export function stripBom(text: string): string {
  return text.startsWith(BOM) ? text.slice(1) : text;
}

/**
 * Pick the delimiter that occurs most often (outside quotes) in the first line. Ties and a line with none of
 * them resolve to `,`.
 */
export function detectDelimiter(text: string): CsvDelimiter {
  const counts = new Map<CsvDelimiter, number>(DELIMITERS.map((d) => [d, 0]));
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (ch === "\n" || ch === "\r")) break;
    else if (!inQuotes && counts.has(ch as CsvDelimiter)) {
      counts.set(ch as CsvDelimiter, counts.get(ch as CsvDelimiter)! + 1);
    }
  }
  let best: CsvDelimiter = ",";
  for (const d of DELIMITERS) if (counts.get(d)! > counts.get(best)!) best = d;
  return best;
}

/**
 * Parse CSV text. `maxRecords` stops early (the result then holds `maxRecords + 1` records so the caller can
 * tell the limit was exceeded without parsing a huge file to the end).
 */
export function parseCsv(
  input: string,
  opts: { delimiter?: CsvDelimiter; maxRecords?: number } = {},
): CsvParseResult {
  const text = stripBom(input);
  const delimiter = opts.delimiter ?? detectDelimiter(text);
  const maxRecords = opts.maxRecords ?? Infinity;
  const records: CsvRecord[] = [];
  const errors: CsvParseError[] = [];

  let line = 1;
  let i = 0;
  const n = text.length;

  while (i < n) {
    const startLine = line;
    const cells: string[] = [];
    let cell = "";
    let endOfRecord = false;

    while (!endOfRecord) {
      if (i >= n) {
        cells.push(cell);
        break;
      }
      const ch = text[i];
      if (ch === '"' && cell === "") {
        // Quoted cell: runs to the next lone quote; `""` is an escaped quote.
        i++;
        const quoteLine = line;
        let closed = false;
        while (i < n) {
          const c = text[i];
          if (c === '"') {
            if (text[i + 1] === '"') {
              cell += '"';
              i += 2;
              continue;
            }
            i++;
            closed = true;
            break;
          }
          if (c === "\r") {
            // CRLF inside a quoted cell is one line break; keep it as \n.
            line++;
            cell += "\n";
            i += text[i + 1] === "\n" ? 2 : 1;
            continue;
          }
          if (c === "\n") line++;
          cell += c;
          i++;
        }
        if (!closed) {
          errors.push({ line: quoteLine, message: "A quoted cell is never closed (missing closing quote)." });
          return { delimiter, records, errors };
        }
        // After the closing quote only a delimiter, a line break or the end of the file may follow.
        const next = text[i];
        if (i < n && next !== delimiter && next !== "\n" && next !== "\r") {
          errors.push({ line, message: "Unexpected text after a closing quote. Quotes inside a cell must be doubled (\"\")." });
          return { delimiter, records, errors };
        }
        continue;
      }
      if (ch === delimiter) {
        cells.push(cell);
        cell = "";
        i++;
        continue;
      }
      if (ch === "\r" || ch === "\n") {
        cells.push(cell);
        i += ch === "\r" && text[i + 1] === "\n" ? 2 : 1;
        line++;
        endOfRecord = true;
        continue;
      }
      // A quote in the middle of an unquoted cell is kept literally (lenient, like spreadsheets).
      cell += ch;
      i++;
    }

    if (cells.length === 1 && cells[0] === "") continue; // blank line
    records.push({ line: startLine, cells });
    if (records.length > maxRecords) break;
  }

  return { delimiter, records, errors };
}

function quoteCell(value: string, delimiter: string): string {
  if (value.includes('"') || value.includes(delimiter) || value.includes("\n") || value.includes("\r")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Serialise rows as CSV: RFC 4180 quoting, CRLF line endings (also after the last row) and a UTF-8 BOM by
 * default so Excel detects the encoding.
 */
export function toCsv(
  rows: readonly (readonly string[])[],
  opts: { delimiter?: CsvDelimiter; bom?: boolean; newline?: string } = {},
): string {
  const delimiter = opts.delimiter ?? ",";
  const newline = opts.newline ?? "\r\n";
  const body = rows.map((r) => r.map((c) => quoteCell(c, delimiter)).join(delimiter)).join(newline);
  return (opts.bom === false ? "" : BOM) + body + (rows.length ? newline : "");
}

// ---------------------------------------------------------------------------------------------------------
// Spreadsheet formula injection.
//
// A text cell that starts with one of these characters can be evaluated as a formula by spreadsheet apps, so
// on export it is prefixed with `'`. A cell that legitimately starts with `'` is prefixed too, so that removing
// exactly one `'` on import restores every exported value exactly ("'quoted" → "''quoted" → "'quoted").

const FORMULA_TRIGGERS = new Set(["=", "+", "-", "@", "\t", "\r", "'"]);

/** Prefix a text cell with `'` when a spreadsheet could read it as a formula (or it already starts with `'`). */
export function escapeFormula(value: string): string {
  return value.length > 0 && FORMULA_TRIGGERS.has(value[0]) ? `'${value}` : value;
}

/** Reverse of `escapeFormula`: drop a leading `'` only when it protects one of the trigger characters. */
export function unescapeFormula(value: string): string {
  return value.length > 1 && value[0] === "'" && FORMULA_TRIGGERS.has(value[1]) ? value.slice(1) : value;
}
