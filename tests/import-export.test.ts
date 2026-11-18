import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { DB } from "@/db";
import { categories, transactions, transfers, users, wallets } from "@/db/schema";
import { parseCsv, toCsv } from "@/lib/csv";
import { listCategories } from "@/server/categories";
import { buildBackup, buildTransactionsCsv } from "@/server/export";
import { IMPORT_MAX_BYTES, MAX_PROBLEMS_SHOWN, previewImport, runImport, type ImportPreview } from "@/server/import";
import { createTransaction } from "@/server/transactions";
import { createTransfer } from "@/server/transfers";
import { createWalletGroup, listWalletGroups } from "@/server/wallet-groups";
import { archiveWallet, createWallet, listWallets } from "@/server/wallets";
import { makeUser, useFreshDb } from "./helpers";

let db: DB;
let alice: Awaited<ReturnType<typeof makeUser>>;

beforeEach(async () => {
  db = await useFreshDb();
  alice = await makeUser(db, "alice@example.com");
});

// ---------------------------------------------------------------------------------------------------------
// Fixtures + helpers

/** A varied account: 4 currencies incl. JPY (0 decimals) and KWD (3), an archived wallet with history,
 *  same- and cross-currency transfers, tricky notes and 3 identical purchases. */
async function seedAlice() {
  const eur = await createWallet(alice.id, { name: "Main", currency: "EUR", initialBalanceMinor: 100_000 });
  const cash = await createWallet(alice.id, { name: "Cash", currency: "EUR", initialBalanceMinor: -2_550 });
  const jpy = await createWallet(alice.id, { name: "Tokyo", currency: "JPY", initialBalanceMinor: 30_000 });
  const kwd = await createWallet(alice.id, { name: "Kuwait", currency: "KWD", initialBalanceMinor: 1_234 });
  const old = await createWallet(alice.id, { name: "Old card", currency: "USD", initialBalanceMinor: 5_000 });
  const twin = await createWallet(alice.id, { name: "Main", currency: "EUR", initialBalanceMinor: 0 }); // same name + currency

  const t = async (walletId: number, kind: "expense" | "income", cat: string, amountMinor: number, date: string, note?: string) =>
    createTransaction(alice.id, { walletId, kind, categoryId: alice.cat(cat), amountMinor, date, note });

  await t(eur.id, "income", "Salary", 350_000, "2026-01-01", "January salary");
  await t(eur.id, "expense", "Food", 1_250, "2026-01-02", "=SUM(A1:A9)");
  await t(eur.id, "expense", "Food", 1_250, "2026-01-02", "=SUM(A1:A9)");
  await t(eur.id, "expense", "Food", 1_250, "2026-01-02", "=SUM(A1:A9)");
  await t(cash.id, "expense", "Groceries", 899, "2026-01-03", "-5 refund later");
  await t(cash.id, "expense", "Groceries", 100, "2026-01-03", "'quoted' and \"double\", with comma; semicolon\nand newline");
  await t(cash.id, "income", "Refund", 500, "2026-01-04", "+plus @at");
  await t(jpy.id, "expense", "Food", 1_500, "2026-02-01", "Ramen");
  await t(kwd.id, "expense", "Bills", 1_234, "2026-02-02", "Three decimals");
  await t(old.id, "expense", "Transport", 2_000, "2025-12-01");
  await t(twin.id, "income", "Extra Income", 4_200, "2026-02-03", "Twin wallet");

  await createTransfer(alice.id, { fromWalletId: eur.id, toWalletId: cash.id, amountMinor: 10_000, date: "2026-01-05", note: "ATM" });
  await createTransfer(alice.id, {
    fromWalletId: eur.id,
    toWalletId: jpy.id,
    amountMinor: 20_000,
    receivedAmountMinor: 3_200_000 / 100,
    date: "2026-01-20",
  });
  await createTransfer(alice.id, { fromWalletId: eur.id, toWalletId: kwd.id, amountMinor: 5_000, receivedAmountMinor: 1_617, date: "2026-02-05" });
  await createTransfer(alice.id, { fromWalletId: old.id, toWalletId: eur.id, amountMinor: 1_000, receivedAmountMinor: 920, date: "2025-12-15" });
  await archiveWallet(alice.id, old.id);
  return { eur, cash, jpy, kwd, old, twin };
}

async function newUser(email: string) {
  return await makeUser(db, email);
}

type WalletState = { name: string; currency: string; initial: number; balance: number; archived: boolean; count: number };

async function walletState(userId: number): Promise<WalletState[]> {
  return (await listWallets(userId, { includeArchived: true }))
    .map((w) => ({
      name: w.name,
      currency: w.currency,
      initial: w.initialBalanceMinor,
      balance: w.balanceMinor,
      archived: w.archivedAt !== null,
      count: w.transactionCount,
    }))
    .sort((a, b) => `${a.name}|${a.currency}|${a.initial}`.localeCompare(`${b.name}|${b.currency}|${b.initial}`));
}

async function counts(userId: number) {
  const n = async (q: ReturnType<typeof sql>) => Number(((await db.execute(q)) as unknown as { rows: { n: unknown }[] }).rows[0].n);
  return {
    transactions: await n(sql`select count(*) as n from transactions where user_id = ${userId} and transfer_id is null`),
    transfers: await n(sql`select count(*) as n from transfers where user_id = ${userId}`),
    legs: await n(sql`select count(*) as n from transactions where user_id = ${userId} and transfer_id is not null`),
    wallets: await n(sql`select count(*) as n from wallets where user_id = ${userId}`),
    categories: await n(sql`select count(*) as n from categories where user_id = ${userId}`),
  };
}

const categoryNames = async (userId: number) => (await listCategories(userId)).map((c) => `${c.kind}:${c.name}`).sort();

/** Every row of every user-owned table: proves a failed import changed nothing. */
async function snapshot() {
  return {
    wallets: await db.select().from(wallets).orderBy(wallets.id),
    categories: await db.select().from(categories).orderBy(categories.id),
    transfers: await db.select().from(transfers).orderBy(transfers.id),
    transactions: await db.select().from(transactions).orderBy(transactions.id),
  };
}

const json = (v: unknown) => JSON.stringify(v);
const backupText = async (userId: number) => json(await buildBackup(userId));

function expectProblems(p: ImportPreview, expected: { line?: number; path?: string; message: RegExp }[]) {
  expect(p.ok).toBe(false);
  for (const e of expected) {
    const hit = p.problems.find(
      (pr) => (e.line === undefined || pr.line === e.line) && (e.path === undefined || pr.path === e.path) && e.message.test(pr.message),
    );
    expect(hit, `expected problem ${JSON.stringify({ ...e, message: String(e.message) })} in ${JSON.stringify(p.problems, null, 1)}`).toBeTruthy();
  }
}

const HEADER = "date,type,wallet,currency,amount,category,note,to_wallet,to_currency,to_amount";
const csv = (...rows: string[]) => [HEADER, ...rows].join("\n");

// ---------------------------------------------------------------------------------------------------------

