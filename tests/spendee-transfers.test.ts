import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { DB } from "@/db";
import { categories, transactions, transfers, wallets } from "@/db/schema";
import { toCsv } from "@/lib/csv";
import { dateInTimeZone, resolveTimeZone } from "@/lib/dates";
import { listCategories } from "@/server/categories";
import { buildBackup, buildTransactionsCsv, listTransferRows } from "@/server/export";
import { parseSpendeeTimestamp } from "@/server/import-formats/spendee";
import {
  IMPORT_MAX_BYTES,
  IMPORT_MAX_FILES,
  previewImport,
  runImport,
  type ImportFileInput,
  type ImportOptions,
  type ImportPreview,
} from "@/server/import";
import { createTransaction } from "@/server/transactions";
import { createWallet, listWallets } from "@/server/wallets";
import { makeUser, useFreshDb } from "./helpers";

// Synthetic exports in the shape of Spendee's current per-wallet export: one file per wallet, `,`-separated,
// LF, cells quoted only when needed, UTC timestamps with an offset, 8-decimal amounts, transfers as two rows.
// Every name, note and label here is made up.

let db: DB;
let alice: ReturnType<typeof makeUser>;

beforeEach(() => {
  db = useFreshDb();
  alice = makeUser(db, "alice@example.com");
});

const HEADER = "Date,Wallet,Type,Category name,Amount,Currency,Note,Labels,Author";
type Row = {
  at: string; // timestamp as written
  wallet: string;
  type: string;
  amount: string;
  currency: string;
  category?: string;
  note?: string;
  labels?: string;
};
const cell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
function wallet(...rows: Row[]): string {
  return (
    [HEADER, ...rows.map((r) => [r.at, r.wallet, r.type, r.category ?? "", r.amount, r.currency, r.note ?? "", r.labels ?? "", '"Test Person"'].map((c, i) => (i === 8 ? c : cell(c))).join(","))].join("\n") +
    "\n"
  );
}
const f = (name: string, ...rows: Row[]): ImportFileInput => ({ name, text: wallet(...rows) });

// Shorthands: an EUR "Savings" wallet, an EUR "Joint" wallet, a USD wallet and a RON wallet.
const sav = (at: string, type: string, amount: string, extra: Partial<Row> = {}): Row => ({ at, wallet: "Savings €", type, amount, currency: "EUR", ...extra });
const joint = (at: string, type: string, amount: string, extra: Partial<Row> = {}): Row => ({ at, wallet: "Joint", type, amount, currency: "EUR", ...extra });
const usd = (at: string, type: string, amount: string, extra: Partial<Row> = {}): Row => ({ at, wallet: " Biz $", type, amount, currency: "USD", ...extra });
const ron = (at: string, type: string, amount: string, extra: Partial<Row> = {}): Row => ({ at, wallet: "Lei", type, amount, currency: "RON", ...extra });

const OUT = "Outgoing Transfer";
const IN = "Incoming Transfer";
const BXL: ImportOptions = { timeZone: "Europe/Brussels" };

function snapshot() {
  return {
    wallets: db.select().from(wallets).orderBy(wallets.id).all(),
    categories: db.select().from(categories).orderBy(categories.id).all(),
    transfers: db.select().from(transfers).orderBy(transfers.id).all(),
    transactions: db.select().from(transactions).orderBy(transactions.id).all(),
  };
}

const walletName = (userId: number) => {
  const byId = new Map(listWallets(userId, { includeArchived: true }).map((w) => [w.id, w.name]));
  return (id: number) => byId.get(id);
};
const transfersOf = (userId: number) => {
  const name = walletName(userId);
  return listTransferRows(userId).map((t) => ({
    from: name(t.fromWalletId),
    to: name(t.toWalletId),
    sent: t.amountMinor,
    received: t.receivedAmountMinor,
    date: t.date,
    note: t.note,
  }));
};
const entriesOf = (userId: number) => {
  const name = walletName(userId);
  return db
    .select({
      walletId: transactions.walletId,
      kind: transactions.kind,
      category: categories.name,
      amountMinor: transactions.amountMinor,
      date: transactions.date,
      note: transactions.note,
    })
    .from(transactions)
    .leftJoin(categories, eq(categories.id, transactions.categoryId))
    .where(eq(transactions.userId, userId))
    .orderBy(transactions.id)
    .all()
    .filter((t) => t.kind === "expense" || t.kind === "income")
    .map(({ walletId, ...t }) => ({ wallet: name(walletId), ...t }));
};

