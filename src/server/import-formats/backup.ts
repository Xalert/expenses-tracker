import "server-only";
import { BACKUP_APP, BACKUP_VERSION, backupSchema, formatIssuePath } from "@/lib/backup-format";
import { isValidCurrency } from "@/lib/currencies";
import { isValidDate } from "@/lib/dates";
import { RATES_BASE, parseRateInput } from "@/lib/fx";
import { IMPORT_MAX_ROWS } from "@/lib/constants";
import { isGroupColor } from "@/lib/group-colors";
import { currencyDecimals, parseAmount } from "@/lib/money";
import { MAX_RECURRING_INTERVAL } from "@/lib/recurrence";
import { normalizeName, normalizeNote } from "../_validate";
import { MAX_GROUP_NAME_LENGTH } from "../wallet-groups";
import { normalizeTagName } from "../tags";
import {
  categoryKey,
  check,
  emptyParsed,
  fmtCount,
  normalizeCategoryName,
  normalizeWalletName,
  readTagNames,
  specBuilder,
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
  out.rowCount = entryCount;
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
    const group =
      w.group === undefined || w.group === null || !w.group.trim()
        ? undefined
        : (check(() => normalizeName(w.group, "group", MAX_GROUP_NAME_LENGTH), (m) => problem(`${p}.group`, m)) ?? undefined);
    checkDecimal(`${p}.initialBalance`, w.initialBalance, w.initialBalanceMinor, validCurrency ? currency : null, true);
    if (!walletIndex.has(w.id)) walletIndex.set(w.id, out.wallets.length);
    walletCurrency.push(validCurrency ? currency : null);
    out.wallets.push({
      name,
      currency,
      initialBalanceMinor: w.initialBalanceMinor,
      archived: w.archived,
      ...(w.archived && w.archivedAt ? { archivedAt: new Date(w.archivedAt).toISOString() } : {}),
      ...(group === undefined ? {} : { group }),
      detailsLoc: { path: p },
      key: walletKey(name, currency),
    });
  });

  // Groups (optional list; two spellings of one name ignoring case become one, the first wins)
  if (data.groups) {
    const seen = new Set<string>();
    const groups: NonNullable<ParsedFile["groups"]> = [];
    data.groups.forEach((g, i) => {
      const name = check(
        () => normalizeName(g.name, "name", MAX_GROUP_NAME_LENGTH),
        (m) => problem(`groups[${i}].name`, m),
      );
      if (name === undefined || seen.has(name.toLowerCase())) return;
      seen.add(name.toLowerCase());
      groups.push({ name, color: isGroupColor(g.color) ? g.color : null, archived: g.archived });
    });
    out.groups = groups;
  }

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
    const archivedAt = c.archived && c.archivedAt ? new Date(c.archivedAt).toISOString() : undefined;
    const color = isGroupColor(c.color) ? c.color : undefined;
    if (idx === undefined) {
      idx = out.categories.length;
      categoryByKey.set(key, idx);
      out.categories.push({
        name,
        kind: c.kind,
        key,
        archived: c.archived,
        ...(archivedAt ? { archivedAt } : {}),
        ...(color ? { color } : {}),
      });
    } else {
      // The first colour given wins.
      if (color && !out.categories[idx].color) out.categories[idx].color = color;
      // Merged with an earlier one: archived only when every file category merged into it is (on the latest date).
      const merged = out.categories[idx];
      merged.archived = merged.archived && c.archived;
      const latest = [merged.archivedAt, archivedAt].filter((d) => d !== undefined).sort().pop();
      if (merged.archived && latest) merged.archivedAt = latest;
      else delete merged.archivedAt;
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

  // Repeating entries (optional list): the wallet by the file's id, the category by kind + name (one the file does not
  // list is created like any other category the import needs). The rules of `createRecurringEntry`.
  const recurringIndex = new Map<number, number>();
  if (data.recurring) {
    out.recurring = [];
    data.recurring.forEach((r, i) => {
      const p = `recurring[${i}]`;
      const before = out.problems.length;
      if (recurringIndex.has(r.id)) problem(`${p}.id`, `Duplicate repeating entry id ${r.id}.`);
      const wallet = walletRef(`${p}.walletId`, r.walletId);
      const name = check(() => normalizeCategoryName(r.category), (m) => problem(`${p}.category`, m));
      const note = check(() => normalizeNote(r.note), (m) => problem(`${p}.note`, m));
      if (r.interval < 1 || r.interval > MAX_RECURRING_INTERVAL) {
        problem(`${p}.interval`, `Expected a whole number from 1 to ${MAX_RECURRING_INTERVAL}.`);
      }
      const start = date(`${p}.startDate`, r.startDate);
      const end = r.endDate ?? null;
      const next = r.nextDate ?? null;
      if (end !== null && date(`${p}.endDate`, end) && isValidDate(start) && end < start) {
        problem(`${p}.endDate`, "The end date is before the start date.");
      }
      if (next !== null && date(`${p}.nextDate`, next) && isValidDate(start) && next < start) {
        problem(`${p}.nextDate`, "The next date is before the start date.");
      }
      if (wallet !== undefined) checkDecimal(`${p}.amount`, r.amount, r.amountMinor, walletCurrency[wallet]);
      if (out.problems.length > before || wallet === undefined || name === undefined || note === undefined) return;
      const key = categoryKey(r.kind, name);
      let category = categoryByKey.get(key);
      if (category === undefined) {
        category = out.categories.length;
        categoryByKey.set(key, category);
        out.categories.push({ name, kind: r.kind, key });
      }
      recurringIndex.set(r.id, out.recurring!.length);
      out.recurring!.push({
        kind: r.kind,
        wallet,
        category,
        amountMinor: r.amountMinor,
        note,
        frequency: r.frequency,
        interval: r.interval,
        startDate: start,
        // A next date past the end means the rule has ended.
        endDate: end,
        nextDate: next !== null && end !== null && next > end ? null : next,
        paused: r.paused,
        loc: { path: p },
      });
    });
  }

  // Tags: the account's list (optional; kept so unused tags survive), then each entry's names. One tag per name
  // ignoring case, the first spelling wins.
  const { tagFor } = specBuilder(out);
  data.tags?.forEach((t, i) => {
    const name = check(() => normalizeTagName(t.name), (m) => problem(`tags[${i}].name`, m));
    if (name !== undefined) out.tags[tagFor(name)].listed = true;
  });

  data.transactions.forEach((t, i) => {
    const p = `transactions[${i}]`;
    let tagIdx: number[] | undefined;
    if (t.tags?.length) {
      const read = readTagNames(t.tags);
      if ("problem" in read) problem(`${p}.tags`, read.problem);
      else tagIdx = read.names.map(tagFor);
    }
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
    let recurring: number | undefined;
    if (t.recurringId !== undefined) {
      recurring = recurringIndex.get(t.recurringId);
      if (recurring === undefined) problem(`${p}.recurringId`, `No repeating entry with id ${t.recurringId} in this file.`);
    }
    if (wallet === undefined || category === undefined || category < 0 || note === undefined) return;
    out.entries.push({
      kind: t.kind,
      wallet,
      category,
      amountMinor: t.amountMinor,
      date: d,
      note,
      loc: { path: p },
      ...(recurring === undefined ? {} : { recurring }),
      ...(tagIdx?.length ? { tags: tagIdx } : {}),
    });
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

  // The user's own exchange rates (optional list): the rules of `setManualRate`, except that the currencies need not
  // be held (a wallet may have been deleted since the rate was set; an unused rate is harmless).
  if (data.manualRates) {
    const seen = new Map<string, string>();
    out.manualRates = [];
    data.manualRates.forEach((r, i) => {
      const p = `manualRates[${i}]`;
      const before = out.problems.length;
      const currency = r.currency.trim().toUpperCase();
      const base = r.base.trim().toUpperCase();
      if (!isValidCurrency(currency)) problem(`${p}.currency`, `“${r.currency}” is not a supported ISO 4217 currency code.`);
      else if (currency === RATES_BASE) problem(`${p}.currency`, `${RATES_BASE} needs no rate: it is what the other rates are counted in.`);
      if (!isValidCurrency(base)) problem(`${p}.base`, `“${r.base}” is not a supported ISO 4217 currency code.`);
      else if (base === currency) problem(`${p}.base`, "The rate's base must be a different currency.");
      date(`${p}.effectiveDate`, r.effectiveDate);
      const rate = parseRateInput(r.rate);
      if (rate === null) problem(`${p}.rate`, `“${r.rate}” is not a rate greater than zero (a decimal such as 3.25).`);
      if (out.problems.length > before) return;
      const key = `${currency}|${r.effectiveDate}`;
      const earlier = seen.get(key);
      if (earlier !== undefined) {
        problem(p, `${currency} already has a rate from ${r.effectiveDate} on in ${earlier}.`);
        return;
      }
      seen.set(key, p);
      out.manualRates!.push({ currency, base, effectiveDate: r.effectiveDate, rate: rate!, loc: { path: p } });
    });
  }

  // Budgets (optional list): one per expense category of the file (by name) and one overall (no `category`). The
  // currency need not be held, as for the rates: a budget does not depend on a wallet.
  if (data.budgets) {
    const seen = new Map<string, string>();
    out.budgets = [];
    data.budgets.forEach((b, i) => {
      const p = `budgets[${i}]`;
      const before = out.problems.length;
      const currency = b.currency.trim().toUpperCase();
      const validCurrency = isValidCurrency(currency);
      if (!validCurrency) problem(`${p}.currency`, `“${b.currency}” is not a supported ISO 4217 currency code.`);
      checkDecimal(`${p}.amount`, b.amount, b.amountMinor, validCurrency ? currency : null);
      let category: number | null = null;
      if (b.category !== undefined && b.category !== null && b.category.trim() !== "") {
        const name = check(() => normalizeCategoryName(b.category), (m) => problem(`${p}.category`, m));
        if (name !== undefined) {
          const idx = categoryByKey.get(categoryKey("expense", name));
          if (idx === undefined) {
            problem(
              `${p}.category`,
              categoryByKey.has(categoryKey("income", name))
                ? `“${name}” is an income category; budgets are for expense categories.`
                : `No expense category “${name}” in this file.`,
            );
          } else category = idx;
        }
      }
      if (out.problems.length > before) return;
      const key = category === null ? "overall" : String(category);
      const earlier = seen.get(key);
      if (earlier !== undefined) {
        problem(
          p,
          category === null
            ? `A second overall budget (the first is ${earlier}).`
            : `A second budget for “${out.categories[category].name}” (the first is ${earlier}).`,
        );
        return;
      }
      seen.set(key, p);
      out.budgets!.push({ category, currency, amountMinor: b.amountMinor, loc: { path: p } });
    });
  }

  return out;
}

function amountText(minor: number, currency: string): string {
  const d = currencyDecimals(currency);
  const sign = minor < 0 ? "-" : "";
  const digits = Math.abs(minor).toString().padStart(d + 1, "0");
  return `${sign}${d ? `${digits.slice(0, -d)}.${digits.slice(-d)}` : digits} ${currency}`;
}
