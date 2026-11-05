import "server-only";
import { BACKUP_APP, BACKUP_VERSION, backupSchema, formatIssuePath } from "@/lib/backup-format";
import { isValidCurrency } from "@/lib/currencies";
import { isValidDate } from "@/lib/dates";
import { IMPORT_MAX_ROWS } from "@/lib/constants";
import { currencyDecimals, parseAmount } from "@/lib/money";
import { normalizeNote } from "../_validate";
import {
  categoryKey,
  check,
  emptyParsed,
  fmtCount,
  normalizeCategoryName,
  normalizeWalletName,
  walletKey,
  type ImportFormat,
  type ParsedFile,
} from "./shared";

/** The app's own lossless JSON backup. Recognised by its first character; the `app` marker is checked in parse. */
export const backupFormat: ImportFormat = {
  id: "backup",
  label: "Backup (JSON)",
  detect: ({ body }) => body[0] === "{" || body[0] === "[",
  parse: ({ body }) => parseBackup(body),
};

function parseBackup(body: string): ParsedFile {
  const fail = (message: string, path = "(file)") => emptyParsed("backup", [{ path, message }]);

  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch (err) {
    return fail(`This is not valid JSON (${err instanceof Error ? err.message : "parse error"}).`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw) || (raw as { app?: unknown }).app !== BACKUP_APP) {
    return fail(`This JSON file is not an Expenses Tracker backup (it has no "app": "${BACKUP_APP}").`);
  }
  const version = (raw as { version?: unknown }).version;
  if (version !== BACKUP_VERSION) {
    return fail(
      typeof version === "number" && version > BACKUP_VERSION
        ? `This backup is version ${version}, made by a newer version of the app. This instance reads version ${BACKUP_VERSION}.`
        : `Unsupported backup version ${JSON.stringify(version ?? null)}. This instance reads version ${BACKUP_VERSION}.`,
      "version",
    );
  }

  const result = backupSchema.safeParse(raw);
  if (!result.success) {
    return emptyParsed(
      "backup",
      result.error.issues.map((i) => ({ path: formatIssuePath(i.path), message: i.message })),
    );
  }
  const data = result.data;
  const out: ParsedFile = { ...emptyParsed("backup"), walletMatching: "by-position" };
  const problem = (path: string, message: string) => out.problems.push({ path, message });

  const entryCount = data.transactions.length + data.transfers.length;
  if (entryCount > IMPORT_MAX_ROWS) {
    problem(
      "(file)",
      `The backup has ${fmtCount(entryCount)} transactions and transfers; the limit is ${fmtCount(IMPORT_MAX_ROWS)} per import.`,
    );
    return out;
  }

  /** Decimal strings are informational, but a file where they disagree with the minor units is rejected. */
  const checkDecimal = (path: string, decimal: string | undefined, minor: number, currency: string | null, negative = false) => {
    if (decimal === undefined || currency === null) return;
    const parsed = parseAmount(decimal, currency, { allowNegative: negative });
    if (parsed !== minor) {
      problem(path, `“${decimal}” does not match the amount in minor units (${minor} = ${amountText(minor, currency)}).`);
    }
  };

  // Wallets
  const walletIndex = new Map<number, number>();
  const walletCurrency: (string | null)[] = [];
  data.wallets.forEach((w, i) => {
    const p = `wallets[${i}]`;
    if (walletIndex.has(w.id)) problem(`${p}.id`, `Duplicate wallet id ${w.id}.`);
    const name = check(() => normalizeWalletName(w.name), (m) => problem(`${p}.name`, m)) ?? "";
    const currency = w.currency.trim().toUpperCase();
    const validCurrency = isValidCurrency(currency);
    if (!validCurrency) problem(`${p}.currency`, `“${w.currency}” is not a supported ISO 4217 currency code.`);
    checkDecimal(`${p}.initialBalance`, w.initialBalance, w.initialBalanceMinor, validCurrency ? currency : null, true);
    if (!walletIndex.has(w.id)) walletIndex.set(w.id, out.wallets.length);
    walletCurrency.push(validCurrency ? currency : null);
    out.wallets.push({
      name,
      currency,
      initialBalanceMinor: w.initialBalanceMinor,
      archived: w.archived,
      key: walletKey(name, currency),
    });
  });

  // Categories (two file categories with the same kind + name ignoring case become one)
  const categoryIndex = new Map<number, number>();
  const categoryByKey = new Map<string, number>();
  data.categories.forEach((c, i) => {
    const p = `categories[${i}]`;
    if (categoryIndex.has(c.id)) {
      problem(`${p}.id`, `Duplicate category id ${c.id}.`);
      return;
    }
    const name = check(() => normalizeCategoryName(c.name), (m) => problem(`${p}.name`, m));
    if (name === undefined) {
      categoryIndex.set(c.id, -1);
      return;
    }
    const key = categoryKey(c.kind, name);
    let idx = categoryByKey.get(key);
    if (idx === undefined) {
      idx = out.categories.length;
      categoryByKey.set(key, idx);
      out.categories.push({ name, kind: c.kind, key });
    }
    categoryIndex.set(c.id, idx);
  });

  const walletRef = (path: string, id: number): number | undefined => {
    const idx = walletIndex.get(id);
    if (idx === undefined) problem(path, `No wallet with id ${id} in this file.`);
    return idx;
  };
  const date = (path: string, value: string) => {
    if (!isValidDate(value)) problem(path, `“${value}” is not a valid date (expected YYYY-MM-DD).`);
    return value;
  };

  data.transactions.forEach((t, i) => {
    const p = `transactions[${i}]`;
    const wallet = walletRef(`${p}.walletId`, t.walletId);
    let category = categoryIndex.get(t.categoryId);
    if (category === undefined) problem(`${p}.categoryId`, `No category with id ${t.categoryId} in this file.`);
    else if (category >= 0 && out.categories[category].kind !== t.kind) {
      const c = out.categories[category];
      problem(`${p}.categoryId`, `“${c.name}” is an ${c.kind} category; this transaction is an ${t.kind}.`);
      category = undefined;
    }
    const d = date(`${p}.date`, t.date);
    const note = check(() => normalizeNote(t.note), (m) => problem(`${p}.note`, m));
    if (wallet !== undefined) checkDecimal(`${p}.amount`, t.amount, t.amountMinor, walletCurrency[wallet]);
    if (wallet === undefined || category === undefined || category < 0 || note === undefined) return;
    out.entries.push({ kind: t.kind, wallet, category, amountMinor: t.amountMinor, date: d, note, loc: { path: p } });
  });

  data.transfers.forEach((t, i) => {
    const p = `transfers[${i}]`;
    const from = walletRef(`${p}.fromWalletId`, t.fromWalletId);
    const to = walletRef(`${p}.toWalletId`, t.toWalletId);
    if (from !== undefined && from === to) problem(`${p}.toWalletId`, "A transfer needs two different wallets.");
    const d = date(`${p}.date`, t.date);
    const note = check(() => normalizeNote(t.note), (m) => problem(`${p}.note`, m));
    if (from === undefined || to === undefined || note === undefined) return;
    const fromCur = walletCurrency[from];
    const toCur = walletCurrency[to];
    checkDecimal(`${p}.amount`, t.amount, t.amountMinor, fromCur);
    let received = t.receivedAmountMinor;
    if (fromCur && toCur) {
      if (fromCur === toCur) {
        if (received !== undefined && received !== t.amountMinor) {
          problem(`${p}.receivedAmountMinor`, `Both wallets use ${fromCur}, so the amount received must equal the amount sent.`);
        }
        received = t.amountMinor;
      } else if (received === undefined) {
        problem(`${p}.receivedAmountMinor`, `Required: the wallets use different currencies (${fromCur} → ${toCur}).`);
      }
      checkDecimal(`${p}.receivedAmount`, t.receivedAmount, received ?? 0, received === undefined ? null : toCur);
    }
    if (received === undefined || from === to) return;
    out.transfers.push({
      from,
      to,
      amountMinor: t.amountMinor,
      receivedAmountMinor: received,
      date: d,
      note,
      loc: { path: p },
    });
  });

  return out;
}

function amountText(minor: number, currency: string): string {
  const d = currencyDecimals(currency);
  const sign = minor < 0 ? "-" : "";
  const digits = Math.abs(minor).toString().padStart(d + 1, "0");
  return `${sign}${d ? `${digits.slice(0, -d)}.${digits.slice(-d)}` : digits} ${currency}`;
}
