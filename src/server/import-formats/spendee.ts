import "server-only";
import type { CategoryKind } from "@/db/schema";
import { dateInTimeZone, isValidDate } from "@/lib/dates";
import { currencyDecimals, minorToInputValue, parseDecimalRounded } from "@/lib/money";
import { normalizeNote } from "../_validate";
import {
  addTally,
  cellReader,
  check,
  currencyCell,
  emptyParsed,
  fmtCount,
  normalizeCategoryName,
  normalizeWalletName,
  readCsvTable,
  specBuilder,
  type ImportContext,
  type ImportFormat,
  type ParsedFile,
  type TransferLeg,
} from "./shared";

// Spendee's CSV exports (docs/SPEC.md → "Provider formats"). Two dialects, one format:
//
// Older single-file export — `;`-separated, fully quoted, CRLF, dates without a time zone:
//   "Date";"Wallet";"Type";"Category name";"Amount";"Currency";"Notes";"First name";"Last name"
//   "2019-04-29 21:10:33";"Personal Account";"expense";"Food";"-30";"RON";"Mc";"Jane";"Doe"
//
// Current per-wallet export — one file per wallet, `,`-separated, LF, UTC timestamps, 8-decimal amounts, transfers:
//   Date,Wallet,Type,Category name,Amount,Currency,Note,Labels,Author
//   2026-08-17T08:41:34+00:00,Joint,Incoming Transfer,,300.00000000,EUR,rent share,,"Jane Doe"
//
// Amounts are signed and may carry more decimals than the currency has; they are rounded half away from zero.
// A transfer is two rows (outgoing in one wallet's file, incoming in the other's); `finalize` pairs them across
// the whole selection.

/** Lower-cased header name → how it is written in the file (used in problem messages). */
const COLUMN_LABELS = {
  date: "Date",
  wallet: "Wallet",
  type: "Type",
  "category name": "Category name",
  amount: "Amount",
  currency: "Currency",
  notes: "Notes",
  note: "Note",
  labels: "Labels",
} as const;
type Column = keyof typeof COLUMN_LABELS;
const REQUIRED_COLUMNS: Column[] = ["date", "wallet", "type", "category name", "amount", "currency"];
const OPTIONAL_COLUMNS: Column[] = ["notes", "note", "labels"];

/** Two transfer rows further apart than this are never paired. */
export const TRANSFER_PAIR_WINDOW_MS = 10_000;
/** The category unpaired transfer rows go to when the user opts in. */
export const UNPAIRED_TRANSFER_CATEGORY = "Transfer";

type RowType = CategoryKind | "out" | "in";
const TYPES: Record<string, RowType> = {
  expense: "expense",
  income: "income",
  "outgoing transfer": "out",
  "incoming transfer": "in",
};

export const spendeeFormat: ImportFormat = {
  id: "spendee",
  label: "Spendee export",
  // A `Category name` column and no `category` column: the native CSV never has the former, Spendee never the latter.
  detect: (source) => {
    if (source.body[0] === "{" || source.body[0] === "[") return false;
    const header = source.csvHeader();
    return header.includes("category name") && !header.includes("category");
  },
  parse: ({ text }, ctx) => parseSpendeeCsv(text, ctx),
  finalize: finalizeSpendee,
};

const TIMESTAMP_RE =
  /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?(?:\s*(Z|[+-]\d{2}(?::?\d{2})?))?)?$/i;

export type SpendeeTimestamp = {
  /** The calendar date to store. */
  date: string;
  /** Milliseconds since the epoch; without an offset, the time as written read as UTC (used for pairing only). */
  instant: number;
  /** True when the value carried a UTC offset and was converted to the time zone. */
  converted: boolean;
  /** True when that conversion changed the calendar date written in the file. */
  shifted: boolean;
};

/**
 * `YYYY-MM-DD`, optionally with ` HH:MM[:SS[.fff]]` (or `T`), optionally followed by `Z` or a `±HH:MM` offset.
 * With an offset, the date is the local date of that instant in `timeZone`; without one, the date as written.
 * Null for anything else (including impossible dates and times).
 */