function expectProblems(p: ImportPreview, expected: { file?: string; line?: number; message: RegExp }[]) {
  expect(p.ok).toBe(false);
  for (const e of expected) {
    const hit = p.problems.find(
      (pr) => (e.file === undefined || pr.file === e.file) && (e.line === undefined || pr.line === e.line) && e.message.test(pr.message),
    );
    expect(hit, `expected ${String(e.message)} at ${e.file}:${e.line} in ${JSON.stringify(p.problems, null, 1)}`).toBeTruthy();
  }
}

/** Preview + run must both refuse, and nothing may be written. */
function refused(files: ImportFileInput[] | string, opts: ImportOptions = BXL) {
  const before = snapshot();
  const p = previewImport(alice.id, files, opts);
  const r = runImport(alice.id, files, opts);
  expect(r.imported).toBe(false);
  expect(r.problemCount).toBe(p.problemCount);
  expect(snapshot()).toEqual(before);
  return p;
}

describe("Spendee per-wallet dialect: detection and rows", () => {
  it("detects the per-wallet header as Spendee, next to the older dialect and the native CSV", () => {
    const p = previewImport(alice.id, wallet(joint("2026-08-08T11:06:15+00:00", "Expense", "-83.93000000", { category: "Groceries" })), BXL);
    expect(p).toMatchObject({ format: "spendee", formatLabel: "Spendee export", ok: true, transactionsToAdd: 1 });
    const older = '"Date";"Wallet";"Type";"Category name";"Amount";"Currency";"Notes"\r\n"2019-04-29 21:10:33";"Cash";"expense";"Food";"-30";"RON";"Mc"\r\n';
    expect(previewImport(alice.id, older)).toMatchObject({ format: "spendee", ok: true, transactionsToAdd: 1 });
    const native = "date,type,wallet,currency,amount,category,note\n2026-01-01,expense,Cash,EUR,1,Food,x\n";
    expect(previewImport(alice.id, native)).toMatchObject({ format: "csv", ok: true, transactionsToAdd: 1 });
  });

  it("accepts the four types in any letter case", () => {
    const r = runImport(
      alice.id,
      [
        f("joint.csv", joint("2026-08-01T10:00:00+00:00", "EXPENSE", "-10.00000000", { category: "Food" }), joint("2026-08-01T11:00:00+00:00", "income", "20.00000000", { category: "Salary" }), joint("2026-08-02T10:00:01+00:00", "incoming TRANSFER", "5.00000000")),
        f("savings.csv", sav("2026-08-02T10:00:00+00:00", "outgoing transfer", "-5.00000000")),
      ],
      BXL,
    );
    expect(r).toMatchObject({ imported: true, transactionsToAdd: 2, transfersToAdd: 1, problemCount: 0 });
    expect(entriesOf(alice.id).map((e) => e.kind)).toEqual(["expense", "income"]);
  });

  it("reports unknown types and transfer amounts with the wrong sign", () => {
    const p = refused([
      f(
        "joint.csv",
        joint("2026-08-01T10:00:00+00:00", "Refund", "10.00000000", { category: "Food" }),
        joint("2026-08-01T10:00:00+00:00", IN, "-5.00000000"),
        joint("2026-08-01T10:00:00+00:00", OUT, "5.00000000"),
      ),
      f("other.csv", sav("2026-08-01T10:00:00+00:00", "Expense", "-1.00000000", { category: "Food" })),
    ]);
    expectProblems(p, [
      { file: "joint.csv", line: 2, message: /^Type: “Refund” is not supported/ },
      { file: "joint.csv", line: 3, message: /is negative, but the row is an incoming transfer/ },
      { file: "joint.csv", line: 4, message: /is positive, but the row is an outgoing transfer/ },
    ]);
  });

  it("does not count 8-decimal amounts as rounded, but does count genuinely over-precise ones", () => {
    const p = previewImport(
      alice.id,
      wallet(
        joint("2026-08-08T11:06:15+00:00", "Expense", "-83.93000000", { category: "Food" }),
        joint("2026-08-08T11:06:16+00:00", "Income", "1200.00000000", { category: "Salary" }),
      ),
      BXL,
    );
    expect(p.notices.filter((n) => n.code === "amounts-rounded")).toEqual([]);
    runImport(alice.id, wallet(joint("2026-08-08T11:06:15+00:00", "Expense", "-83.93000000", { category: "Food" })), BXL);
    expect(entriesOf(alice.id)[0].amountMinor).toBe(8393);

    const q = previewImport(alice.id, wallet(usd("2026-10-08T08:00:15+00:00", "Expense", "-5877.66013490", { category: "Food" })), BXL);
    expect(q.notices).toContainEqual({
      code: "amounts-rounded",
      count: 1,
      message: "1 amount had more decimals than USD allows and was rounded to 2 decimals.",
    });
  });

  it("appends labels to the note, or uses them as the note, with a notice", () => {
    const r = runImport(
      alice.id,
      wallet(
        joint("2026-08-01T10:00:00+00:00", "Expense", "-10.00000000", { category: "Food", note: "lunch", labels: "🍕 work" }),
        joint("2026-08-01T11:00:00+00:00", "Expense", "-11.00000000", { category: "Food", labels: "trip" }),
        joint("2026-08-01T12:00:00+00:00", "Expense", "-12.00000000", { category: "Food", note: "plain" }),
      ),
      BXL,
    );
    expect(r.imported).toBe(true);
    expect(entriesOf(alice.id).map((e) => e.note)).toEqual(["lunch · 🍕 work", "trip", "plain"]);
    expect(r.notices).toContainEqual(expect.objectContaining({ code: "labels", count: 2 }));
    // The note limit still applies once the labels are added.
    const p = refused(wallet(joint("2026-08-01T10:00:00+00:00", "Expense", "-1.00000000", { category: "Food", note: "n".repeat(495), labels: "abcdef" })));
    expectProblems(p, [{ line: 2, message: /^Note: Keep the note under 500 characters \(with the labels added\)\.$/ }]);
  });
});

