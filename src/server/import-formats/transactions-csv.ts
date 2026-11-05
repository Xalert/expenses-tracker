import "server-only";
import type { CategoryKind } from "@/db/schema";
import { unescapeFormula } from "@/lib/csv";
import { isValidDate } from "@/lib/dates";
import { parseAmount } from "@/lib/money";
import { normalizeNote } from "../_validate";
import {
  amountHint,
  cellReader,
  check,
  currencyCell,
  emptyParsed,
  normalizeCategoryName,
  normalizeWalletName,
  readCsvTable,
  specBuilder,
  walletKey,
  type ImportFormat,
  type ParsedFile,
} from "./shared";

/** The app's own transactions CSV. The fallback: any file no other format claims is read as this. */
export const transactionsCsvFormat: ImportFormat = {
  id: "csv",
  label: "Transactions (CSV)",
  detect: () => true,
  parse: ({ text }) => parseTransactionsCsv(text),
};

const REQUIRED_COLUMNS = ["date", "type", "wallet", "currency", "amount"] as const;
const OPTIONAL_COLUMNS = ["category", "note", "to_wallet", "to_currency", "to_amount"] as const;
type Column = (typeof REQUIRED_COLUMNS)[number] | (typeof OPTIONAL_COLUMNS)[number];

/** `YYYY-MM-DD` or `DD.MM.YYYY` (what European spreadsheets write back) → ISO, else null. */
export function parseImportDate(value: string): string | null {
  const v = value.trim();
  if (isValidDate(v)) return v;
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(v);
  if (!m) return null;
  const iso = `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return isValidDate(iso) ? iso : null;
}

function parseTransactionsCsv(fileText: string): ParsedFile {
  const out = emptyParsed("csv");
  const table = readCsvTable<Column>(fileText, out, {
    required: REQUIRED_COLUMNS,
    optional: OPTIONAL_COLUMNS,
    describe: (missing) =>
      `Missing column${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}. The first line must be a header with ` +
      `${REQUIRED_COLUMNS.join(", ")} (and optionally ${OPTIONAL_COLUMNS.join(", ")}).`,
  });
  if (!table) return out;
  const { walletFor, categoryFor } = specBuilder(out);

  for (const { line, cells } of table.rows) {
    const problemsBefore = out.problems.length;
    const problem = (column: string, message: string) => out.problems.push({ line, message: `${column}: ${message}` });
    const get = cellReader(table.col, cells);
    const textCell = (c: Column) => unescapeFormula(get(c));

    const rawDate = get("date").trim();
    const date = parseImportDate(rawDate);
    if (!date) {
      problem(
        "date",
        rawDate
          ? `“${rawDate}” is not a valid date. Use YYYY-MM-DD (2026-03-31) or DD.MM.YYYY (31.03.2026).`
          : "Required. Use YYYY-MM-DD (2026-03-31) or DD.MM.YYYY (31.03.2026).",
      );
    }

    const rawType = get("type").trim().toLowerCase();
    const type = rawType === "expense" || rawType === "income" || rawType === "transfer" ? rawType : null;
    if (!type) {
      problem("type", rawType ? `“${get("type").trim()}” is not a type. Use expense, income or transfer.` : "Required: expense, income or transfer.");
    }

    const walletName = check(() => normalizeWalletName(textCell("wallet")), (m) => problem("wallet", m));
    const currency = currencyCell(get("currency"), "currency", problem);
    const amount = amountCell(get("amount"), currency, "amount", problem);
    const note = check(() => normalizeNote(textCell("note")), (m) => problem("note", m));

    if (type === "transfer") {
      if (textCell("category").trim()) problem("category", "Transfers have no category; leave it empty.");
      const toName = check(
        () => normalizeWalletName(textCell("to_wallet")),
        (m) => problem("to_wallet", m === "Enter a name." ? "Required for a transfer: the receiving wallet." : m),
      );
      const rawToCurrency = get("to_currency").trim();
      const toCurrency = rawToCurrency ? currencyCell(rawToCurrency, "to_currency", problem) : currency;
      let received: number | null = null;
      const rawTo = get("to_amount").trim();
      if (currency && toCurrency && currency === toCurrency) {
        if (rawTo) {
          received = amountCell(rawTo, toCurrency, "to_amount", problem);
          if (received !== null && amount !== null && received !== amount) {
            problem("to_amount", `Both wallets use ${currency}, so the amount received must equal the amount sent.`);
          }
        }
        received = amount;
      } else if (toCurrency) {
        if (!rawTo) problem("to_amount", `Required: the wallets use different currencies (${currency ?? "?"} → ${toCurrency}).`);
        else received = amountCell(rawTo, toCurrency, "to_amount", problem);
      }
      if (
        walletName !== undefined &&
        toName !== undefined &&
        currency &&
        toCurrency &&
        walletKey(walletName, currency) === walletKey(toName, toCurrency)
      ) {
        problem("to_wallet", "A transfer needs two different wallets.");
      }
      if (out.problems.length > problemsBefore) continue;
      out.transfers.push({
        from: walletFor(walletName!, currency!),
        to: walletFor(toName!, toCurrency!),
        amountMinor: amount!,
        receivedAmountMinor: received!,
        date: date!,
        note: note!,
        loc: { line },
      });
      continue;
    }

    let categoryName: string | undefined;
    if (type) {
      categoryName = check(
        () => normalizeCategoryName(textCell("category")),
        (m) => problem("category", m === "Enter a name." ? `Required for ${type === "expense" ? "an expense" : "an income"}.` : m),
      );
    }
    if (out.problems.length > problemsBefore) continue;
    out.entries.push({
      kind: type as CategoryKind,
      wallet: walletFor(walletName!, currency!),
      category: categoryFor(type as CategoryKind, categoryName!),
      amountMinor: amount!,
      date: date!,
      note: note!,
      loc: { line },
    });
  }
  return out;
}

function amountCell(
  raw: string,
  currency: string | null,
  column: string,
  problem: (c: string, m: string) => void,
): number | null {
  const v = raw.trim();
  if (!v) {
    problem(column, "Required.");
    return null;
  }
  if (v.startsWith("-") || v.startsWith("−")) {
    problem(column, `“${v}”: amounts are positive; the type says which way the money goes.`);
    return null;
  }
  if (!currency) return null; // the currency problem is already reported
  const minor = parseAmount(v, currency);
  if (minor === null) {
    problem(column, `“${v}” is not a valid ${currency} amount (${amountHint(currency)}).`);
    return null;
  }
  if (minor === 0) {
    problem(column, "Must be greater than zero.");
    return null;
  }
  return minor;
}
