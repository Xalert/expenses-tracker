// The statement importer (tools/statement-importer/index.html, a claude.ai Artifact) writes the app's transactions
// CSV with its own small copy of the CSV rules. These tests run the page's pure core (the <script id="importer-core">
// block, evaluated as-is) over the harness fixtures and feed the result to the app's own importer, so the two stay
// byte-compatible.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { beforeEach, describe, expect, it } from "vitest";
import { contextSchema } from "@/lib/context-format";
import { escapeFormula, toCsv } from "@/lib/csv";
import { buildContext } from "@/server/export";
import { previewImport, runImport } from "@/server/import";
import { archiveWallet, createWallet } from "@/server/wallets";
import { makeUser, useFreshDb } from "./helpers";

const TOOL = path.resolve(import.meta.dirname, "../tools/statement-importer");
const FIXTURES = path.join(TOOL, "dev/fixtures");

type Wallet = { name: string; currency: string };
type Account = Record<string, string | null>;
type ReadRow = { date: string; description: string; merchant: string; direction: "in" | "out" };
type SettledRow = ReadRow & { minor: number; foreign: { amount: string; currency: string } | null };
type ExportItem = {
  date: string;
  kind: "expense" | "income" | "transfer";
  direction: "in" | "out";
  wallet: Wallet;
  minor: number;
  category: string | null;
  note: string;
  other: Wallet | null;
  otherMinor: number | null;
};
type TrackerExport = {
  error?: string;
  source: "context" | "backup";
  wallets: Wallet[];
  categories: { name: string; kind: string }[];
  archivedSkipped: number;
  unreadable: number;
  exportedAt: string | null;
};
type Core = {
  merchantKey(s: string): string;
  readTrackerExport(text: string): TrackerExport;
  compareConfig(
    current: { wallets: Wallet[]; categories: { name: string; kind: string }[] },
    incoming: { wallets: Wallet[]; categories: { name: string; kind: string }[] },
  ): Record<string, unknown>;
  readLoaded(doc: unknown): unknown;
  readExtraction(data: unknown): { error?: string; account: Account; rows: ReadRow[]; dropped: unknown[] };
  settleStatement(account: Account, rows: ReadRow[]): { error?: string; currency: string; rows: SettledRow[]; dropped: unknown[] };
  pairTransfers(
    cands: { id: number; order: number; wallet: string; currency: string; minor: number; direction: string; date: string; forcedOther: string | null }[],
    blocked: Set<string>,
  ): { outId: number; inId: number }[];
  exportRecords(items: ExportItem[]): string[][];
  toCsv(rows: string[][], bom?: boolean): string;
  escapeFormula(v: string): string;
};