export function parseSpendeeTimestamp(value: string, timeZone: string): SpendeeTimestamp | null {
  const m = TIMESTAMP_RE.exec(value.trim());
  if (!m || !isValidDate(m[1])) return null;
  const [, written, hh, mi, ss, frac, offset] = m;
  const h = Number(hh ?? 0);
  const min = Number(mi ?? 0);
  const s = Number(ss ?? 0);
  if (h > 23 || min > 59 || s > 59) return null;
  const [y, mo, d] = written.split("-").map(Number);
  const ms = frac ? Number(frac.slice(0, 3).padEnd(3, "0")) : 0;
  const wall = Date.UTC(y, mo - 1, d, h, min, s, ms);
  if (!offset) return { date: written, instant: wall, converted: false, shifted: false };
  let offsetMinutes = 0;
  if (offset.toUpperCase() !== "Z") {
    const om = /^([+-])(\d{2}):?(\d{2})?$/.exec(offset)!;
    const oh = Number(om[2]);
    const omin = Number(om[3] ?? 0);
    if (oh > 23 || omin > 59) return null;
    offsetMinutes = (om[1] === "-" ? -1 : 1) * (oh * 60 + omin);
  }
  const instant = wall - offsetMinutes * 60_000;
  const date = dateInTimeZone(instant, timeZone);
  if (!isValidDate(date)) return null;
  return { date, instant, converted: true, shifted: date !== written };
}

/** `note · labels`, or whichever of the two is present. */
const joinNote = (note: string | null, labels: string) => (labels ? (note ? `${note} · ${labels}` : labels) : note);