describe("Spendee timestamps", () => {
  it("converts a timestamp with an offset to the user's time zone", () => {
    expect(parseSpendeeTimestamp("2026-08-26T22:05:17+00:00", "UTC")).toMatchObject({ date: "2026-08-26", converted: true, shifted: false });
    expect(parseSpendeeTimestamp("2026-08-26T22:05:17+00:00", "Europe/Brussels")).toMatchObject({ date: "2026-08-27", shifted: true });
    // 22:05 at -05:00 is 03:05 UTC the next day; 01:30 at +02:00 is 23:30 UTC the previous day.
    expect(parseSpendeeTimestamp("2026-08-26T22:05:17-05:00", "UTC")?.date).toBe("2026-08-27");
    expect(parseSpendeeTimestamp("2026-08-27T01:30:00+02:00", "UTC")?.date).toBe("2026-08-26");
    expect(parseSpendeeTimestamp("2026-08-27T01:30:00+02:00", "Europe/Brussels")?.date).toBe("2026-08-27");
    expect(parseSpendeeTimestamp("2026-08-31T22:30:00Z", "Europe/Brussels")?.date).toBe("2026-09-01");
    expect(parseSpendeeTimestamp("2026-01-01T03:00:00+00:00", "America/New_York")?.date).toBe("2025-12-31");
  });

  it("takes timestamps without an offset as written, and rejects impossible ones", () => {
    expect(parseSpendeeTimestamp("2026-08-26 23:30:00", "Europe/Brussels")).toMatchObject({ date: "2026-08-26", converted: false });
    expect(parseSpendeeTimestamp("2026-08-26T23:30", "Pacific/Auckland")).toMatchObject({ date: "2026-08-26", converted: false });
    expect(parseSpendeeTimestamp("2026-08-26", "Pacific/Auckland")).toMatchObject({ date: "2026-08-26", converted: false });
    for (const bad of ["2026-02-30T10:00:00+00:00", "2026-08-26T24:00:00+00:00", "2026-08-26T10:00:00+25:00", "26.08.2026", "2026-08-26T10:00:00 CET"]) {
      expect(parseSpendeeTimestamp(bad, "UTC"), bad).toBeNull();
    }
  });

  it("validates the time zone, falling back to UTC", () => {
    expect(resolveTimeZone("Europe/Brussels")).toEqual({ timeZone: "Europe/Brussels", fallback: false });
    expect(resolveTimeZone(undefined)).toEqual({ timeZone: "UTC", fallback: false });
    expect(resolveTimeZone("Mars/Olympus_Mons")).toEqual({ timeZone: "UTC", fallback: true });
    expect(resolveTimeZone("x".repeat(200))).toEqual({ timeZone: "UTC", fallback: true });
    expect(dateInTimeZone(Date.UTC(2026, 7, 26, 22, 5, 17), "Europe/Brussels")).toBe("2026-08-27");
  });

  it("dates entries in the zone sent with the import and says so; an invalid zone means UTC", () => {
    const text = wallet(joint("2026-08-26T22:05:17+00:00", "Expense", "-1.00000000", { category: "Food" }));
    const p = previewImport(alice.id, text, BXL);
    expect(p.notices).toContainEqual({
      code: "time-zone",
      count: 1,
      message:
        "Spendee records the time of each entry; dates are taken in your time zone, Europe/Brussels. 1 entry falls on a different day than the UTC date in the file.",
    });
    const q = previewImport(alice.id, text, { timeZone: "Not/AZone" });
    expect(q.notices.find((n) => n.code === "time-zone")?.message).toMatch(/taken in UTC \(your browser's time zone was not recognised\)\. No entry changes day/);

    runImport(alice.id, text, BXL);
    expect(entriesOf(alice.id)[0].date).toBe("2026-08-27");
    const bob = makeUser(db, "bob@example.com");
    runImport(bob.id, text, { timeZone: "Not/AZone" });
    expect(entriesOf(bob.id)[0].date).toBe("2026-08-26");
    // The older dialect has no offsets: no conversion, no time-zone notice.
    const older = '"Date";"Wallet";"Type";"Category name";"Amount";"Currency";"Notes"\r\n"2019-04-29 23:30:00";"Cash";"expense";"Food";"-30";"RON";""\r\n';
    const o = runImport(bob.id, older, BXL);
    expect(o.notices).toEqual([]);
    expect(entriesOf(bob.id).at(-1)?.date).toBe("2019-04-29");
  });
});

describe("Spendee transfer pairing", () => {
  it("pairs a same-currency transfer across two files, dated and noted from the outgoing row", () => {
    const r = runImport(
      alice.id,
      [
        f("savings.csv", sav("2026-08-17T08:41:32+00:00", OUT, "-300.00000000", { note: "rent share" })),
        f("joint.csv", joint("2026-08-17T08:41:34+00:00", IN, "300.00000000", { note: "rent share" })),
      ],
      BXL,
    );
    expect(r).toMatchObject({ imported: true, transactionsToAdd: 0, transfersToAdd: 1, unpairedTransfers: 0, categoriesToCreate: [] });
    expect(transfersOf(alice.id)).toEqual([{ from: "Savings €", to: "Joint", sent: 30000, received: 30000, date: "2026-08-17", note: "rent share" }]);
  });

  it("pairs a cross-currency transfer (different amounts), also when the incoming row is earlier", () => {
    const r = runImport(
      alice.id,
      [
        f("usd.csv", usd("2026-10-08T08:00:15+00:00", OUT, "-100.00000000")),
        f("ron.csv", ron("2026-10-08T08:00:13+00:00", IN, "470.12000000")),
      ],
      BXL,
    );
    expect(r).toMatchObject({ imported: true, transfersToAdd: 1 });
    expect(transfersOf(alice.id)).toEqual([{ from: "Biz $", to: "Lei", sent: 10000, received: 47012, date: "2026-10-08", note: null }]);
  });

  it("pairs one file holding both rows", () => {
    const r = runImport(alice.id, wallet(sav("2026-08-17T08:41:32+00:00", OUT, "-1.00000000"), joint("2026-08-17T08:41:32+00:00", IN, "1.00000000")), BXL);
    expect(r).toMatchObject({ imported: true, transfersToAdd: 1 });
  });

  it("keeps close transfers between the same wallets apart: closest in time first", () => {
    const r = runImport(
      alice.id,
      [
        f(
          "usd.csv",
          usd("2026-10-08T08:00:00+00:00", OUT, "-100.00000000"),
          usd("2026-10-08T08:00:08+00:00", OUT, "-50.00000000"),
          usd("2026-10-08T09:00:00+00:00", OUT, "-20.00000000"),
          usd("2026-10-08T09:00:18+00:00", OUT, "-30.00000000"),
        ),
        f(
          "ron.csv",
          ron("2026-10-08T08:00:01+00:00", IN, "470.00000000"),
          ron("2026-10-08T08:00:09+00:00", IN, "235.00000000"),
          ron("2026-10-08T09:00:02+00:00", IN, "94.00000000"),
          ron("2026-10-08T09:00:19+00:00", IN, "141.00000000"),
        ),
      ],
      BXL,
    );
    expect(r).toMatchObject({ imported: true, transfersToAdd: 4 });
    expect(transfersOf(alice.id).map((t) => [t.sent, t.received])).toEqual([
      [10000, 47000],
      [5000, 23500],
      [2000, 9400],
      [3000, 14100],
    ]);
  });

  it("pairs equal-amount transfers on different days separately", () => {
    const r = runImport(
      alice.id,
      [
        f("savings.csv", sav("2026-08-01T08:00:00+00:00", OUT, "-300.00000000"), sav("2026-08-15T08:00:00+00:00", OUT, "-300.00000000")),
        f("joint.csv", joint("2026-08-15T08:00:01+00:00", IN, "300.00000000"), joint("2026-08-01T08:00:02+00:00", IN, "300.00000000")),
      ],
      BXL,
    );
    expect(r).toMatchObject({ imported: true, transfersToAdd: 2 });
    expect(transfersOf(alice.id).map((t) => t.date)).toEqual(["2026-08-01", "2026-08-15"]);
  });

  it("pairs identical rows one-to-one: the result is the same whichever is chosen", () => {
    const r = runImport(
      alice.id,
      [
        f("savings.csv", sav("2026-08-01T08:00:00+00:00", OUT, "-25.00000000"), sav("2026-08-01T08:00:00+00:00", OUT, "-25.00000000")),
        f("joint.csv", joint("2026-08-01T08:00:01+00:00", IN, "25.00000000"), joint("2026-08-01T08:00:01+00:00", IN, "25.00000000")),
      ],
      BXL,
    );
    expect(r).toMatchObject({ imported: true, transfersToAdd: 2, unpairedTransfers: 0 });
  });

  it("refuses to guess between candidates at the same distance that would give different results", () => {
    const p = refused([
      f("usd.csv", usd("2026-10-08T08:00:10+00:00", OUT, "-100.00000000")),
      f("ron.csv", ron("2026-10-08T08:00:09+00:00", IN, "470.00000000"), ron("2026-10-08T08:00:11+00:00", IN, "480.00000000")),
    ]);
    expect(p.problemCount).toBe(1);
    expectProblems(p, [{ file: "usd.csv", line: 2, message: /cannot be paired without guessing.*usd\.csv, line 2.*ron\.csv, line 2.*ron\.csv, line 3/ }]);
  });

  it("blocks unpaired rows by default, naming file and line, and imports them as Transfer entries when asked", () => {
    const files = [
      f("savings.csv", sav("2026-08-01T08:00:00+00:00", OUT, "-40.00000000", { note: "to an old wallet" }), sav("2026-08-03T08:00:00+00:00", "Expense", "-1.00000000", { category: "Food" })),
      f("joint.csv", joint("2026-08-02T08:00:00+00:00", IN, "60.00000000", { labels: "gift" })),
    ];
    const p = refused(files);
    expect(p).toMatchObject({ problemCount: 2, unpairedTransfers: 2 });
    expectProblems(p, [
      { file: "savings.csv", line: 2, message: /^Outgoing transfer of 40\.00 EUR from “Savings €” on 2026-08-01 has no matching Incoming Transfer row.*Select the other wallet's Spendee export/ },
      { file: "joint.csv", line: 2, message: /^Incoming transfer of 60\.00 EUR to “Joint” on 2026-08-02 has no matching Outgoing Transfer row.*Import unpaired transfers as income \/ expense/ },
    ]);

    const opts = { ...BXL, unpairedTransfersAsEntries: true };
    const q = previewImport(alice.id, files, opts);
    expect(q).toMatchObject({ ok: true, transactionsToAdd: 3, transfersToAdd: 0, unpairedTransfers: 2 });
    expect(q.categoriesToCreate).toEqual(expect.arrayContaining([{ name: "Transfer", kind: "expense" }, { name: "Transfer", kind: "income" }]));
    expect(q.notices).toContainEqual(expect.objectContaining({ code: "unpaired-transfers", count: 2 }));
    expect(runImport(alice.id, files, opts).imported).toBe(true);
    expect(entriesOf(alice.id)).toEqual([
      { wallet: "Savings €", kind: "expense", category: "Food", amountMinor: 100, date: "2026-08-03", note: null },
      { wallet: "Savings €", kind: "expense", category: "Transfer", amountMinor: 4000, date: "2026-08-01", note: "to an old wallet" },
      { wallet: "Joint", kind: "income", category: "Transfer", amountMinor: 6000, date: "2026-08-02", note: "gift" },
    ]);
    // Re-importing with the option adds nothing.
    expect(previewImport(alice.id, files, opts)).toMatchObject({ ok: true, transactionsToAdd: 0, duplicateTransactions: 3 });
  });

  it.each([
    ["the same wallet", [joint("2026-08-01T08:00:00+00:00", OUT, "-5.00000000")], [joint("2026-08-01T08:00:01+00:00", IN, "5.00000000")]],
    ["different notes", [sav("2026-08-01T08:00:00+00:00", OUT, "-5.00000000", { note: "a" })], [joint("2026-08-01T08:00:01+00:00", IN, "5.00000000", { note: "b" })]],
    ["11 seconds apart", [sav("2026-08-01T08:00:00+00:00", OUT, "-5.00000000")], [joint("2026-08-01T08:00:11+00:00", IN, "5.00000000")]],
    ["different amounts in one currency", [sav("2026-08-01T08:00:00+00:00", OUT, "-5.00000000")], [joint("2026-08-01T08:00:01+00:00", IN, "5.01000000")]],
  ])("never pairs rows in %s", (_, outRows, inRows) => {
    const p = refused([f("a.csv", ...outRows), f("b.csv", ...inRows)]);
    expect(p).toMatchObject({ problemCount: 2, unpairedTransfers: 2 });
  });

  it("pairs rows exactly 10 seconds apart", () => {
    const r = previewImport(alice.id, [f("a.csv", sav("2026-08-01T08:00:00+00:00", OUT, "-5.00000000")), f("b.csv", joint("2026-08-01T08:00:10+00:00", IN, "5.00000000"))], BXL);
    expect(r).toMatchObject({ ok: true, transfersToAdd: 1 });
  });
});

// A three-wallet selection used below: EUR savings, EUR joint, USD; a same-currency and a cross-currency transfer
// (one each way), labels, and a late-evening UTC entry that lands on the next day in Brussels.
const SAVINGS = f(
  "savings.csv",
  sav("2026-08-01T09:00:00+00:00", "Income", "1000.00000000", { category: "Salary" }),
  sav("2026-08-17T08:41:32+00:00", OUT, "-300.00000000", { note: "rent share" }),
  sav("2026-08-31T22:30:00+00:00", "Expense", "-12.50000000", { category: "Food", labels: "late" }),
  sav("2026-09-02T10:00:02+00:00", IN, "45.10000000"),
);
const JOINT = f(
  "joint.csv",
  joint("2026-08-17T08:41:34+00:00", IN, "300.00000000", { note: "rent share" }),
  joint("2026-08-20T12:00:00+00:00", "Expense", "-83.93000000", { category: "Groceries" }),
  joint("2026-08-21T12:00:00+00:00", "Expense", "-83.93000000", { category: "Groceries", note: "again" }),
);
const DOLLARS = f(
  "usd.csv",
  usd("2026-08-05T09:00:00+00:00", "Income", "500.00000000", { category: "Salary" }),
  usd("2026-09-02T10:00:00+00:00", OUT, "-50.00000000"),
  usd("2026-09-03T10:00:00+00:00", "Expense", "-9.99500000", { category: "Food" }),
);
const SELECTION = [SAVINGS, JOINT, DOLLARS];

describe("importing several files at once", () => {
  it("previews and imports the selection as one import, with balances that add up", () => {
    const p = previewImport(alice.id, SELECTION, BXL);
    expect(p).toMatchObject({
      ok: true,
      format: "spendee",
      formatLabel: "Spendee export",
      transactionsToAdd: 6,
      transfersToAdd: 2,
      unpairedTransfers: 0,
      files: [
        { name: "savings.csv", format: "spendee", formatLabel: "Spendee export", rows: 4 },
        { name: "joint.csv", format: "spendee", rows: 3 },
        { name: "usd.csv", format: "spendee", rows: 3 },
      ],
      walletsToCreate: [
        { name: "Savings €", currency: "EUR" },
        { name: "Joint", currency: "EUR" },
        { name: "Biz $", currency: "USD" },
      ],
    });
    expect(p.notices.map((n) => [n.code, n.count])).toEqual([
      ["time-zone", 10],
      ["labels", 1],
      ["amounts-rounded", 1],
    ]);
    expect(p.notices.every((n) => n.file === undefined)).toBe(true);

    const r = runImport(alice.id, SELECTION, BXL);
    expect(r).toMatchObject({ imported: true, transactionsToAdd: 6, transfersToAdd: 2 });
    expect(entriesOf(alice.id).find((e) => e.note === "late")?.date).toBe("2026-09-01");
    // Independently: income − expenses ± transfers, per wallet, in minor units.
    const balance = Object.fromEntries(listWallets(alice.id).map((w) => [w.name, w.balanceMinor]));
    expect(balance).toEqual({
      "Savings €": 100000 - 30000 - 1250 + 4510,
      Joint: 30000 - 8393 - 8393,
      "Biz $": 50000 - 5000 - 1000,
    });
    expect(transfersOf(alice.id)).toEqual([
      { from: "Savings €", to: "Joint", sent: 30000, received: 30000, date: "2026-08-17", note: "rent share" },
      { from: "Biz $", to: "Savings €", sent: 5000, received: 4510, date: "2026-09-02", note: null },
    ]);
  });

  it("adds nothing when the same selection is imported again (transfers included), in any order", () => {
    runImport(alice.id, SELECTION, BXL);
    const before = snapshot();
    const r = runImport(alice.id, [DOLLARS, JOINT, SAVINGS], BXL);
    expect(r).toMatchObject({
      imported: true,
      transactionsToAdd: 0,
      transfersToAdd: 0,
      duplicateTransactions: 6,
      duplicateTransfers: 2,
      walletsToCreate: [],
      categoriesToCreate: [],
    });
    expect(snapshot()).toEqual(before);
  });

  it("names the file on problems when there are several files, but not for one file", () => {
    const bad = f("joint.csv", joint("2026-08-20T12:00:00+00:00", "Expense", "-abc", { category: "Groceries" }));
    const p = refused([SAVINGS, bad, DOLLARS]);
    expectProblems(p, [{ file: "joint.csv", line: 2, message: /^Amount: “-abc” is not a valid amount/ }]);
    // savings.csv's rent transfer lost its partner (the bad file's row was a different one): its row is reported too.
    expect(p.problems.map((x) => `${x.file}:${x.line}`)).toEqual(["savings.csv:3", "joint.csv:2"]);
    const single = previewImport(alice.id, [bad], BXL);
    expect(single.problems[0]).toEqual({ line: 2, message: expect.stringMatching(/^Amount:/) });
    expect(single.files).toEqual([{ name: "joint.csv", format: "spendee", formatLabel: "Spendee export", rows: 1 }]);
  });

  it("is all or nothing: one bad line in one file writes nothing from any file", () => {
    const bad = f("extra.csv", { at: "2026-08-20 12:00", wallet: "Cash", type: "Expense", amount: "-1", currency: "EUR", category: "" });
    const p = refused([...SELECTION, bad]);
    expect(p).toMatchObject({ problemCount: 1, problems: [{ file: "extra.csv", line: 2, message: "Category name: Required." }] });
  });

  it("uses a file selected twice once, with a notice", () => {
    const p = previewImport(alice.id, [SAVINGS, JOINT, { ...JOINT, name: "joint (1).csv" }, DOLLARS], BXL);
    expect(p).toMatchObject({ ok: true, transactionsToAdd: 6, transfersToAdd: 2 });
    expect(p.files[2]).toEqual({ name: "joint (1).csv", format: "spendee", formatLabel: "Spendee export", rows: null, duplicateOf: "joint.csv" });
    expect(p.notices[0]).toEqual({
      code: "duplicate-file",
      count: 1,
      file: "joint (1).csv",
      message: "“joint (1).csv” has the same content as “joint.csv”, so it is imported once.",
    });
  });

  it("refuses a backup combined with other files", () => {
    createWallet(alice.id, { name: "Main", currency: "EUR", initialBalanceMinor: 0 });
    const backup = { name: "backup.json", text: JSON.stringify(buildBackup(alice.id)) };
    const p = refused([backup, { name: "t.csv", text: "date,type,wallet,currency,amount,category\n2026-01-01,expense,Main,EUR,1,Food\n" }]);
    expect(p.problems).toEqual([{ message: expect.stringMatching(/^A backup has to be imported on its own: “backup\.json” is a backup/) }]);
    expect(p.files.map((x) => [x.format, x.rows])).toEqual([["backup", null], ["csv", null]]);
    // On its own it is fine (and a backup selected twice is still one backup).
    expect(previewImport(alice.id, [backup, { ...backup, name: "copy.json" }])).toMatchObject({ ok: true, format: "backup" });
  });

  it("applies the limits to the whole selection", () => {
    const half = "x".repeat(IMPORT_MAX_BYTES / 2 + 10);
    expect(refused([{ name: "a.csv", text: half }, { name: "b.csv", text: half + "y" }]).problems[0].message).toMatch(/larger than 5 MB in total/);
    const many = Array.from({ length: IMPORT_MAX_FILES + 1 }, (_, i) => ({ name: `${i}.csv`, text: `date\n${i}` }));
    expect(refused(many).problems[0].message).toBe("51 files were selected; the limit is 50 per import.");
    const rows = (n: number, w: string) =>
      "date,type,wallet,currency,amount,category\n" + Array.from({ length: n }, () => `2026-01-01,expense,${w},EUR,1,Food`).join("\n");
    expect(refused([{ name: "a.csv", text: rows(25_000, "A") }, { name: "b.csv", text: rows(25_001, "B") }]).problems[0].message).toMatch(
      /^The selected files have 50,001 rows in total; the limit is 50,000 per import/,
    );
    expect(refused([]).problems[0].message).toBe("No file was received.");
    const fine = f("fine.csv", joint("2026-08-20T12:00:00+00:00", "Expense", "-1.00000000", { category: "Food" }));
    expect(refused([{ name: "empty.csv", text: " \n" }, fine]).problems).toEqual([{ file: "empty.csv", message: "The file is empty." }]);
  });

  it("mixes a native CSV and Spendee files in one selection, merging wallets and categories", () => {
    const native = {
      name: "manual.csv",
      text: toCsv([
        ["date", "type", "wallet", "currency", "amount", "category", "note", "to_wallet", "to_currency", "to_amount"],
        ["2026-08-25", "expense", "joint", "EUR", "10.00", "groceries", "", "", "", ""],
        ["2026-08-26", "transfer", "Joint", "EUR", "5.00", "", "", "Cash", "EUR", ""],
      ]),
    };
    // JOINT's incoming rent transfer has no partner in this selection.
    const p = previewImport(alice.id, [JOINT, native], BXL);
    expect(p).toMatchObject({ ok: false, format: null, formatLabel: "Spendee export + Transactions (CSV)", unpairedTransfers: 1 });
    expect(p.files.map((x) => x.format)).toEqual(["spendee", "csv"]);
    const r = runImport(alice.id, [JOINT, native], { ...BXL, unpairedTransfersAsEntries: true });
    expect(r).toMatchObject({ imported: true, transactionsToAdd: 4, transfersToAdd: 1 });
    // "joint" in the CSV is the Spendee file's "Joint" wallet; "groceries" its "Groceries" category.
    expect(r.walletsToCreate.map((w) => w.name)).toEqual(["Joint", "Cash"]);
    expect(entriesOf(alice.id).filter((e) => e.category?.toLowerCase() === "groceries")).toHaveLength(3);
    expect(new Set(entriesOf(alice.id).map((e) => e.category))).toEqual(new Set(["Groceries", "Transfer"]));
  });

  it("keeps a native CSV's own rules and a native-only selection unchanged", () => {
    createWallet(alice.id, { name: "Main", currency: "EUR", initialBalanceMinor: 0 });
    createTransaction(alice.id, { walletId: listWallets(alice.id)[0].id, kind: "expense", categoryId: alice.cat("Food"), amountMinor: 100, date: "2026-01-01" });
    const csv = buildTransactionsCsv(alice.id);
    const bob = makeUser(db, "bob@example.com");
    expect(previewImport(bob.id, [{ name: "a.csv", text: csv }])).toMatchObject({ ok: true, format: "csv", transactionsToAdd: 1, notices: [] });
    expect(previewImport(bob.id, [{ name: "a.csv", text: csv }, { name: "b.csv", text: csv.replace("2026-01-01", "2026-01-02") }])).toMatchObject({
      ok: true,
      format: "csv",
      transactionsToAdd: 2,
      walletsToCreate: [{ name: "Main", currency: "EUR" }],
    });
  });

  it("creates everything under the importing user only", () => {
    runImport(alice.id, SELECTION, BXL);
    const before = snapshot();
    const bob = makeUser(db, "bob@example.com");
    const r = runImport(bob.id, SELECTION, BXL);
    expect(r).toMatchObject({ imported: true, transactionsToAdd: 6, transfersToAdd: 2, duplicateTransactions: 0, duplicateTransfers: 0 });
    const onlyAlice = (s: ReturnType<typeof snapshot>) => ({
      wallets: s.wallets.filter((x) => x.userId === alice.id),
      categories: s.categories.filter((x) => x.userId === alice.id),
      transfers: s.transfers.filter((x) => x.userId === alice.id),
      transactions: s.transactions.filter((x) => x.userId === alice.id),
    });
    expect(onlyAlice(snapshot())).toEqual(onlyAlice(before));
    expect(transfersOf(bob.id)).toEqual(transfersOf(alice.id));
    const aliceIds = new Set(listWallets(alice.id).map((w) => w.id));
    expect(listWallets(bob.id).some((w) => aliceIds.has(w.id))).toBe(false);
    const aliceCategories = new Set(listCategories(alice.id).map((c) => c.id));
    expect(listCategories(bob.id).some((c) => aliceCategories.has(c.id))).toBe(false);
  });
});