describe("buildBackup", () => {
  it("contains the account with local ids, minor units + decimals, and nothing about the user", async () => {
    const { old } = await seedAlice();
    const b = await buildBackup(alice.id);
    expect(b.app).toBe("expenses-tracker");
    expect(b.version).toBe(1);
    expect(b.wallets.map((w) => w.id)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(b.wallets.find((w) => w.name === "Old card")).toMatchObject({ archived: true, initialBalanceMinor: 5_000, initialBalance: "50.00" });
    expect(b.wallets.find((w) => w.name === "Cash")).toMatchObject({ initialBalanceMinor: -2_550, initialBalance: "-25.50" });
    expect(b.transactions).toHaveLength(11);
    expect(b.transfers).toHaveLength(4);
    expect(b.transactions.find((t) => t.note === "Ramen")).toMatchObject({ amountMinor: 1_500, amount: "1500" });
    expect(b.transactions.find((t) => t.note === "Three decimals")).toMatchObject({ amountMinor: 1_234, amount: "1.234" });
    const text = JSON.stringify(b);
    expect(text).not.toContain("alice@example.com");
    expect(text).not.toMatch(/passwordHash|password_hash|session/i);
    expect(old.id).toBeGreaterThan(0);
  });

  it("only exports the signed-in user's rows", async () => {
    await seedAlice();
    const bob = await newUser("bob@example.com");
    const b = await buildBackup(bob.id);
    expect(b.wallets).toEqual([]);
    expect(b.transactions).toEqual([]);
    expect(b.transfers).toEqual([]);
    expect(b.categories).toHaveLength(8);
    expect(parseCsv(await buildTransactionsCsv(bob.id)).records).toHaveLength(1); // header only
  });
});

describe("buildTransactionsCsv", () => {
  it("writes one row per entry and per transfer, with a BOM, CRLF and protected formulas", async () => {
    await seedAlice();
    const out = await buildTransactionsCsv(alice.id);
    expect(out.startsWith("﻿date,type,wallet,currency,amount,category,note,to_wallet,to_currency,to_amount,group,archived\r\n")).toBe(true);
    const all = parseCsv(out).records.slice(1).map((r) => r.cells);
    // Wallet rows first: one per name + currency (the two "Main" EUR wallets share one, initial balances summed).
    const walletRows = all.filter((r) => r[1] === "wallet");
    expect(all.slice(0, walletRows.length)).toEqual(walletRows);
    expect(walletRows.map((r) => r.slice(0, 5).concat(r.slice(10, 11)))).toEqual([
      ["", "wallet", "Main", "EUR", "1000.00", "Personal"],
      ["", "wallet", "Cash", "EUR", "-25.50", "Personal"],
      ["", "wallet", "Tokyo", "JPY", "30000", "Personal"],
      ["", "wallet", "Kuwait", "KWD", "1.234", "Personal"],
      ["", "wallet", "Old card", "USD", "50.00", "Personal"],
    ]);
    expect(walletRows.find((r) => r[2] === "Old card")?.[11]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(walletRows.filter((r) => r[11] !== "")).toHaveLength(1);
    const rows = all.filter((r) => r[1] !== "wallet");
    expect(rows).toHaveLength(11 + 4);
    expect(rows.filter((r) => r[1] === "transfer")).toHaveLength(4);
    expect(rows.find((r) => r[6] === "'=SUM(A1:A9)")).toBeTruthy();
    expect(rows.find((r) => r[6] === "'-5 refund later")).toBeTruthy();
    expect(rows.find((r) => r[6] === "'+plus @at")).toBeTruthy();
    expect(rows.find((r) => r[6] === "Ramen")).toEqual(["2026-02-01", "expense", "Tokyo", "JPY", "1500", "Food", "Ramen", "", "", "", "Personal", ""]);
    expect(rows.find((r) => r[6] === "Three decimals")?.[4]).toBe("1.234");
    expect(rows.find((r) => r[6] === "ATM")).toEqual(["2026-01-05", "transfer", "Main", "EUR", "100.00", "", "ATM", "Cash", "EUR", "100.00", "Personal", ""]);
    // Oldest first.
    expect(rows[0][0]).toBe("2025-12-01");
  });

  it("applies the /transactions filters, including transfers on the destination wallet", async () => {
    const { cash, jpy } = await seedAlice();
    const only = async (f: Parameters<typeof buildTransactionsCsv>[1]) =>
      parseCsv(await buildTransactionsCsv(alice.id, f)).records.slice(1).map((r) => r.cells).filter((r) => r[1] !== "wallet");
    const walletsIn = async (f: Parameters<typeof buildTransactionsCsv>[1]) =>
      parseCsv(await buildTransactionsCsv(alice.id, f)).records.filter((r) => r.cells[1] === "wallet").map((r) => r.cells[2]);
    // Wallet rows for the wallets the rows use; with only a wallet / group scope, every wallet in it.
    expect(await walletsIn({ q: "ramen" })).toEqual(["Tokyo"]);
    expect(await walletsIn({ walletId: cash.id })).toEqual(["Main", "Cash"]);
    expect(await walletsIn({ kind: "expense", walletId: cash.id })).toEqual(["Cash"]);
    expect((await only({ kind: "transfer" })).every((r) => r[1] === "transfer")).toBe(true);
    expect(await only({ kind: "transfer" })).toHaveLength(4);
    const cashRows = await only({ walletId: cash.id });
    expect(cashRows.map((r) => r[1]).sort()).toEqual(["expense", "expense", "income", "transfer"]); // ATM transfer arrives in Cash
    expect(await only({ walletId: jpy.id, kind: "transfer" })).toHaveLength(1);
    expect(await only({ categoryId: alice.cat("Food") })).toHaveLength(4);
    expect(await only({ from: "2026-02-01", to: "2026-02-03" })).toHaveLength(3);
    expect(await only({ q: "ramen" })).toHaveLength(1);
  });
});

describe("backup round trip", () => {
  it("reproduces wallets, categories, counts and every balance in a fresh account", async () => {
    await seedAlice();
    const bob = await newUser("bob@example.com");
    const file = await backupText(alice.id);

    const preview = await previewImport(bob.id, file);
    expect(preview).toMatchObject({ format: "backup", ok: true, transactionsToAdd: 11, transfersToAdd: 4, duplicateTransactions: 0 });
    expect(preview.walletsToCreate).toHaveLength(6);
    expect(preview.walletsToCreate.find((w) => w.name === "Old card")?.archived).toBe(true);

    const result = await runImport(bob.id, file);
    expect(result.imported).toBe(true);
    expect(result.transactionsToAdd).toBe(preview.transactionsToAdd);
    expect(result.transfersToAdd).toBe(preview.transfersToAdd);

    expect(await walletState(bob.id)).toEqual(await walletState(alice.id));
    expect(await categoryNames(bob.id)).toEqual(await categoryNames(alice.id));
    expect(await counts(bob.id)).toEqual(await counts(alice.id));
    // The export of the copy is the same document (apart from the timestamp).
    const strip = (b: Awaited<ReturnType<typeof buildBackup>>) => ({ ...b, exportedAt: "" });
    expect(strip(await buildBackup(bob.id))).toEqual(strip(await buildBackup(alice.id)));
  });

  it("adds nothing when the same backup is imported again (into the copy or the original)", async () => {
    await seedAlice();
    const bob = await newUser("bob@example.com");
    const file = await backupText(alice.id);
    await runImport(bob.id, file);
    const before = await snapshot();

    for (const userId of [bob.id, alice.id]) {
      const again = await runImport(userId, file);
      expect(again).toMatchObject({
        ok: true,
        imported: true,
        transactionsToAdd: 0,
        transfersToAdd: 0,
        duplicateTransactions: 11,
        duplicateTransfers: 4,
        walletsToCreate: [],
        categoriesToCreate: [],
      });
    }
    expect(await snapshot()).toEqual(before);
  });

  it("leaves an existing wallet's name, initial balance and archived state untouched", async () => {
    await seedAlice();
    const bob = await newUser("bob@example.com");
    const bobCash = await createWallet(bob.id, { name: "CASH", currency: "EUR", initialBalanceMinor: 7 });
    await runImport(bob.id, await backupText(alice.id));
    const w = (await listWallets(bob.id, { includeArchived: true })).find((x) => x.id === bobCash.id)!;
    expect(w).toMatchObject({ name: "CASH", initialBalanceMinor: 7, archivedAt: null });
    expect((await listWallets(bob.id, { includeArchived: true })).filter((x) => x.name.toLowerCase() === "cash")).toHaveLength(1);
  });

  it("works without duplicate skipping too (everything is added again)", async () => {
    await seedAlice();
    const bob = await newUser("bob@example.com");
    const file = await backupText(alice.id);
    await runImport(bob.id, file);
    // Bob's copy of "Old card" is archived: new entries on it are refused, so the import is blocked as a whole.
    const blocked = await runImport(bob.id, file, { skipDuplicates: false });
    expect(blocked.imported).toBe(false);
    expect(blocked.problems[0].message).toMatch(/Old card.*archived/);
  });
});

describe("CSV round trip", () => {
  it("reproduces wallets, used categories, counts and balance movements in a fresh account", async () => {
    await seedAlice();
    const carol = await newUser("carol@example.com");
    const file = await buildTransactionsCsv(alice.id);
    const result = await runImport(carol.id, file);
    expect(result).toMatchObject({ format: "csv", ok: true, imported: true, transactionsToAdd: 11, transfersToAdd: 4 });

    const a = await walletState(alice.id);
    const c = await walletState(carol.id);
    // CSV wallets are identified by name + currency, so the two "Main" EUR wallets merge into one (its wallet row
    // carries the sum of their initial balances, so the merged balance is the total of both).
    const merge = (ws: WalletState[]) => {
      const m = new Map<string, { initial: number; balance: number; count: number; archived: boolean }>();
      for (const w of ws) {
        const k = `${w.name}|${w.currency}`;
        const cur = m.get(k) ?? { initial: 0, balance: 0, count: 0, archived: true };
        m.set(k, {
          initial: cur.initial + w.initial,
          balance: cur.balance + w.balance,
          count: cur.count + w.count,
          archived: cur.archived && w.archived,
        });
      }
      return Object.fromEntries(m);
    };
    expect(merge(c)).toEqual(merge(a));
    // The wallet rows bring the initial balances and the archived state (with its date) along.
    expect(c.find((w) => w.name === "Cash")?.initial).toBe(-2_550);
    expect(c.filter((w) => w.archived).map((w) => w.name)).toEqual(["Old card"]);
    const archivedOn = async (u: number) =>
      (await listWallets(u, { includeArchived: true })).find((w) => w.name === "Old card")?.archivedAt?.toISOString().slice(0, 10);
    expect(await archivedOn(carol.id)).toBe(await archivedOn(alice.id));
    expect(await counts(carol.id)).toMatchObject({ transactions: 11, transfers: 4, legs: 8 });
    expect(await categoryNames(carol.id)).toEqual(await categoryNames(alice.id)); // all used ones exist among the defaults
    // Notes (formula-protected on export) come back exactly.
    const notes = async (u: number) =>
      (await db.select({ note: transactions.note }).from(transactions).where(eq(transactions.userId, u))).map((r) => r.note ?? "").sort();
    expect(await notes(carol.id)).toEqual(await notes(alice.id));
  });

  it("adds nothing when the same CSV is imported again, even onto an archived wallet", async () => {
    await seedAlice();
    const carol = await newUser("carol@example.com");
    const file = await buildTransactionsCsv(alice.id);
    await runImport(carol.id, file);
    const before = await snapshot();
    expect(await runImport(carol.id, file)).toMatchObject({ imported: true, transactionsToAdd: 0, transfersToAdd: 0, duplicateTransactions: 11, duplicateTransfers: 4 });
    // Into the original account: the archived "Old card" rows are all duplicates, so they are fine.
    expect(await runImport(alice.id, file)).toMatchObject({ imported: true, transactionsToAdd: 0, transfersToAdd: 0 });
    expect(await snapshot()).toEqual(before);
  });

  it("reads the file back after a spreadsheet re-saved it (semicolons, decimal commas, DD.MM.YYYY)", async () => {
    await seedAlice();
    const original = parseCsv(await buildTransactionsCsv(alice.id)).records.map((r) => r.cells);
    const resaved = original.map((cells, i) => {
      if (i === 0) return cells.map((h) => h.toUpperCase()); // header case changes too
      const [date, ...rest] = cells;
      const [y, m, d] = date.split("-");
      const out = [date ? `${d}.${m}.${y}` : "", ...rest]; // wallet rows have no date
      out[4] = out[4].replace(".", ",");
      out[9] = out[9].replace(".", ",");
      return out;
    });
    const text = toCsv(resaved, { delimiter: ";", newline: "\n", bom: false });
    expect(text).toContain(";12,50;");

    const dave = await newUser("dave@example.com");
    const carol = await newUser("carol@example.com");
    expect(await runImport(dave.id, text)).toMatchObject({ ok: true, imported: true, transactionsToAdd: 11, transfersToAdd: 4 });
    await runImport(carol.id, await buildTransactionsCsv(alice.id));
    expect(await walletState(dave.id)).toEqual(await walletState(carol.id));
    // …and it is recognised as the same data.
    expect(await previewImport(carol.id, text)).toMatchObject({ transactionsToAdd: 0, transfersToAdd: 0, duplicateTransactions: 11 });
  });

  it("accepts columns in any order, unknown columns, tabs and blank lines", async () => {
    const text = [
      "Note\tAmount\tCurrency\tWallet\tType\tDate\tCategory\tMemo",
      "",
      "lunch\t12.5\teur\tCash\tExpense\t2026-03-01\tfood\tignored",
      "\t\t\t\t\t\t\t",
      "\t1500\tJPY\tTokyo\texpense\t2026-03-02\tFood\t",
    ].join("\r\n");
    const r = await runImport(alice.id, text);
    expect(r).toMatchObject({ ok: true, imported: true, transactionsToAdd: 2, categoriesToCreate: [] });
    expect(r.walletsToCreate).toEqual([
      { name: "Cash", currency: "EUR", archived: false, group: "Personal", described: false },
      { name: "Tokyo", currency: "JPY", archived: false, group: "Personal", described: false },
    ]);
    const ws = await listWallets(alice.id);
    expect(ws.find((w) => w.currency === "EUR")?.balanceMinor).toBe(-1_250);
    expect(ws.find((w) => w.currency === "JPY")?.balanceMinor).toBe(-1_500);
  });
});

describe("duplicates are a multiset", () => {
  it("adds 2 when the file has 3 identical entries and the account has 1", async () => {
    const w = await createWallet(alice.id, { name: "Cash", currency: "EUR", initialBalanceMinor: 0 });
    await createTransaction(alice.id, { walletId: w.id, kind: "expense", categoryId: alice.cat("Food"), amountMinor: 450, date: "2026-03-01", note: "Coffee" });
    const row = "2026-03-01,expense,cash,EUR,4.50,FOOD,Coffee,,,";
    const p = await previewImport(alice.id, csv(row, row, row));
    expect(p).toMatchObject({ ok: true, transactionsToAdd: 2, duplicateTransactions: 1, walletsToCreate: [], categoriesToCreate: [] });
    await runImport(alice.id, csv(row, row, row));
    expect((await counts(alice.id)).transactions).toBe(3);
    // A second time: all three now exist.
    expect(await previewImport(alice.id, csv(row, row, row))).toMatchObject({ transactionsToAdd: 0, duplicateTransactions: 3 });
    // Four in the file → one more.
    expect(await previewImport(alice.id, csv(row, row, row, row))).toMatchObject({ transactionsToAdd: 1, duplicateTransactions: 3 });
    // Without skipping, all are added.
    expect(await previewImport(alice.id, csv(row), { skipDuplicates: false })).toMatchObject({ transactionsToAdd: 1, duplicateTransactions: 0 });
  });

  it("differs on any of wallet, kind, category, date, amount or note", async () => {
    const w = await createWallet(alice.id, { name: "Cash", currency: "EUR", initialBalanceMinor: 0 });
    await createWallet(alice.id, { name: "Cash", currency: "USD", initialBalanceMinor: 0 });
    await createTransaction(alice.id, { walletId: w.id, kind: "expense", categoryId: alice.cat("Food"), amountMinor: 450, date: "2026-03-01", note: "Coffee" });
    const p = await previewImport(
      alice.id,
      csv(
        "2026-03-01,expense,Cash,USD,4.50,Food,Coffee,,,",
        "2026-03-01,expense,Cash,EUR,4.50,Groceries,Coffee,,,",
        "2026-03-02,expense,Cash,EUR,4.50,Food,Coffee,,,",
        "2026-03-01,expense,Cash,EUR,4.51,Food,Coffee,,,",
        "2026-03-01,expense,Cash,EUR,4.50,Food,coffee,,,",
        "2026-03-01,expense,Cash,EUR,4.50,Food,,,,",
        "2026-03-01,expense,Cash,EUR,4.50,Food,  Coffee  ,,,", // notes are trimmed → same
      ),
    );
    expect(p).toMatchObject({ ok: true, transactionsToAdd: 6, duplicateTransactions: 1 });
  });

  it("compares a transfer as one transfer, not as two transactions", async () => {
    const a = await createWallet(alice.id, { name: "A", currency: "EUR", initialBalanceMinor: 0 });
    const b = await createWallet(alice.id, { name: "B", currency: "USD", initialBalanceMinor: 0 });
    await createTransfer(alice.id, { fromWalletId: a.id, toWalletId: b.id, amountMinor: 1_000, receivedAmountMinor: 1_100, date: "2026-03-01", note: "fx" });
    const p = await previewImport(
      alice.id,
      csv(
        "2026-03-01,transfer,A,EUR,10.00,,fx,B,USD,11.00",
        "2026-03-01,transfer,A,EUR,10.00,,fx,B,USD,11.00",
        "2026-03-01,transfer,A,EUR,10.00,,fx,B,USD,11.01", // received differs
        "2026-03-01,transfer,B,USD,11.00,,fx,A,EUR,10.00", // reversed direction
      ),
    );
    expect(p).toMatchObject({ ok: true, transfersToAdd: 3, duplicateTransfers: 1, duplicateTransactions: 0, transactionsToAdd: 0 });
  });
});

describe("archived wallets", () => {
  it("restores an archived wallet with its history from a backup", async () => {
    const { old } = await seedAlice();
    const bob = await newUser("bob@example.com");
    await runImport(bob.id, await backupText(alice.id));
    const copy = (await listWallets(bob.id, { includeArchived: true })).find((w) => w.name === "Old card")!;
    const orig = (await listWallets(alice.id, { includeArchived: true })).find((w) => w.id === old.id)!;
    expect(copy.archivedAt).not.toBeNull();
    expect(copy.balanceMinor).toBe(orig.balanceMinor);
    expect(copy.transactionCount).toBe(orig.transactionCount);
  });

  it("refuses new CSV rows (and transfers) on an existing archived wallet, naming the line", async () => {
    const w = await createWallet(alice.id, { name: "Closed", currency: "EUR", initialBalanceMinor: 0 });
    const open = await createWallet(alice.id, { name: "Open", currency: "EUR", initialBalanceMinor: 0 });
    await archiveWallet(alice.id, w.id);
    const before = await snapshot();
    const r = await runImport(
      alice.id,
      csv(
        "2026-03-01,expense,Open,EUR,1,Food,,,,",
        "2026-03-01,expense,Closed,EUR,1,Food,,,,",
        "2026-03-01,transfer,Open,EUR,1,,,closed,EUR,",
      ),
    );
    expect(r.imported).toBe(false);
    expectProblems(r, [
      { line: 3, message: /“Closed” \(EUR\) is archived/ },
      { line: 4, message: /“Closed” \(EUR\) is archived/ },
    ]);
    expect(r.problemCount).toBe(2);
    expect(await snapshot()).toEqual(before);
    expect(open.id).toBeGreaterThan(0);
  });

  it("prefers an active wallet when a CSV name matches both an active and an archived one", async () => {
    const archived = await createWallet(alice.id, { name: "Cash", currency: "EUR", initialBalanceMinor: 0 });
    await archiveWallet(alice.id, archived.id);
    const active = await createWallet(alice.id, { name: "cash", currency: "EUR", initialBalanceMinor: 0 });
    const r = await runImport(alice.id, csv("2026-03-01,expense,CASH,EUR,1,Food,,,,"));
    expect(r.imported).toBe(true);
    expect((await listWallets(alice.id)).find((w) => w.id === active.id)?.transactionCount).toBe(1);
  });
});

describe("CSV problems", () => {
  const check = async (text: string, expected: Parameters<typeof expectProblems>[1]) => {
    const before = await snapshot();
    const p = await previewImport(alice.id, text);
    expectProblems(p, expected);
    const r = await runImport(alice.id, text);
    expect(r.imported).toBe(false);
    expect(await snapshot()).toEqual(before);
    return p;
  };

  it("reports missing required columns on line 1", async () => {
    await check("date,wallet,amount,note\n2026-01-01,Cash,1,x", [{ line: 1, message: /Missing columns: type, currency/ }]);
  });

  it("reports every broken row with its line number and imports nothing", async () => {
    await createWallet(alice.id, { name: "Cash", currency: "EUR", initialBalanceMinor: 0 });
    const p = await check(
      csv(
        "2026-01-01,expense,Cash,EUR,1.00,Food,ok,,,", // line 2: fine
        "03/04/2026,expense,Cash,EUR,1.00,Food,,,,", // 3: ambiguous date
        "2026-02-30,expense,Cash,EUR,1.00,Food,,,,", // 4: impossible date
        "2026-01-01,refund,Cash,EUR,1.00,Food,,,,", // 5: type
        "2026-01-01,expense,Cash,EUR,1.005,Food,,,,", // 6: too many decimals
        "2026-01-01,expense,Cash,EUR,-3,Food,,,,", // 7: negative
        "2026-01-01,expense,Cash,EUR,0,Food,,,,", // 8: zero
        "2026-01-01,expense,Cash,XXX,1,Food,,,,", // 9: currency
        "2026-01-01,expense,Cash,EUR,1,,,,,", // 10: category missing
        "2026-01-01,transfer,Cash,EUR,1,,,Cash,EUR,", // 11: same wallet
        "2026-01-01,transfer,Cash,EUR,1,,,Dollars,USD,", // 12: cross-currency without to_amount
        `2026-01-01,expense,Cash,EUR,1,Food,${"x".repeat(501)},,,`, // 13: note too long
        `2026-01-01,expense,${"W".repeat(61)},EUR,1,Food,,,,`, // 14: wallet name too long
        "2026-01-01,expense,Cash,JPY,1.5,Food,,,,", // 15: JPY has no decimals
        "2026-01-01,transfer,Cash,EUR,1,Food,,Other,EUR,", // 16: category on a transfer
        "2026-01-01,transfer,Cash,EUR,1,,,Other,EUR,2", // 17: same currency, different to_amount
        "2026-01-01,transfer,Cash,EUR,1,,,,,", // 18: to_wallet missing
        "2026-01-01,income,Cash,EUR,1,Food,,,,", // 19: Food is an expense category → new income category (fine)
      ),
      [
        { line: 3, message: /date: “03\/04\/2026” is not a valid date\. Use YYYY-MM-DD .* or DD\.MM\.YYYY/ },
        { line: 4, message: /date: “2026-02-30”/ },
        { line: 5, message: /type: “refund” is not a type/ },
        { line: 6, message: /amount: “1\.005” is not a valid EUR amount \(EUR allows up to 2 decimals\)/ },
        { line: 7, message: /amounts are positive/ },
        { line: 8, message: /greater than zero/ },
        { line: 9, message: /currency: “XXX” is not a supported/ },
        { line: 10, message: /category: Required for an expense/ },
        { line: 11, message: /two different wallets/ },
        { line: 12, message: /to_amount: Required: the wallets use different currencies \(EUR → USD\)/ },
        { line: 13, message: /note: Keep the note under 500/ },
        { line: 14, message: /wallet: Keep the name under 60/ },
        { line: 15, message: /JPY has no decimals/ },
        { line: 16, message: /Transfers have no category/ },
        { line: 17, message: /must equal the amount sent/ },
        { line: 18, message: /to_wallet: Required for a transfer/ },
      ],
    );
    expect(p.problems.some((x) => x.line === 2 || x.line === 19)).toBe(false);
    expect(p.problemCount).toBe(16);
  });

  it("counts lines across quoted multi-line notes", async () => {
    await check(csv('2026-01-01,expense,Cash,EUR,1,Food,"line one\nline two",,,', "2026-13-01,expense,Cash,EUR,1,Food,,,,"), [
      { line: 4, message: /date/ },
    ]);
  });

  it("reports malformed quoting", async () => {
    await check(csv('2026-01-01,expense,Cash,EUR,1,Food,"never closed,,,'), [{ line: 2, message: /never closed/ }]);
  });

  it("keeps checking the rows after a quoting problem, so every problem shows at once", async () => {
    const p = await check(
      csv(
        "2026-13-01,expense,Cash,EUR,1,Food,,,,", // 2: bad date
        '2026-01-01,expense,Cash,EUR,1,Food,"x"y,,,', // 3: text after a closing quote
        "2026-01-01,expense,Cash,EUR,-1,Food,,,,", // 4: negative amount
        '2026-01-01,expense,Cash,EUR,1,Food,"never closed,,,', // 5: the quote runs to the end of the file
        "2026-01-01,expense,Cash,EUR,x,Food,,,,", // 6: read again after the resync: bad amount
        "2026-01-01,expense,Cash,EUR,1,Food,,,,", // 7: fine
      ),
      [
        { line: 2, message: /date/ },
        { line: 3, message: /closing quote/ },
        { line: 4, message: /amounts are positive/ },
        { line: 5, message: /never closed/ },
        { line: 6, message: /“x” is not a valid EUR amount/ },
      ],
    );
    expect(p.problemCount).toBe(5);
    // A broken header still stops there: there is nothing to read the rows with.
    const h = await check('"date,type,wallet,currency,amount\n2026-01-01,expense,Cash,EUR,1', [{ line: 1, message: /never closed/ }]);
    expect(h.problemCount).toBe(1);
  });

  it("shows the first 50 problems and the total", async () => {
    const rows = Array.from({ length: 120 }, () => "bad,expense,Cash,EUR,1,Food,,,,");
    const p = await check(csv(...rows), [{ line: 2, message: /date/ }]);
    expect(p.problems).toHaveLength(MAX_PROBLEMS_SHOWN);
    expect(p.problemCount).toBe(120);
  });

  it("rejects more than 50 000 rows and files over 5 MB, and empty files", async () => {
    const row = "2026-01-01,expense,Cash,EUR,1,Food,,,,";
    await check(csv(...Array.from({ length: 50_001 }, () => row)), [{ message: /50,001 rows; the limit is 50,000/ }]);
    await check("x".repeat(IMPORT_MAX_BYTES + 1), [{ message: /larger than 5 MB/ }]);
    await check("", [{ message: /empty/ }]);
    await check("﻿  \n", [{ message: /empty/ }]);
  });
});

describe("backup problems", () => {
  const check = async (text: string, expected: Parameters<typeof expectProblems>[1]) => {
    const before = await snapshot();
    const p = await previewImport(alice.id, text);
    expectProblems(p, expected);
    expect((await runImport(alice.id, text)).imported).toBe(false);
    expect(await snapshot()).toEqual(before);
    return p;
  };
  type Row = Record<string, unknown>;
  type Doc = Row & { wallets: Row[]; categories: Row[]; transactions: Row[]; transfers: Row[] };
  const base = (): Doc => ({
    app: "expenses-tracker",
    version: 1,
    exportedAt: "2026-01-01T00:00:00.000Z",
    wallets: [
      { id: 1, name: "Cash", currency: "EUR", initialBalanceMinor: 0, initialBalance: "0.00", archived: false },
      { id: 2, name: "Dollars", currency: "USD", initialBalanceMinor: 0 },
    ],
    categories: [
      { id: 1, name: "Food", kind: "expense" },
      { id: 2, name: "Salary", kind: "income" },
    ],
    transactions: [{ date: "2026-01-01", kind: "expense", walletId: 1, categoryId: 1, amountMinor: 100, amount: "1.00", note: null }],
    transfers: [{ date: "2026-01-02", note: null, fromWalletId: 1, toWalletId: 2, amountMinor: 100, receivedAmountMinor: 110 }],
  });

  it("accepts the minimal valid document, ignoring unknown fields", async () => {
    const doc = { ...base(), extra: { anything: true } } as Record<string, unknown>;
    (doc.wallets as Record<string, unknown>[])[0].colour = "red";
    expect(await previewImport(alice.id, json(doc))).toMatchObject({ ok: true, transactionsToAdd: 1, transfersToAdd: 1 });
  });

  it("rejects malformed JSON, JSON of the wrong shape and unknown versions", async () => {
    await check('{"app": "expenses-tracker", "version": 1, ', [{ path: "(file)", message: /not valid JSON/ }]);
    await check("[1,2,3]", [{ message: /not an Expenses Tracker backup/ }]);
    await check(json({ hello: "world" }), [{ message: /not an Expenses Tracker backup/ }]);
    await check(json({ ...base(), version: 2 }), [{ path: "version", message: /version 2, made by a newer version/ }]);
    await check(json({ ...base(), version: "1" }), [{ path: "version", message: /Unsupported backup version "1"/ }]);
    await check(json({ ...base(), wallets: "nope" }), [{ path: "wallets", message: /./ }]);
  });

  it("reports schema problems with their path", async () => {
    const doc = base();
    (doc.transactions[0] as Record<string, unknown>).amountMinor = 2 ** 53;
    (doc.transactions[0] as Record<string, unknown>).date = undefined;
    (doc.wallets[1] as Record<string, unknown>).initialBalanceMinor = 1.5;
    (doc.categories[1] as Record<string, unknown>).kind = "transfer";
    (doc.transfers[0] as Record<string, unknown>).amountMinor = -5;
    (doc.wallets[0] as Record<string, unknown>).name = "x".repeat(5_000);
    await check(json(doc), [
      { path: "transactions[0].amountMinor", message: /whole number/ },
      { path: "transactions[0].date", message: /YYYY-MM-DD/ },
      { path: "wallets[1].initialBalanceMinor", message: /whole number/ },
      { path: "categories[1].kind", message: /expense or income/ },
      { path: "transfers[0].amountMinor", message: /greater than zero/ },
      { path: "wallets[0].name", message: /too long/ },
    ]);
  });

  it("reports dangling references, duplicate ids and rule violations with their path", async () => {
    const doc = base();
    doc.wallets.push({ id: 2, name: "Dup", currency: "EUR", initialBalanceMinor: 0 });
    doc.categories.push({ id: 1, name: "Dup", kind: "expense" });
    doc.wallets.push({ id: 9, name: "  ", currency: "eur", initialBalanceMinor: 0 });
    doc.wallets.push({ id: 10, name: "Bad cur", currency: "ABC", initialBalanceMinor: 0 });
    doc.transactions.push(
      { date: "2026-01-01", kind: "expense", walletId: 7, categoryId: 1, amountMinor: 1, amount: "0.01", note: null },
      { date: "2026-01-01", kind: "expense", walletId: 1, categoryId: 5, amountMinor: 1, amount: "0.01", note: null },
      { date: "2026-01-01", kind: "income", walletId: 1, categoryId: 1, amountMinor: 1, amount: "0.01", note: null },
      { date: "2026-01-01", kind: "expense", walletId: 1, categoryId: 1, amountMinor: 150, amount: "1.05", note: null },
      { date: "01.01.2026", kind: "expense", walletId: 1, categoryId: 1, amountMinor: 1, amount: "0.01", note: "y".repeat(501) },
    );
    doc.transfers.push(
      { date: "2026-01-02", note: null, fromWalletId: 1, toWalletId: 1, amountMinor: 1, receivedAmountMinor: 1 },
      { date: "2026-01-02", note: null, fromWalletId: 1, toWalletId: 2, amountMinor: 1 } as never,
      { date: "2026-01-02", note: null, fromWalletId: 1, toWalletId: 9, amountMinor: 1, receivedAmountMinor: 2 },
    );
    await check(json(doc), [
      { path: "wallets[2].id", message: /Duplicate wallet id 2/ },
      { path: "categories[2].id", message: /Duplicate category id 1/ },
      { path: "wallets[3].name", message: /Enter a name/ },
      { path: "wallets[4].currency", message: /“ABC” is not a supported/ },
      { path: "transactions[1].walletId", message: /No wallet with id 7/ },
      { path: "transactions[2].categoryId", message: /No category with id 5/ },
      { path: "transactions[3].categoryId", message: /“Food” is an expense category; this transaction is an income/ },
      { path: "transactions[4].amount", message: /“1.05” does not match the amount in minor units \(150 = 1.50 EUR\)/ },
      { path: "transactions[5].date", message: /not a valid date/ },
      { path: "transactions[5].note", message: /500/ },
      { path: "transfers[1].toWalletId", message: /two different wallets/ },
      { path: "transfers[2].receivedAmountMinor", message: /different currencies \(EUR → USD\)/ },
      { path: "transfers[3].receivedAmountMinor", message: /must equal the amount sent/ },
    ]);
  });

  it("rejects more than 50 000 transactions + transfers", async () => {
    const doc = base();
    const t = doc.transactions[0];
    // Minimal entries so the file stays under the 5 MB cap.
    doc.transactions = Array.from({ length: 45_000 }, () => ({ ...t, amount: undefined, note: undefined }));
    doc.transfers = Array.from({ length: 5_001 }, () => doc.transfers[0]);
    await check(json(doc), [{ path: "(file)", message: /50,001 transactions and transfers; the limit is 50,000/ }]);
  });
});

describe("isolation and atomicity", () => {
  it("never touches another user's rows, whatever ids the file uses", async () => {
    const { eur } = await seedAlice();
    const before = await snapshot();
    const bob = await newUser("bob@example.com");
    const doc = {
      app: "expenses-tracker",
      version: 1,
      // Local ids that happen to equal alice's database ids.
      wallets: [{ id: eur.id, name: "Main", currency: "EUR", initialBalanceMinor: 0 }],
      categories: [{ id: alice.cat("Food"), name: "Food", kind: "expense" }],
      transactions: [{ date: "2026-01-02", kind: "expense", walletId: eur.id, categoryId: alice.cat("Food"), amountMinor: 1_250, note: "=SUM(A1:A9)" }],
      transfers: [],
    };
    const r = await runImport(bob.id, json(doc));
    // Alice has this exact entry three times, but it is not a duplicate for Bob.
    expect(r).toMatchObject({ imported: true, transactionsToAdd: 1, duplicateTransactions: 0 });
    const bobRows = await db.select().from(transactions).where(eq(transactions.userId, bob.id));
    expect(bobRows).toHaveLength(1);
    expect(bobRows[0].walletId).not.toBe(eur.id);
    const after = await snapshot();
    const aliceOnly = (s: typeof before) => ({
      wallets: s.wallets.filter((w) => w.userId === alice.id),
      categories: s.categories.filter((c) => c.userId === alice.id),
      transfers: s.transfers.filter((t) => t.userId === alice.id),
      transactions: s.transactions.filter((t) => t.userId === alice.id),
    });
    expect(aliceOnly(after)).toEqual(aliceOnly(before));
    // CSV into Bob: Alice's wallet "Main" is not Bob's.
    expect((await previewImport(bob.id, await buildTransactionsCsv(alice.id))).walletsToCreate.length).toBeGreaterThan(0);
  });

  it("writes nothing when a problem is found late in a large file", async () => {
    const rows = Array.from({ length: 2_000 }, (_, i) => `2026-01-01,expense,Cash,EUR,${i + 1},Food,,,,`);
    rows.push("2026-01-01,expense,Cash,EUR,abc,Food,,,,");
    const before = await snapshot();
    const r = await runImport(alice.id, csv(...rows));
    expect(r).toMatchObject({ imported: false, problemCount: 1 });
    expect(r.problems[0].line).toBe(2_002);
    expect(await snapshot()).toEqual(before);
  });
});

describe("money with 0 and 3 decimals", () => {
  it("round-trips JPY and KWD through both formats", async () => {
    const jpy = await createWallet(alice.id, { name: "Yen", currency: "JPY", initialBalanceMinor: -7 });
    const kwd = await createWallet(alice.id, { name: "Dinar", currency: "KWD", initialBalanceMinor: 1 });
    await createTransaction(alice.id, { walletId: jpy.id, kind: "expense", categoryId: alice.cat("Food"), amountMinor: 123_456, date: "2026-01-01" });
    await createTransaction(alice.id, { walletId: kwd.id, kind: "income", categoryId: alice.cat("Salary"), amountMinor: 1_001, date: "2026-01-01" });
    await createTransfer(alice.id, { fromWalletId: kwd.id, toWalletId: jpy.id, amountMinor: 5, receivedAmountMinor: 3, date: "2026-01-02" });

    const b = await buildBackup(alice.id);
    expect(b.wallets.map((w) => w.initialBalance)).toEqual(["-7", "0.001"]);
    expect(b.transfers[0]).toMatchObject({ amount: "0.005", receivedAmount: "3" });
    const csvText = await buildTransactionsCsv(alice.id);
    expect(csvText).toContain("123456");
    expect(csvText).toContain("1.001");

    const bob = await newUser("bob@example.com");
    const carol = await newUser("carol@example.com");
    await runImport(bob.id, json(b));
    await runImport(carol.id, csvText);
    expect(await walletState(bob.id)).toEqual(await walletState(alice.id));
    const movement = async (u: number) => (await walletState(u)).map((w) => [w.name, w.balance - w.initial]);
    expect(await movement(carol.id)).toEqual(await movement(alice.id));
  });
});

describe("performance", () => {
  it("imports 50 000 CSV rows into the in-process Postgres in a few seconds, and re-imports them as duplicates", async () => {
    const u = await makeUser(db, "perf@example.com");
    const wallets = ["Main|EUR", "Cash|EUR", "Card|USD", "Yen|JPY"];
    const cats = ["Food", "Groceries", "Bills", "Transport", "Housing"];
    const rows: string[][] = [["date", "type", "wallet", "currency", "amount", "category", "note", "to_wallet", "to_currency", "to_amount"]];
    for (let i = 0; i < 50_000; i++) {
      const day = `2025-${String((i % 12) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`;
      const [w, cur] = wallets[i % 4].split("|");
      if (i % 10 === 9) {
        const [tw, tcur] = wallets[(i + 1) % 4].split("|");
        rows.push([day, "transfer", w, cur, cur === "JPY" ? `${i % 900 + 1}` : `${(i % 900) + 1}.25`, "", `t${i}`, tw, tcur, tcur === "JPY" ? `${i % 700 + 1}` : `${(i % 700) + 1}.50`]);
      } else {
        rows.push([day, i % 7 === 0 ? "income" : "expense", w, cur, cur === "JPY" ? `${i % 5000 + 1}` : `${(i % 5000) + 1}.${String(i % 100).padStart(2, "0")}`, i % 7 === 0 ? "Salary" : cats[i % 5], i % 3 ? `note ${i % 50}` : "", "", "", ""]);
      }
    }
    const text = toCsv(rows);
    expect(Buffer.byteLength(text)).toBeLessThan(IMPORT_MAX_BYTES);

    let t0 = performance.now();
    const preview = await previewImport(u.id, text);
    const previewMs = performance.now() - t0;
    expect(preview).toMatchObject({ ok: true, transactionsToAdd: 45_000, transfersToAdd: 5_000 });

    t0 = performance.now();
    const r = await runImport(u.id, text);
    const importMs = performance.now() - t0;
    expect(r).toMatchObject({ imported: true, transactionsToAdd: 45_000, transfersToAdd: 5_000 });
    expect(await counts(u.id)).toMatchObject({ transactions: 45_000, transfers: 5_000, legs: 10_000 });

    t0 = performance.now();
    const again = await runImport(u.id, text);
    const reimportMs = performance.now() - t0;
    expect(again).toMatchObject({ imported: true, transactionsToAdd: 0, transfersToAdd: 0, duplicateTransactions: 45_000, duplicateTransfers: 5_000 });

    t0 = performance.now();
    const exported = await buildTransactionsCsv(u.id);
    const exportMs = performance.now() - t0;
    expect(parseCsv(exported).records).toHaveLength(1 + 4 + 50_000); // header, 4 wallet rows, the entries

    console.info(
      `[perf] 50k rows, ${(Buffer.byteLength(text) / 1024 / 1024).toFixed(2)} MB: preview ${previewMs.toFixed(0)} ms, ` +
        `import ${importMs.toFixed(0)} ms, re-import (all duplicates) ${reimportMs.toFixed(0)} ms, export ${exportMs.toFixed(0)} ms`,
    );
    expect(importMs).toBeLessThan(15_000);
    // The users table is untouched by imports.
    expect(await db.select().from(users)).toHaveLength(2); // alice (beforeEach) and perf
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------------------
// Wallet details in the CSV (wallet rows, group, archived) and in the backup (archivedAt)

const HEADER2 = `${HEADER},group,archived`;
const csv2 = (...rows: string[]) => [HEADER2, ...rows].join("\n");

describe("CSV wallet rows and groups", () => {
  const check = async (text: string, expected: Parameters<typeof expectProblems>[1]) => {
    const before = await snapshot();
    const p = await previewImport(alice.id, text);
    expectProblems(p, expected);
    expect((await runImport(alice.id, text)).imported).toBe(false);
    expect(await snapshot()).toEqual(before);
    return p;
  };
  const wallet = async (name: string) => (await listWallets(alice.id, { includeArchived: true })).find((w) => w.name === name);
  const groupNames = async () => (await listWalletGroups(alice.id)).map((g) => g.name).sort();

  it("creates wallets with the initial balance, group and archived date of their wallet rows", async () => {
    const text = csv2(
      ",wallet,Savings,EUR,1200.50,,,,,,Business,",
      ",wallet,Old card,USD,-25.00,,,,,,,2025-06-30",
      ",wallet,Empty,JPY,,,,,,,,",
      "2026-01-01,expense,Savings,EUR,10.00,Food,,,,,,",
      "2025-05-01,expense,Old card,USD,5.00,Food,,,,,,",
      "2026-01-02,transfer,Savings,EUR,100.00,,,Old card,USD,110.00,,",
    );
    const p = await previewImport(alice.id, text);
    expect(p).toMatchObject({ ok: true, transactionsToAdd: 2, transfersToAdd: 1, groupsToCreate: ["Business"] });
    expect(p.walletsToCreate).toEqual([
      { name: "Savings", currency: "EUR", archived: false, group: "Business", described: true },
      { name: "Old card", currency: "USD", archived: true, group: "Personal", described: true },
      { name: "Empty", currency: "JPY", archived: false, group: "Personal", described: true },
    ]);
    expect((await runImport(alice.id, text)).imported).toBe(true);
    const savings = await wallet("Savings");
    expect(savings).toMatchObject({ initialBalanceMinor: 120_050, balanceMinor: 120_050 - 1_000 - 10_000 });
    const old = await wallet("Old card");
    expect(old?.initialBalanceMinor).toBe(-2_500);
    expect(old?.archivedAt?.toISOString()).toBe("2025-06-30T00:00:00.000Z");
    expect(old?.balanceMinor).toBe(-2_500 - 500 + 11_000); // a restore: its history is inserted
    expect((await wallet("Empty"))?.initialBalanceMinor).toBe(0);
    expect(await groupNames()).toEqual(["Business", "Personal"]);
    expect((await listWallets(alice.id, { groupId: (await listWalletGroups(alice.id)).find((g) => g.name === "Business")!.id })).map((w) => w.name)).toEqual(["Savings"]);
  });

  it("puts a new wallet into the group named on its entry rows, matching an existing group ignoring case", async () => {
    const biz = await createWalletGroup(alice.id, { name: "Business" });
    const p = await previewImport(alice.id, csv2("2026-01-01,expense,Till,EUR,1.00,Food,,,,,business,", "2026-01-01,expense,Home,EUR,1.00,Food,,,,,Family,"));
    expect(p.walletsToCreate).toEqual([
      { name: "Till", currency: "EUR", archived: false, group: "Business", described: false },
      { name: "Home", currency: "EUR", archived: false, group: "Family", described: false },
    ]);
    expect(p.groupsToCreate).toEqual(["Family"]);
    await runImport(alice.id, csv2("2026-01-01,expense,Till,EUR,1.00,Food,,,,,business,"));
    expect((await listWallets(alice.id, { groupId: biz.id })).map((w) => w.name)).toEqual(["Till"]);
    // Without the column (an older file) the target group is used, as before.
    const q = await previewImport(alice.id, csv("2026-01-01,expense,Other,EUR,1,Food,,,,"), { groupId: biz.id });
    expect(q.walletsToCreate[0]).toMatchObject({ name: "Other", group: "Business", described: false });
  });

  it("never changes an existing wallet: its wallet row and group are ignored", async () => {
    const main = await createWallet(alice.id, { name: "Main", currency: "EUR", initialBalanceMinor: 500 });
    const r = await runImport(alice.id, csv2(",wallet,main,EUR,999.00,,,,,,Elsewhere,2020-01-01", "2026-01-01,expense,Main,EUR,1.00,Food,,,,,Elsewhere,"));
    expect(r).toMatchObject({ imported: true, transactionsToAdd: 1, walletsToCreate: [], groupsToCreate: [] });
    const after = await wallet("Main");
    expect(after).toMatchObject({ id: main.id, initialBalanceMinor: 500, archivedAt: null });
    expect(await groupNames()).toEqual(["Personal"]);
  });

  it("reports wallet rows it cannot use", async () => {
    const p = await check(
      csv2(
        ",wallet,A,EUR,12.345,,,,,,,", // 2: too many decimals
        ",wallet,B,EUR,1,,,,,,,31/12/2025", // 3: slashed date
        ",wallet,C,EUR,1,Food,note,,,,,", // 4: category and note on a wallet row
        ",wallet,D,EUR,1,,,,,,,", // 5: fine
        ",wallet,d,EUR,2,,,,,,,", // 6: D again
        "2026-01-01,expense,E,EUR,1,Food,,,,,,2026-01-01", // 7: archived on an entry
        "2026-01-01,expense,F,EUR,1,Food,,,,,One,", // 8: fine
        "2026-01-02,expense,F,EUR,1,Food,,,,,Two,", // 9: F in another group
        `2026-01-02,expense,G,EUR,1,Food,,,,,${"g".repeat(41)},`, // 10: group name too long
        ",wallet,,EUR,1,,,,,,,", // 11: no name
      ),
      [
        { line: 2, message: /^amount: “12\.345” is not a valid EUR initial balance/ },
        { line: 3, message: /^archived: “31\/12\/2025” is not a valid date/ },
        { line: 4, message: /^category: A wallet row only describes a wallet; leave category, note empty\./ },
        { line: 6, message: /^wallet: Wallet “D” \(EUR\) is already described on line 5\./ },
        { line: 7, message: /^archived: Only wallet rows/ },
        { line: 9, message: /^group: Wallet “F” \(EUR\) is put in group “One” on line 8; a wallet can only be in one group\./ },
        { line: 10, message: /^group: / },
        { line: 11, message: /^wallet: / },
      ],
    );
    expect(p.problemCount).toBe(8);
  });

  it("merges wallet rows across the files of one selection, and reports files that disagree", async () => {
    const a = { name: "a.csv", text: csv2(",wallet,Cash,EUR,10.00,,,,,,Home,", "2026-01-01,expense,Cash,EUR,1.00,Food,,,,,,") };
    const b = { name: "b.csv", text: csv("2026-01-02,expense,Cash,EUR,2.00,Food,,,,") };
    const same = { name: "c.csv", text: csv2(",wallet,cash,EUR,10.00,,,,,,home,") };
    const p = await previewImport(alice.id, [a, b, same]);
    expect(p).toMatchObject({ ok: true, transactionsToAdd: 2, groupsToCreate: ["Home"] });
    expect(p.walletsToCreate).toEqual([{ name: "Cash", currency: "EUR", archived: false, group: "Home", described: true }]);
    const other = { name: "d.csv", text: csv2(",wallet,Cash,EUR,11.00,,,,,,Away,") };
    const q = await previewImport(alice.id, [a, other]);
    expect(q.problems).toEqual([
      { file: "d.csv", line: 2, message: "wallet: Wallet “Cash” (EUR) is described differently in “a.csv”, line 2." },
      { file: "d.csv", line: 2, message: "group: Wallet “Cash” (EUR) is put in group “Home” in “a.csv”, line 2; a wallet can only be in one group." },
    ]);
  });
});

describe("archived dates in the backup", () => {
  it("writes when an archived wallet was archived and restores that date", async () => {
    const old = await createWallet(alice.id, { name: "Old", currency: "EUR", initialBalanceMinor: 0 });
    await createWallet(alice.id, { name: "Live", currency: "EUR", initialBalanceMinor: 0 });
    await archiveWallet(alice.id, old.id);
    await db.update(wallets).set({ archivedAt: new Date("2024-02-03T04:05:06.000Z") }).where(eq(wallets.id, old.id));
    const backup = await buildBackup(alice.id);
    expect(backup.wallets.map((w) => [w.name, w.archived, w.archivedAt])).toEqual([
      ["Old", true, "2024-02-03T04:05:06.000Z"],
      ["Live", false, undefined],
    ]);
    const bob = await makeUser(db, "bob@example.com");
    expect((await runImport(bob.id, json(backup))).imported).toBe(true);
    const restored = (await listWallets(bob.id, { includeArchived: true })).find((w) => w.name === "Old");
    expect(restored?.archivedAt?.toISOString()).toBe("2024-02-03T04:05:06.000Z");
  });

  it("archives as of the import when the file has no date (older backups), and rejects a bad one", async () => {
    const file = (extra: Record<string, unknown>) =>
      json({
        app: "expenses-tracker",
        version: 1,
        wallets: [{ id: 1, name: "Old", currency: "EUR", initialBalanceMinor: 0, archived: true, ...extra }],
        categories: [],
        transactions: [],
        transfers: [],
      });
    const before = Date.now();
    expect((await runImport(alice.id, file({}))).imported).toBe(true);
    const w = (await listWallets(alice.id, { includeArchived: true })).find((x) => x.name === "Old");
    expect(w?.archivedAt?.getTime()).toBeGreaterThanOrEqual(before - 1000);
    const bad = await previewImport(alice.id, file({ archivedAt: "yesterday" }));
    expectProblems(bad, [{ path: "wallets[0].archivedAt", message: /ISO timestamp/ }]);
  });
});

describe("docs/IMPORTING.md", () => {
  it("its example CSV imports as described", async () => {
    const doc = (await import("node:fs")).readFileSync(new URL("../docs/IMPORTING.md", import.meta.url), "utf8");
    const example = /```\n(date,type,[\s\S]*?)```/.exec(doc)![1];
    const p = await previewImport(alice.id, example);
    expect(p).toMatchObject({ ok: true, transactionsToAdd: 2, transfersToAdd: 2 });
    expect(p.walletsToCreate.map((w) => [w.name, w.archived, w.described])).toEqual([
      ["Main", false, true],
      ["Old card", true, true],
      ["Cash", false, false],
    ]);
  });
});
