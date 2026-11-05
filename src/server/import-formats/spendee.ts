import "server-only";
import type { CategoryKind } from "@/db/schema";
import { isValidDate } from "@/lib/dates";
import { currencyDecimals, minorToInputValue, parseDecimalRounded } from "@/lib/money";
import { normalizeNote } from "../_validate";
import {
  cellReader,
  check,
  currencyCell,
  emptyParsed,
  fmtCount,
  normalizeCategoryName,
  normalizeWalletName,
  readCsvTable,
  specBuilder,
  type ImportFormat,
  type ParsedFile,
} from "./shared";

// Spendee's CSV export (docs/SPEC.md → "Provider formats"):
//   "Date";"Wallet";"Type";"Category name";"Amount";"Currency";"Notes";"First name";"Last name"
//   "2019-04-29 21:10:33";"Personal Account";"expense";"Food";"-30";"RON";"Mc";"Jane";"Doe"
// `;`-separated, fully quoted, UTF-8, CRLF (the shared CSV reader handles all of that). Amounts are signed and may
// carry more decimals than the currency has; they are rounded half away from zero.

/** Lower-cased header name → how it is written in the file (used in problem messages). */
const COLUMN_LABELS = {
  date: "Date",
  wallet: "Wallet",
  type: "Type",
  "category name": "Category name",
  amount: "Amount",
  currency: "Currency",
  notes: "Notes",
} as const;
type Column = keyof typeof COLUMN_LABELS;
const REQUIRED_COLUMNS: Column[] = ["date", "wallet", "type", "category name", "amount", "currency"];
const OPTIONAL_COLUMNS: Column[] = ["notes"];

export const spendeeFormat: ImportFormat = {
  id: "spendee",
  label: "Spendee export",
  // A `Category name` column and no `category` column: the native CSV never has the former, Spendee never the latter.
  detect: (source) => {
    if (source.body[0] === "{" || source.body[0] === "[") return false;
    const header = source.csvHeader();
    return header.includes("category name") && !header.includes("category");
  },
  parse: ({ text }) => parseSpendeeCsv(text),
};

/** `YYYY-MM-DD HH:MM:SS` (or `HH:MM`, or no time) → the date part as written, else null. */
export function parseSpendeeDate(value: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(value.trim());
  if (!m || !isValidDate(m[1])) return null;
  if (m[2] !== undefined && (Number(m[2]) > 23 || Number(m[3]) > 59 || Number(m[4] ?? 0) > 59)) return null;
  return m[1];
}

function parseSpendeeCsv(fileText: string): ParsedFile {
  const out = emptyParsed("spendee");
  const table = readCsvTable<Column>(fileText, out, {
    required: REQUIRED_COLUMNS,
    optional: OPTIONAL_COLUMNS,
    describe: (missing) =>
      `This looks like a Spendee export, but it is missing the column${missing.length === 1 ? "" : "s"} ` +
      `${missing.map((c) => COLUMN_LABELS[c]).join(", ")}. Spendee's header is ` +
      `${[...REQUIRED_COLUMNS, ...OPTIONAL_COLUMNS].map((c) => COLUMN_LABELS[c]).join(", ")} (other columns are ignored).`,
  });
  if (!table) return out;
  const { walletFor, categoryFor } = specBuilder(out);
  /** Rounded amounts per currency, for the notice. */
  const rounded = new Map<string, number>();

  for (const { line, cells } of table.rows) {
    const problemsBefore = out.problems.length;
    const problem = (column: string, message: string) => out.problems.push({ line, message: `${column}: ${message}` });
    const get = cellReader(table.col, cells);

    const rawDate = get("date").trim();
    const date = parseSpendeeDate(rawDate);
    if (!date) {
      problem(
        "Date",
        rawDate
          ? `“${rawDate}” is not a valid date. Expected YYYY-MM-DD HH:MM:SS (2019-04-29 21:10:33) or YYYY-MM-DD.`
          : "Required.",
      );
    }

    const rawType = get("type").trim();
    const type = rawType.toLowerCase() === "expense" || rawType.toLowerCase() === "income" ? (rawType.toLowerCase() as CategoryKind) : null;
    if (!type) {
      problem(
        "Type",
        rawType
          ? `“${rawType}” is not supported. Only expense and income rows can be imported (transfers are not supported).`
          : "Required: expense or income.",
      );
    }

    const walletName = check(() => normalizeWalletName(get("wallet")), (m) => problem("Wallet", m === "Enter a name." ? "Required." : m));
    const currency = currencyCell(get("currency"), "Currency", problem);

    let amountMinor: number | null = null;
    let wasRounded = false;
    const rawAmount = get("amount").trim();
    if (!rawAmount) problem("Amount", "Required.");
    else if (currency) {
      const parsed = parseDecimalRounded(rawAmount, currency);
      if (!parsed) {
        problem("Amount", `“${rawAmount}” is not a valid amount (expected a number with a dot, like -30.50).`);
      } else if (parsed.minor === 0) {
        problem(
          "Amount",
          parsed.rounded
            ? `“${rawAmount}” rounds to ${minorToInputValue(0, currency)} ${currency}; amounts must be greater than zero.`
            : "Must not be zero.",
        );
      } else if (type === "expense" && !parsed.negative) {
        problem("Amount", `“${rawAmount}” is positive, but the row is an expense (Spendee writes expenses as negative amounts).`);
      } else if (type === "income" && parsed.negative) {
        problem("Amount", `“${rawAmount}” is negative, but the row is an income (Spendee writes income as positive amounts).`);
      } else {
        amountMinor = parsed.minor;
        wasRounded = parsed.rounded;
      }
    }

    const categoryName = check(
      () => normalizeCategoryName(get("category name")),
      (m) => problem("Category name", m === "Enter a name." ? "Required." : m),
    );
    const note = check(() => normalizeNote(get("notes")), (m) => problem("Notes", m));

    if (out.problems.length > problemsBefore) continue;
    if (wasRounded) rounded.set(currency!, (rounded.get(currency!) ?? 0) + 1);
    out.entries.push({
      kind: type!,
      wallet: walletFor(walletName!, currency!),
      category: categoryFor(type!, categoryName!),
      amountMinor: amountMinor!,
      date: date!,
      note: note!,
      loc: { line },
    });
  }

  for (const [currency, count] of rounded) {
    const d = currencyDecimals(currency);
    out.notices.push({
      code: "amounts-rounded",
      count,
      message:
        `${fmtCount(count)} ${count === 1 ? "amount had" : "amounts had"} more decimals than ${currency} allows and ` +
        `${count === 1 ? "was" : "were"} rounded to ${d === 0 ? "whole units" : `${d} decimal${d === 1 ? "" : "s"}`}.`,
    });
  }
  return out;
}
