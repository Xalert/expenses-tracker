// The statement importer reads ING Romania / ING Business / Wise CSV exports and Revolut statement PDFs itself
// (no Claude). These tests run its pure core (the <script id="importer-core"> block, evaluated as-is) over synthetic
// fixtures in each bank's layout, and feed what it builds to the app's own importer.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { beforeEach, describe, expect, it } from "vitest";
import { previewImport } from "@/server/import";
import { makeUser, useFreshDb } from "./helpers";

const TOOL = path.resolve(import.meta.dirname, "../tools/statement-importer");
const FIXTURES = path.join(TOOL, "dev/fixtures/banks");

type Row = {
  date: string; booked: string | null; merchant: string; description: string; amount: string; direction: "in" | "out";
  currency: string | null; accountAmount: string | null; balance: string | null; fx: { currency: string; amount: string } | null;
  card: boolean; leftOut: string | null;
};
type Account = { name: string | null; identifier: string | null; currency: string | null; bank: string | null };
type Statement = { account: Account; rows: Row[]; skipped: { summary: string; reason: string }[] };
type Parsed = { format: string; label: string; statements: Statement[]; notes?: string[] };
type Settled = { error?: string; currency: string; rows: (Row & { minor: number; foreign: { amount: string; currency: string } | null })[] };
type Core = {
  parseKnownText(text: string, fileName: string): Parsed | null;
  parseRevolut(pages: unknown): Parsed;
  isRevolutPdf(lines: unknown): boolean;
  pdfLines(items: unknown): { y: number; cells: { x: number; s: string }[] }[];
  settleStatement(account: Account, rows: Row[]): Settled;
  accountSignature(account: Account): string;
  signatureId(sig: string): string;
  overlapKey(sigId: string, row: unknown): string | null;
  decimalToMinor(v: string, currency: string): number | null;
  pairTransfers(cands: unknown[], blocked: Set<string>): { outId: number; inId: number; otherMinor?: number }[];
  exportRecords(items: unknown[]): string[][];
  toCsv(rows: string[][], bom?: boolean): string;
};

