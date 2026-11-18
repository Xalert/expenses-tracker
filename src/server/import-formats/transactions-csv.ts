import "server-only";
import type { CategoryKind } from "@/db/schema";
import { unescapeFormula } from "@/lib/csv";
import { isValidDate } from "@/lib/dates";
import { parseAmount } from "@/lib/money";
import { normalizeName, normalizeNote } from "../_validate";
import { MAX_GROUP_NAME_LENGTH } from "../wallet-groups";
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
const OPTIONAL_COLUMNS = ["category", "note", "to_wallet", "to_currency", "to_amount", "group", "archived", "kind"] as const;
/** Cells a `wallet` row must leave empty (it describes a wallet, not money moving). */
const NOT_ON_WALLET_ROWS = ["category", "note", "to_wallet", "to_currency", "to_amount"] as const;
/** Cells a `category` row must leave empty (it describes a category). */
const NOT_ON_CATEGORY_ROWS = ["wallet", "currency", "amount", "note", "to_wallet", "to_currency", "to_amount", "group"] as const;
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
  const walletLabel = (i: number) => `“${out.wallets[i].name}” (${out.wallets[i].currency})`;

  /** The `group` cell names the group of the row's wallet (used when the import creates it); one group per wallet. */
  const setGroup = (wallet: number, group: string | undefined, line: number) => {
    if (group === undefined) return;
    const w = out.wallets[wallet];
    if (w.group === undefined) {
      w.group = group;
      w.groupLoc = { line };
    } else if (w.group.toLowerCase() !== group.toLowerCase()) {
      out.problems.push({
        line,
        message:
          `group: Wallet ${walletLabel(wallet)} is put in group “${w.group}” on line ${w.groupLoc?.line}; ` +
          "a wallet can only be in one group.",
      });
    }
  };

  /** The `archived` cell of a wallet / category row: a date, or empty (active). Reports a bad date. */
  const archivedCell = (raw: string, what: string, problem: (c: string, m: string) => void): string | null => {
    const v = raw.trim();
    if (!v) return null;
    const date = parseImportDate(v);
    if (!date) {
      problem("archived", `“${v}” is not a valid date. Use YYYY-MM-DD (2026-03-31) or DD.MM.YYYY, or leave it empty for an active ${what}.`);
    }
    return date;
  };

  for (const { line, cells } of table.rows) {
    const problemsBefore = out.problems.length;
    const problem = (column: string, message: string) => out.problems.push({ line, message: `${column}: ${message}` });
    const get = cellReader(table.col, cells);
    const textCell = (c: Column) => unescapeFormula(get(c));

    if (get("type").trim().toLowerCase() === "category") {
      // A category row: the category's kind and archived date. Only used when the import creates the category; the
      // `date` cell is ignored.
      const name = check(() => normalizeCategoryName(textCell("category")), (m) => problem("category", m === "Enter a name." ? "Required: the category's name." : m));
      const rawKind = get("kind").trim().toLowerCase();
      const kind = rawKind === "expense" || rawKind === "income" ? rawKind : null;
      if (!kind) {
        problem("kind", rawKind ? `“${get("kind").trim()}” is not a kind. Use expense or income.` : "Required on a category row: expense or income.");
      }
      const archivedOn = archivedCell(get("archived"), "category", problem);
      const filled = NOT_ON_CATEGORY_ROWS.filter((c) => get(c).trim() !== "");
      if (filled.length) problem(filled[0], `A category row only describes a category; leave ${filled.join(", ")} empty.`);
      if (out.problems.length > problemsBefore) continue;
      const idx = categoryFor(kind!, name!);
      const c = out.categories[idx];
      if (c.detailsLoc) {
        problem("category", `Category “${c.name}” (${c.kind}) is already described on line ${c.detailsLoc.line}.`);
        continue;
      }
      c.archived = archivedOn !== null;
      if (archivedOn) c.archivedAt = `${archivedOn}T00:00:00.000Z`;
      c.detailsLoc = { line };
      continue;
    }
    if (get("kind").trim()) problem("kind", "Only category rows (type category) have a kind.");

    const rawGroup = textCell("group").trim();
    const group = rawGroup
      ? check(() => normalizeName(rawGroup, "group", MAX_GROUP_NAME_LENGTH), (m) => problem("group", m))
      : undefined;

    if (get("type").trim().toLowerCase() === "wallet") {
      // A wallet row: the wallet's initial balance (`amount`, may be negative or empty = 0), group and archived date.
      // Only used when the import creates the wallet; the `date` cell is ignored.
      const walletName = check(() => normalizeWalletName(textCell("wallet")), (m) => problem("wallet", m));
      const currency = currencyCell(get("currency"), "currency", problem);
      let initial: number | null = 0;
      const rawAmount = get("amount").trim();
      if (rawAmount && currency) {
        initial = parseAmount(rawAmount, currency, { allowNegative: true });
        if (initial === null) problem("amount", `“${rawAmount}” is not a valid ${currency} initial balance (${amountHint(currency)}).`);
      }
      const archivedOn = archivedCell(get("archived"), "wallet", problem);
      const filled = NOT_ON_WALLET_ROWS.filter((c) => get(c).trim() !== "");
      if (filled.length) {
        problem(filled[0], `A wallet row only describes a wallet; leave ${filled.join(", ")} empty.`);
      }
      if (out.problems.length > problemsBefore) continue;
      const idx = walletFor(walletName!, currency!);
      const w = out.wallets[idx];
      if (w.detailsLoc) {
        problem("wallet", `Wallet ${walletLabel(idx)} is already described on line ${w.detailsLoc.line}.`);
        continue;
      }
      w.initialBalanceMinor = initial!;
      w.archived = archivedOn !== null;
      if (archivedOn) w.archivedAt = `${archivedOn}T00:00:00.000Z`;
      w.detailsLoc = { line };
      setGroup(idx, group, line);
      continue;
    }
    if (get("archived").trim()) {
      problem("archived", "Only wallet and category rows (type wallet or category) can carry an archived date.");
    }

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
      problem(
        "type",
        rawType
          ? `“${get("type").trim()}” is not a type. Use expense, income, transfer, wallet or category.`
          : "Required: expense, income, transfer, wallet or category.",
      );
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
      const from = walletFor(walletName!, currency!);
      setGroup(from, group, line);
      out.transfers.push({
        from,
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
    const wallet = walletFor(walletName!, currency!);
    setGroup(wallet, group, line);
    out.entries.push({
      kind: type as CategoryKind,
      wallet,
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