function loadCore(): Core {
  const html = fs.readFileSync(path.join(TOOL, "index.html"), "utf8");
  const m = /<script id="importer-core">([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new Error("importer-core script not found in index.html");
  const context = vm.createContext({});
  vm.runInContext(m[1], context);
  return (context as unknown as { ImporterCore: Core }).ImporterCore;
}

const core = loadCore();
const answers = JSON.parse(fs.readFileSync(path.join(FIXTURES, "answers/extraction.json"), "utf8")) as Record<string, unknown>;

/** The wallet chosen for each fixture statement in the harness walkthrough. */
const WALLETS: Record<string, Wallet> = {
  "ro-bank.csv": { name: "ING Current", currency: "RON" },
  "savings.txt": { name: "Savings", currency: "RON" },
  "uk-bank.csv": { name: "Northbank", currency: "GBP" },
  "wise.csv": { name: "Wise EUR", currency: "EUR" },
  "card-statement.pdf": { name: "Card EUR", currency: "EUR" },
  "scanned-statement.pdf": { name: "Card EUR", currency: "EUR" },
  "credit-card-scan.png": { name: "Credit Card", currency: "RON" },
};
const CATEGORIES: Record<string, string> = {
  lidl: "Groceries", tesco: "Groceries", kaufland: "Groceries", "mega image": "Groceries", "albert heijn": "Groceries",
  uber: "Transport", bolt: "Transport", "tfl travel": "Transport", "omv petrom": "Transport",
  netflix: "Subscriptions", spotify: "Subscriptions", github: "Subscriptions",
  "enel energie": "Bills", "digi romania": "Bills", "pret a manger": "Food", emag: "Shopping",
  "acme software": "Salary", "acme design": "Extra Income", amazon: "Refund",
  "dobanda bonificata": "Interest", "impozit dobanda": "Fees", "comision administrare cont": "Fees",
};
const wkey = (w: Wallet) => `${w.name.toLowerCase()}|${w.currency}`;

/** The page's flow without the DOM: validate, settle, pair, categorise, export. */
function buildScenarioCsv() {
  type Row = SettledRow & { id: number; file: string; wallet: Wallet };
  const rows: Row[] = [];
  let dropped = 0;
  let id = 1;
  for (const file of Object.keys(WALLETS)) {
    const read = core.readExtraction(answers[file]);
    expect(read.error).toBeUndefined();
    const settled = core.settleStatement(read.account, read.rows);
    expect(settled.error).toBeUndefined();
    expect(settled.currency).toBe(WALLETS[file].currency);
    dropped += read.dropped.length + settled.dropped.length;
    for (const r of settled.rows) rows.push({ ...r, id: id++, file, wallet: WALLETS[file] });
  }
  const pairs = core.pairTransfers(
    rows.map((r) => ({ id: r.id, order: r.id, wallet: wkey(r.wallet), currency: r.wallet.currency, minor: r.minor, direction: r.direction, date: r.date, forcedOther: null })),
    new Set(),
  );
  const mirrors = new Set(pairs.map((p) => p.inId));
  const transferTo = new Map(pairs.map((p) => [p.outId, rows.find((r) => r.id === p.inId)!.wallet]));
  const items: ExportItem[] = rows
    .filter((r) => !mirrors.has(r.id))
    .map((r): ExportItem => {
      const note = r.description + (r.foreign ? ` (${r.foreign.amount} ${r.foreign.currency})` : "");
      const other = transferTo.get(r.id);
      if (other) return { date: r.date, kind: "transfer", direction: r.direction, wallet: r.wallet, minor: r.minor, category: null, note, other, otherMinor: null };
      const category = CATEGORIES[core.merchantKey(r.merchant)];
      if (!category) throw new Error(`no category for ${r.merchant}`);
      return { date: r.date, kind: r.direction === "out" ? "expense" : "income", direction: r.direction, wallet: r.wallet, minor: r.minor, category, note, other: null, otherMinor: null };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
  return { csv: core.toCsv(core.exportRecords(items), true), pairs, rows, dropped };
}

const EXPECTED_WALLETS = Object.values(WALLETS)
  .filter((w, i, all) => all.findIndex((x) => wkey(x) === wkey(w)) === i)
  .map((w) => `${w.name} ${w.currency}`)
  .sort();
const EXPECTED_NEW_CATEGORIES = ["expense Fees", "expense Shopping", "expense Subscriptions", "income Interest"];

describe("statement importer core", () => {
  it("computes merchant keys as listed in the harness checks", () => {
    const cases = JSON.parse(fs.readFileSync(path.join(FIXTURES, "merchant-keys.json"), "utf8")) as [string, string][];
    expect(cases.length).toBeGreaterThanOrEqual(12);
    for (const [input, key] of cases) expect(core.merchantKey(input), input).toBe(key);
  });

  it("serialises CSV exactly like the app (quoting, formula guard, BOM, CRLF)", () => {
    const values = ["plain", "a,b", 'say "hi"', "two\nlines", "cr\rhere", "-minus", "=SUM(A1)", "+1", "@x", "'quoted", "\tTab", "  spaced  ", "Plată ș ț"];
    const rows = [["date", "note"], ...values.map((v) => ["2026-10-01", core.escapeFormula(v)])];
    expect(rows.slice(1).map((r) => r[1])).toEqual(values.map(escapeFormula));
    expect(core.toCsv(rows, true)).toBe(toCsv(rows));
    expect(core.toCsv(rows, false)).toBe(toCsv(rows, { bom: false }));
  });

  it("drops invalid model rows and pairs the transfer between the two statements", () => {
    const { pairs, rows, dropped } = buildScenarioCsv();
    expect(dropped).toBe(2); // wise.csv: an impossible date and "1,000.00"
    expect(pairs).toHaveLength(1);
    const out = rows.find((r) => r.id === pairs[0].outId)!;
    const inn = rows.find((r) => r.id === pairs[0].inId)!;
    expect([out.file, out.date, inn.file, inn.date]).toEqual(["ro-bank.csv", "2026-10-03", "savings.txt", "2026-10-04"]);
  });
});

describe("statement importer CSV is accepted by the app's importer", () => {
  let userId: number;
  beforeEach(() => {
    const db = useFreshDb();
    userId = makeUser(db, "statements@example.com").id;
  });

  function expectAccepted(csv: string) {
    const preview = previewImport(userId, csv);
    expect(preview.problems).toEqual([]);
    expect(preview.ok).toBe(true);
    expect(preview.format).toBe("csv");
    expect(preview.transactionsToAdd).toBe(36);
    expect(preview.transfersToAdd).toBe(1);
    expect(preview.walletsToCreate.map((w) => `${w.name} ${w.currency}`).sort()).toEqual(EXPECTED_WALLETS);
    expect(preview.categoriesToCreate.map((c) => `${c.kind} ${c.name}`).sort()).toEqual(EXPECTED_NEW_CATEGORIES);
  }

  it("accepts the CSV built by the page's core from the fixture answers", () => {
    expectAccepted(buildScenarioCsv().csv);
  });

  it("accepts the CSV the harness page downloaded, and skips it all on a second import", () => {
    const csv = fs.readFileSync(path.join(FIXTURES, "harness-export.csv"), "utf8");
    expectAccepted(csv);
    const result = runImport(userId, csv);
    expect(result.imported).toBe(true);
    const again = previewImport(userId, csv);
    expect(again.problems).toEqual([]);
    expect(again.transactionsToAdd).toBe(0);
    expect(again.transfersToAdd).toBe(0);
    expect(again.duplicateTransactions).toBe(36);
    expect(again.duplicateTransfers).toBe(1);
  });

  it("the harness download equals what the core builds from the same answers and choices", () => {
    expect(fs.readFileSync(path.join(FIXTURES, "harness-export.csv"), "utf8")).toBe(buildScenarioCsv().csv);
  });

  it("keeps a leading minus in a note through the formula guard", () => {
    const csv = buildScenarioCsv().csv;
    expect(csv).toContain(",'-Comision administrare cont,");
    const exported = fs.readFileSync(path.join(FIXTURES, "harness-export.csv"), "utf8");
    expect(exported).toContain(",'-Comision administrare cont,");
  });
});

describe("statement importer reads the tracker's wallets & categories", () => {
  // Results come from another VM realm: compare plain copies.
  const read = (text: string) => JSON.parse(JSON.stringify(core.readTrackerExport(text))) as TrackerExport;
  const fixture = (name: string) => fs.readFileSync(path.join(FIXTURES, name), "utf8");

  it("reads the context file fixture, which matches the app's context schema", () => {
    const text = fixture("tracker-context.json");
    expect(contextSchema.safeParse(JSON.parse(text)).success).toBe(true);
    const r = read(text);
    expect(r.error).toBeUndefined();
    expect(r.source).toBe("context");
    expect(r.exportedAt).toBe("2026-11-01");
    expect(r.wallets).toHaveLength(6);
    expect(r.wallets).toContainEqual({ name: "ING Current", currency: "RON" });
    expect(r.wallets.some((w) => w.name === "Old Visa")).toBe(false);
    expect(r.archivedSkipped).toBe(1);
    expect(r.unreadable).toBe(0);
    expect(r.categories).toHaveLength(12);
    expect(r.categories).toContainEqual({ name: "Interest", kind: "income" });
  });

  it("still reads a full backup, with the same lists as the context file", () => {
    const ctx = read(fixture("tracker-context.json"));
    const bak = read(fixture("tracker-backup.json"));
    expect(bak.source).toBe("backup");
    expect([bak.wallets, bak.categories, bak.archivedSkipped]).toEqual([ctx.wallets, ctx.categories, ctx.archivedSkipped]);
  });

  it("reads what the app's buildContext produces", () => {
    const db = useFreshDb();
    const user = makeUser(db, "ctx@example.com");
    createWallet(user.id, { name: "Main", currency: "EUR", initialBalanceMinor: 0 });
    const old = createWallet(user.id, { name: "Old", currency: "USD", initialBalanceMinor: 0 });
    archiveWallet(user.id, old.id);
    const r = read(JSON.stringify(buildContext(user.id), null, 2));
    expect(r.source).toBe("context");
    expect(r.wallets).toEqual([{ name: "Main", currency: "EUR" }]);
    expect(r.archivedSkipped).toBe(1);
    expect(r.categories.length).toBeGreaterThan(5);
  });

  it("refuses junk with a clear error", () => {
    for (const junk of ["hello", "", "[1,2]", "{}", '{"wallets":[],"categories":[]}', '{"app":"other","kind":"context","version":1,"wallets":[],"categories":[]}', fixture("ro-bank.csv")]) {
      expect(read(junk).error, junk.slice(0, 40)).toBeTruthy();
    }
    expect(read("hello").error).toMatch(/not a tracker export/);
    expect(read('{"app":"expenses-tracker","kind":"context","version":2,"wallets":[],"categories":[]}').error).toMatch(/newer version/);
    expect(read('{"app":"expenses-tracker","kind":"context","version":1}').error).toMatch(/incomplete/);
  });

  it("leaves out and counts invalid or repeated entries, ignoring unknown fields", () => {
    const r = read(
      JSON.stringify({
        app: "expenses-tracker",
        kind: "context",
        version: 1,
        extra: { anything: true },
        wallets: [
          { name: "A", currency: "EUR", archived: false, id: 3 },
          { name: "B", currency: "EURO" },
          { name: 5, currency: "EUR" },
          { name: "a", currency: "eur" },
        ],
        categories: [{ name: "X", kind: "expense" }, { name: "Y", kind: "transfer" }, "Z"],
      }),
    );
    expect(r.wallets).toEqual([{ name: "A", currency: "EUR" }]);
    expect(r.categories).toEqual([{ name: "X", kind: "expense" }]);
    expect(r.unreadable).toBe(5);
  });

  it("compares a loaded file with the current lists, and reads back the loaded note", () => {
    const diff = JSON.parse(
      JSON.stringify(
        core.compareConfig(
          { wallets: [{ name: "Main", currency: "EUR" }, { name: "Gone", currency: "EUR" }], categories: [{ name: "food", kind: "expense" }] },
          { wallets: [{ name: "main", currency: "EUR" }, { name: "New", currency: "RON" }], categories: [{ name: "Food", kind: "expense" }, { name: "Pay", kind: "income" }] },
        ),
      ),
    );
    expect(diff).toEqual({
      newWallets: [{ name: "New", currency: "RON" }],
      knownWallets: 1,
      removedWallets: [{ name: "Gone", currency: "EUR" }],
      newCategories: [{ name: "Pay", kind: "income" }],
      knownCategories: 1,
      removedCategories: [],
    });
    const loaded = { source: "context", loadedAt: "2026-11-08T10:00:00.000Z", wallets: 6, categories: 12 };
    expect(JSON.parse(JSON.stringify(core.readLoaded({ loaded })))).toEqual(loaded);
    expect(core.readLoaded({ loaded: { ...loaded, source: "other" } })).toBeNull();
    expect(core.readLoaded({ loaded: { ...loaded, loadedAt: "yesterday" } })).toBeNull();
    expect(core.readLoaded({})).toBeNull();
  });
});