function parseSpendeeCsv(fileText: string, ctx: ImportContext): ParsedFile {
  const out = emptyParsed("spendee");
  const table = readCsvTable<Column>(fileText, out, {
    required: REQUIRED_COLUMNS,
    optional: OPTIONAL_COLUMNS,
    describe: (missing) =>
      `This looks like a Spendee export, but it is missing the column${missing.length === 1 ? "" : "s"} ` +
      `${missing.map((c) => COLUMN_LABELS[c]).join(", ")}. Spendee's header is ` +
      `${REQUIRED_COLUMNS.map((c) => COLUMN_LABELS[c]).join(", ")}, Note (or Notes) and Labels (other columns are ignored).`,
  });
  if (!table) return out;
  const { walletFor, categoryFor } = specBuilder(out);
  // The current export calls it `Note`, the older one `Notes`.
  const noteColumn: Column = table.col.has("note") ? "note" : "notes";

  for (const { line, cells } of table.rows) {
    const problemsBefore = out.problems.length;
    const problem = (column: string, message: string) => out.problems.push({ line, message: `${column}: ${message}` });
    const get = cellReader(table.col, cells);

    const rawDate = get("date").trim();
    const ts = parseSpendeeTimestamp(rawDate, ctx.timeZone);
    if (!ts) {
      problem(
        "Date",
        rawDate
          ? `“${rawDate}” is not a valid date. Expected YYYY-MM-DD HH:MM:SS (2019-04-29 21:10:33), an ISO timestamp ` +
              "with a UTC offset (2026-08-08T11:06:15+00:00) or YYYY-MM-DD."
          : "Required.",
      );
    }

    const rawType = get("type").trim();
    const type: RowType | null = TYPES[rawType.toLowerCase()] ?? null;
    if (!type) {
      problem(
        "Type",
        rawType
          ? `“${rawType}” is not supported. Only expense and income rows can be imported, and transfers written as ` +
              "Outgoing Transfer / Incoming Transfer rows."
          : "Required: Expense, Income, Outgoing Transfer or Incoming Transfer.",
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
      const negativeType = type === "expense" || type === "out";
      const typeName = type === "expense" ? "an expense" : type === "income" ? "an income" : type === "out" ? "an outgoing transfer" : "an incoming transfer";
      if (!parsed) {
        problem("Amount", `“${rawAmount}” is not a valid amount (expected a number with a dot, like -30.50).`);
      } else if (parsed.minor === 0) {
        problem(
          "Amount",
          parsed.rounded
            ? `“${rawAmount}” rounds to ${minorToInputValue(0, currency)} ${currency}; amounts must be greater than zero.`
            : "Must not be zero.",
        );
      } else if (type && negativeType && !parsed.negative) {
        problem("Amount", `“${rawAmount}” is positive, but the row is ${typeName} (Spendee writes those as negative amounts).`);
      } else if (type && !negativeType && parsed.negative) {
        problem("Amount", `“${rawAmount}” is negative, but the row is ${typeName} (Spendee writes those as positive amounts).`);
      } else {
        amountMinor = parsed.minor;
        wasRounded = parsed.rounded;
      }
    }

    // A category on a transfer row is ignored (Spendee leaves it empty).
    const categoryName =
      type === "expense" || type === "income"
        ? check(
            () => normalizeCategoryName(get("category name")),
            (m) => problem("Category name", m === "Enter a name." ? "Required." : m),
          )
        : undefined;
    const noteLabel = COLUMN_LABELS[noteColumn];
    const bareNote = check(() => normalizeNote(get(noteColumn)), (m) => problem(noteLabel, m));
    const labels = get("labels").trim().replace(/\s+/g, " ");
    const note =
      bareNote === undefined ? undefined : check(() => normalizeNote(joinNote(bareNote, labels)), (m) => problem(noteLabel, `${m.replace(/\.$/, "")} (with the labels added).`));

    if (out.problems.length > problemsBefore) continue;
    if (wasRounded) addTally(out, `rounded:${currency}`);
    if (labels) addTally(out, "labels");
    if (ts!.converted) addTally(out, "tz-converted");
    if (ts!.shifted) addTally(out, "tz-shifted");
    const wallet = walletFor(walletName!, currency!);
    if (type === "out" || type === "in") {
      out.transferLegs.push({
        direction: type,
        wallet,
        currency: currency!,
        amountMinor: amountMinor!,
        date: ts!.date,
        instant: ts!.instant,
        matchKey: bareNote ?? "",
        note: note!,
        bareNote: bareNote!,
        labels,
        loc: { line },
      });
      continue;
    }
    out.entries.push({
      kind: type!,
      wallet,
      category: categoryFor(type!, categoryName!),
      amountMinor: amountMinor!,
      date: ts!.date,
      note: note!,
      loc: { line },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Selection-wide: transfer pairing and notices

const legRef = (leg: TransferLeg) => `${leg.loc.file ? `${leg.loc.file}, ` : ""}line ${leg.loc.line}`;

/** Two legs that would produce exactly the same result, so it does not matter which of them is paired. */
const interchangeable = (a: TransferLeg, b: TransferLeg) =>
  a.wallet === b.wallet && a.amountMinor === b.amountMinor && a.instant === b.instant && a.note === b.note && a.date === b.date;

function finalizeSpendee(combined: ParsedFile, ctx: ImportContext): void {
  pairTransfers(combined, ctx);
  addNotices(combined, ctx);
}

/**
 * Pair outgoing with incoming transfer rows: different wallet, same note (without labels), at most 10 s apart and,
 * when both wallets have the same currency, the same amount. Closest in time first; each row is used once. Rows
 * that compete for the same partner at the same distance are only paired when the choice cannot change the
 * result (identical rows); otherwise that is a problem naming every row involved. Leftovers are problems, or
 * income / expense entries in the "Transfer" category when the user opted in.
 */
function pairTransfers(combined: ParsedFile, ctx: ImportContext): void {
  const legs = combined.transferLegs;
  combined.transferLegs = [];
  if (legs.length === 0) return;
  const walletName = (leg: TransferLeg) => combined.wallets[leg.wallet].name;
  const amountText = (leg: TransferLeg) => `${minorToInputValue(leg.amountMinor, leg.currency)} ${leg.currency}`;

  // Candidate pairs, found per note in time order.
  const insByKey = new Map<string, number[]>();
  legs.forEach((leg, i) => {
    if (leg.direction !== "in") return;
    const list = insByKey.get(leg.matchKey) ?? [];
    list.push(i);
    insByKey.set(leg.matchKey, list);
  });
  for (const list of insByKey.values()) list.sort((a, b) => legs[a].instant - legs[b].instant || a - b);
  const candidates: { o: number; i: number; d: number }[] = [];
  legs.forEach((o, oi) => {
    if (o.direction !== "out") return;
    const list = insByKey.get(o.matchKey);
    if (!list) return;
    // First incoming row not earlier than the window start (binary search), then scan the window.
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (legs[list[mid]].instant < o.instant - TRANSFER_PAIR_WINDOW_MS) lo = mid + 1;
      else hi = mid;
    }
    for (let k = lo; k < list.length && legs[list[k]].instant <= o.instant + TRANSFER_PAIR_WINDOW_MS; k++) {
      const i = legs[list[k]];
      if (i.wallet === o.wallet) continue;
      if (i.currency === o.currency && i.amountMinor !== o.amountMinor) continue;
      candidates.push({ o: oi, i: list[k], d: Math.abs(i.instant - o.instant) });
    }
  });
  candidates.sort((a, b) => a.d - b.d || a.o - b.o || a.i - b.i);

  const partner = new Map<number, number>(); // out leg → in leg
  const used = new Set<number>();
  for (let start = 0; start < candidates.length; ) {
    let end = start;
    while (end < candidates.length && candidates[end].d === candidates[start].d) end++;
    const group = candidates.slice(start, end).filter((c) => !used.has(c.o) && !used.has(c.i));
    start = end;
    // Connected components of the "could pair with" graph at this distance (union-find over leg indexes).
    const parent = new Map<number, number>();
    const find = (x: number): number => {
      let r = x;
      while (parent.get(r) !== undefined && parent.get(r) !== r) r = parent.get(r)!;
      parent.set(x, r);
      return r;
    };
    for (const c of group) {
      if (!parent.has(c.o)) parent.set(c.o, c.o);
      if (!parent.has(c.i)) parent.set(c.i, c.i);
      parent.set(find(c.o), find(c.i));
    }
    const components = new Map<number, { outs: number[]; ins: number[]; edges: number }>();
    for (const c of group) {
      const root = find(c.o);
      const comp = components.get(root) ?? { outs: [], ins: [], edges: 0 };
      if (!comp.outs.includes(c.o)) comp.outs.push(c.o);
      if (!comp.ins.includes(c.i)) comp.ins.push(c.i);
      comp.edges++;
      components.set(root, comp);
    }
    for (const { outs, ins } of components.values()) {
      outs.sort((a, b) => a - b);
      ins.sort((a, b) => a - b);
      const unique = outs.length === 1 && ins.length === 1;
      const sameResult =
        outs.every((o) => interchangeable(legs[o], legs[outs[0]])) && ins.every((i) => interchangeable(legs[i], legs[ins[0]]));
      if (unique || sameResult) {
        for (let k = 0; k < Math.min(outs.length, ins.length); k++) {
          partner.set(outs[k], ins[k]);
          used.add(outs[k]).add(ins[k]);
        }
        continue;
      }
      for (const x of [...outs, ...ins]) used.add(x);
      const first = legs[outs[0]];
      combined.problems.push({
        ...first.loc,
        message:
          "These Spendee transfer rows cannot be paired without guessing — they are equally close in time and could " +
          `be matched in more than one way: outgoing ${outs.map((o) => `${legRef(legs[o])} (${amountText(legs[o])}, “${walletName(legs[o])}”)`).join(", ")}; ` +
          `incoming ${ins.map((i) => `${legRef(legs[i])} (${amountText(legs[i])}, “${walletName(legs[i])}”)`).join(", ")}. ` +
          "Give the transfers different notes in Spendee and export again.",
      });
    }
  }

  // Build the transfers in file order of their outgoing row.
  for (const [o, i] of [...partner].sort((a, b) => a[0] - b[0])) {
    const out = legs[o];
    const inc = legs[i];
    let note = out.note;
    if (!out.labels && inc.labels) note = check(() => normalizeNote(joinNote(out.bareNote, inc.labels)), () => {}) ?? out.note;
    combined.transfers.push({
      from: out.wallet,
      to: inc.wallet,
      amountMinor: out.amountMinor,
      receivedAmountMinor: inc.amountMinor,
      date: out.date,
      note,
      loc: out.loc,
    });
  }

  const unpaired = legs.map((_, k) => k).filter((k) => !used.has(k));
  combined.unpairedTransferRows += unpaired.length;
  if (unpaired.length === 0) return;
  if (ctx.unpairedTransfersAsEntries) {
    const { categoryFor } = specBuilder(combined);
    for (const k of unpaired) {
      const leg = legs[k];
      const kind: CategoryKind = leg.direction === "out" ? "expense" : "income";
      combined.entries.push({
        kind,
        wallet: leg.wallet,
        category: categoryFor(kind, UNPAIRED_TRANSFER_CATEGORY),
        amountMinor: leg.amountMinor,
        date: leg.date,
        note: leg.note,
        loc: leg.loc,
      });
    }
    combined.notices.push({
      code: "unpaired-transfers",
      count: unpaired.length,
      message:
        `${fmtCount(unpaired.length)} transfer ${unpaired.length === 1 ? "row has" : "rows have"} no partner in the ` +
        `selected files and ${unpaired.length === 1 ? "is" : "are"} imported as ${unpaired.length === 1 ? "an " : ""}` +
        `expense / income in the “${UNPAIRED_TRANSFER_CATEGORY}” category instead of as a transfer.`,
    });
    return;
  }
  for (const k of unpaired) {
    const leg = legs[k];
    const [what, otherType, prep] =
      leg.direction === "out" ? ["Outgoing transfer", "Incoming Transfer", "from"] : ["Incoming transfer", "Outgoing Transfer", "to"];
    combined.problems.push({
      ...leg.loc,
      message:
        `${what} of ${amountText(leg)} ${prep} “${walletName(leg)}” on ${leg.date} has no matching ${otherType} row ` +
        "in another wallet (same note, at most 10 seconds apart). Select the other wallet's Spendee export too, so " +
        "both files are imported together — or, if that wallet is gone, turn on “Import unpaired transfers as " +
        "income / expense”.",
    });
  }
}

function addNotices(combined: ParsedFile, ctx: ImportContext): void {
  const t = combined.tallies;
  const converted = t.get("tz-converted") ?? 0;
  if (converted > 0) {
    const shifted = t.get("tz-shifted") ?? 0;
    const zone = ctx.timeZoneFallback
      ? "UTC (your browser's time zone was not recognised)"
      : ctx.timeZone === "UTC"
        ? "UTC"
        : `your time zone, ${ctx.timeZone}`;
    combined.notices.push({
      code: "time-zone",
      count: converted,
      message:
        `Spendee records the time of each entry; dates are taken in ${zone}. ` +
        (shifted > 0
          ? `${fmtCount(shifted)} ${shifted === 1 ? "entry falls" : "entries fall"} on a different day than the UTC date in the file.`
          : "No entry changes day because of that."),
    });
  }
  const labelled = t.get("labels") ?? 0;
  if (labelled > 0) {
    combined.notices.push({
      code: "labels",
      count: labelled,
      message:
        `${fmtCount(labelled)} ${labelled === 1 ? "row has" : "rows have"} Spendee labels. This app has no labels, so ` +
        `they are added to the note (“note · labels”).`,
    });
  }
  for (const [key, count] of t) {
    if (!key.startsWith("rounded:")) continue;
    const currency = key.slice("rounded:".length);
    const d = currencyDecimals(currency);
    combined.notices.push({
      code: "amounts-rounded",
      count,
      message:
        `${fmtCount(count)} ${count === 1 ? "amount had" : "amounts had"} more decimals than ${currency} allows and ` +
        `${count === 1 ? "was" : "were"} rounded to ${d === 0 ? "whole units" : `${d} decimal${d === 1 ? "" : "s"}`}.`,
    });
  }
}