function loadCore(): Core {
  const html = fs.readFileSync(path.join(TOOL, "index.html"), "utf8");
  const m = /<script id="importer-core">([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new Error("no importer-core block");
  const ctx: { ImporterCore?: Core } = {};
  vm.createContext(ctx);
  vm.runInContext(m[1], ctx);
  return ctx.ImporterCore!;
}
const core = loadCore();
const read = (name: string) => fs.readFileSync(path.join(FIXTURES, name), "utf8");
const parse = (name: string) => {
  const p = core.parseKnownText(read(name), name);
  if (!p) throw new Error(`${name} was not recognised`);
  return p;
};
const net = (s: Settled) => s.rows.reduce((a, r) => a + (r.direction === "in" ? r.minor : -r.minor), 0);

describe("known statement formats", () => {
  it("leaves other text to Claude", () => {
    expect(core.parseKnownText("Date,Description,Amount\n2026-01-01,Coffee,-3.00\n", "x.csv")).toBeNull();
  });

  it("ING Romania: multi-line records, the payment date, the booking date and foreign amounts", () => {
    const p = parse("ing-ro.csv");
    expect(p.format).toBe("ing-ro");
    const [st] = p.statements;
    expect(st.account).toMatchObject({ bank: "ING", name: "Ion Popescu", currency: "RON", identifier: null });
    expect(st.rows).toHaveLength(5);
    const [stream, shop, rent, salary, topUp] = st.rows;
    // a card payment is dated on the day it was authorised; the booking date is kept apart
    expect(stream).toMatchObject({ date: "2026-10-31", booked: "2026-11-02", merchant: "EXAMPLE STREAM", amount: "49.99", direction: "out", card: true, balance: "1746.05" });
    // "Suma: 4,99 EUR" → the foreign amount, with the RON amount as the account amount
    expect(shop).toMatchObject({ amount: "4.99", currency: "EUR", accountAmount: "24.63" });
    expect(rent).toMatchObject({ merchant: "Asociatia Exemplu", booked: null, card: false });
    expect(salary).toMatchObject({ direction: "in", amount: "1000.00", description: "Incasare · Ion Popescu · Sent from Revolut" });
    // a card top-up into Revolut is not marked as a card payment, so it can pair as a transfer
    expect(topUp).toMatchObject({ merchant: "Revolut**1234*", card: false });
    const settled = core.settleStatement(st.account, st.rows);
    expect(settled.rows[1].foreign).toEqual({ amount: "4.99", currency: "EUR" });
    expect(settled.rows[1].minor).toBe(2463);
  });

  it("ING Business: signed amounts, the card date from the details, the account number", () => {
    const [st] = parse("ing-business.csv").statements;
    expect(st.account).toMatchObject({ bank: "ING", identifier: "RO00INGB0000000000000003", currency: "RON" });
    expect(st.rows.map((r) => [r.date, r.booked, r.direction, r.amount])).toEqual([
      ["2026-10-02", null, "in", "5000.00"],
      ["2026-10-03", "2026-10-05", "out", "66.50"],
      ["2026-10-06", null, "out", "5.00"],
    ]);
    expect(st.rows[1]).toMatchObject({ currency: "EUR", accountAmount: "338.92", card: true });
    // the statement adds up to the closing balance
    expect(net(core.settleStatement(st.account, st.rows))).toBe(465608);
  });

  it("Wise: one balance per file, conversions carry the other side, jar moves, foreign card payments", () => {
    const [st] = parse("statement_12345678_EUR_2026-11-01_2026-11-09.csv").statements;
    expect(st.account).toMatchObject({ bank: "Wise", identifier: "wise12345678", currency: "EUR" });
    const [fuel, move, conv] = st.rows;
    expect(fuel).toMatchObject({ amount: "119.57", currency: "RON", accountAmount: "24.95", card: true });
    expect(move).toMatchObject({ merchant: "Wise jar move", direction: "out", amount: "100.00" });
    expect(conv).toMatchObject({ merchant: "Wise conversion", direction: "in", amount: "300.00", fx: { currency: "RON", amount: "1530.00" } });
    const [jar] = parse("statement_12345679_EUR_2026-11-01_2026-11-09.csv").statements;
    expect(jar.account.identifier).toBe("wise12345679");
    expect(jar.rows[0]).toMatchObject({ merchant: "Wise jar move", direction: "in", amount: "100.00" });
  });

  it("Revolut PDF: one statement per currency; pending, reverted and pass-through statements are left out", () => {
    const p = core.parseRevolut(JSON.parse(read("revolut-pages.json")));
    expect(p.format).toBe("revolut");
    expect(p.notes).toHaveLength(1);
    const [ron, eur] = p.statements;
    expect(ron.account).toMatchObject({ bank: "Revolut", currency: "RON", identifier: "RO00REVO0000000000000002RON" });
    expect(ron.rows.map((r) => r.description.split(" · ")[0])).toEqual(["Example Market", "Apple Pay deposit by *1234", "Exchanged to EUR", "To RON Savings"]);
    expect(ron.skipped.map((s) => s.reason)).toEqual(["repeated in Revolut's pass-through statement", "repeated in Revolut's pass-through statement", "reverted by Revolut"]);
    expect(ron.rows[0]).toMatchObject({ card: true, merchant: "Example Market" });
    expect(ron.rows[2]).toMatchObject({ merchant: "Revolut exchange", fx: { currency: "EUR", amount: "196.08" } });
    expect(ron.rows[3].leftOut).toMatch(/pockets or savings/);
    expect(eur.rows).toHaveLength(1);
    expect(eur.rows[0]).toMatchObject({ direction: "in", amount: "196.08", fx: { currency: "RON", amount: "1000.00" } });
    expect(eur.skipped.map((s) => s.reason)).toEqual(["still pending"]);
    // every account adds up to its closing balance (pockets included in the row list, unticked on the page)
    expect(net(core.settleStatement(ron.account, ron.rows))).toBe(5000 - 10000);
    expect(net(core.settleStatement(eur.account, eur.rows))).toBe(19608);
  });

  it("pdfLines groups pdf.js items into lines and isRevolutPdf recognises the first page", () => {
    const item = (s: string, x: number, y: number) => ({ str: s, transform: [1, 0, 0, 1, x, y], width: s.length * 4 });
    const lines = core.pdfLines([item("Balance summary", 40, 425), item("EUR Statement", 418, 757), item("", 10, 10), item("Revolut Ltd", 514, 731)]);
    expect(lines.map((l) => l.cells.map((c) => c.s).join(" "))).toEqual(["EUR Statement", "Revolut Ltd", "Balance summary"]);
    expect(core.isRevolutPdf(lines)).toBe(true);
    expect(core.isRevolutPdf(lines.slice(0, 1))).toBe(false);
  });

  it("the same row in two overlapping exports of one account has the same overlap key", () => {
    const a = parse("ing-ro.csv").statements[0];
    const sig = core.signatureId(core.accountSignature(a.account));
    const s1 = core.settleStatement(a.account, a.rows).rows, s2 = core.settleStatement(a.account, a.rows.slice(0, 2)).rows;
    expect(core.overlapKey(sig, s2[0])).toBe(core.overlapKey(sig, s1[0]));
    expect(core.overlapKey(sig, s1[0])).not.toBe(core.overlapKey(sig, s1[1]));
  });

  it("pairs an exchange across currencies by the amount printed on the other side", () => {
    const pairs = core.pairTransfers([
      { id: 1, order: 1, wallet: "ron", currency: "RON", minor: 100000, direction: "out", date: "2026-10-05", forcedOther: null, fx: { currency: "EUR", minor: 19608 } },
      { id: 2, order: 2, wallet: "eur", currency: "EUR", minor: 19608, direction: "in", date: "2026-10-05", forcedOther: null, fx: { currency: "RON", minor: 100000 } },
      { id: 3, order: 3, wallet: "eur", currency: "EUR", minor: 19608, direction: "in", date: "2026-10-09", forcedOther: null },
    ], new Set());
    expect(pairs).toEqual([{ outId: 1, inId: 2, otherMinor: 19608 }]);
  });
});

describe("what the readers build imports into the app", () => {
  let user: { id: number };
  beforeEach(async () => {
    const db = await useFreshDb();
    user = await makeUser(db, "banks@example.com");
  });

  it("builds a CSV the app accepts, with the Revolut exchange as one transfer", async () => {
    const rev = core.parseRevolut(JSON.parse(read("revolut-pages.json")));
    const ron = core.settleStatement(rev.statements[0].account, rev.statements[0].rows);
    const eur = core.settleStatement(rev.statements[1].account, rev.statements[1].rows);
    const ing = parse("ing-ro.csv").statements[0];
    const ingRows = core.settleStatement(ing.account, ing.rows).rows;
    const wRon = { name: "Revolut RON", currency: "RON" }, wEur = { name: "Revolut EUR", currency: "EUR" }, wIng = { name: "ING", currency: "RON" };
    const items: unknown[] = [];
    ingRows.forEach((r) => items.push({ date: r.date, kind: r.direction === "out" ? "expense" : "income", direction: r.direction, wallet: wIng, minor: r.minor, category: r.direction === "out" ? "Other" : "Salary", note: r.description, other: null, otherMinor: null }));
    ron.rows.filter((r) => !r.leftOut && !r.fx).forEach((r) => items.push({ date: r.date, kind: r.direction === "out" ? "expense" : "income", direction: r.direction, wallet: wRon, minor: r.minor, category: r.direction === "out" ? "Groceries" : "Other", note: r.description, other: null, otherMinor: null }));
    const ex = ron.rows.find((r) => r.fx)!;
    items.push({ date: ex.date, kind: "transfer", direction: "out", wallet: wRon, minor: ex.minor, category: null, note: ex.description, other: wEur, otherMinor: eur.rows[0].minor });
    const csv = core.toCsv(core.exportRecords(items));
    const p = await previewImport(user.id, csv, {});
    expect(p.problems).toEqual([]);
    expect(p.ok).toBe(true);
    expect(p.transfersToAdd).toBe(1);
    expect(p.transactionsToAdd).toBe(ingRows.length + 2);
  });
});
