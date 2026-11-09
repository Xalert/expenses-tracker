import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { DB } from "@/db";
import { categories, transactions, transfers, wallets } from "@/db/schema";
import { toCsv } from "@/lib/csv";
import { parseDecimalRounded } from "@/lib/money";
import { listCategories } from "@/server/categories";
import { buildBackup, buildTransactionsCsv } from "@/server/export";
import { previewImport, runImport, type ImportPreview } from "@/server/import";
import { createTransaction } from "@/server/transactions";
import { createWallet, listWallets } from "@/server/wallets";
import { makeUser, useFreshDb } from "./helpers";

// Synthetic Spendee exports in the shape of the real thing: `;`-separated, every cell quoted, CRLF, no BOM,
// signed amounts, `YYYY-MM-DD HH:MM:SS` dates, trailing First name / Last name columns.

let db: DB;
let alice: Awaited<ReturnType<typeof makeUser>>;

beforeEach(async () => {
  db = await useFreshDb();
  alice = await makeUser(db, "alice@example.com");
});

const HEADER = ["Date", "Wallet", "Type", "Category name", "Amount", "Currency", "Notes", "First name", "Last name"];
type Row = { date?: string; wallet?: string; type?: string; category?: string; amount: string; currency?: string; note?: string };

const quote = (cells: string[]) => cells.map((c) => `"${c.replace(/"/g, '""')}"`).join(";");
function spendee(...rows: Row[]): string {
  const lines = [
    quote(HEADER),
    ...rows.map((r) =>
      quote([
        r.date ?? "2019-04-29 21:10:33",
        r.wallet ?? "Personal Account",
        r.type ?? (r.amount.startsWith("-") ? "expense" : "income"),
        r.category ?? "Food",
        r.amount,
        r.currency ?? "RON",
        r.note ?? "",
        "Jane",
        "Doe",
      ]),
    ),
  ];
  return lines.join("\r\n") + "\r\n";
}

/** The example from the spec, plus a few more rows: 3 expenses, 2 incomes, a multi-line note, shared category names. */
const SAMPLE = spendee(
  { date: "2019-04-29 21:10:33", category: "Food", amount: "-30", note: "Mc" }, // line 2
  { date: "2019-04-30 17:40:52", category: "Food", amount: "-30.5" }, // 3
  { date: "2019-05-02 09:00:00", type: "income", category: "Salary", amount: "5000", note: "May" }, // 4
  { date: "2019-05-03 12:00:00", category: "Travel", amount: "-24.5806912", note: "two\r\nline note" }, // 5-6
  { date: "2019-05-04 08:00:00", category: "Other", amount: "-10" }, // 7
  { date: "2019-05-05 08:00:00", type: "income", category: "Other", amount: "12.345", note: "cashback" }, // 8
  { date: "2019-05-06 08:00:00", category: "Food & Drinks", amount: "-7.25" }, // 9
);

function expectProblems(p: ImportPreview, expected: { line?: number; message: RegExp }[]) {
  expect(p.ok).toBe(false);
  for (const e of expected) {
    const hit = p.problems.find((pr) => (e.line === undefined || pr.line === e.line) && e.message.test(pr.message));
    expect(hit, `expected ${String(e.message)} on line ${e.line} in ${JSON.stringify(p.problems, null, 1)}`).toBeTruthy();
  }
}

async function snapshot() {
  return {
    wallets: await db.select().from(wallets).orderBy(wallets.id),
    categories: await db.select().from(categories).orderBy(categories.id),
    transfers: await db.select().from(transfers).orderBy(transfers.id),
    transactions: await db.select().from(transactions).orderBy(transactions.id),
  };
}

/** Problems for a file with one header + the given rows, checking that nothing is written. */
async function problemsFor(...rows: Row[]) {
  const before = await snapshot();
  const text = spendee(...rows);
  const p = await previewImport(alice.id, text);
  expect((await runImport(alice.id, text)).imported).toBe(false);
  expect(await snapshot()).toEqual(before);
  return p;
}

const rowsOf = async (userId: number) =>
  await db
    .select({ kind: transactions.kind, amountMinor: transactions.amountMinor, date: transactions.date, note: transactions.note })
    .from(transactions)
    .where(eq(transactions.userId, userId))
    .orderBy(transactions.id);

describe("parseDecimalRounded", () => {
  it.each([
    ["-30", "RON", { minor: 3000, negative: true, rounded: false }],
    ["5000", "RON", { minor: 500000, negative: false, rounded: false }],
    ["+5", "RON", { minor: 500, negative: false, rounded: false }],
    ["-0.005", "RON", { minor: 1, negative: true, rounded: true }],
    ["0.005", "RON", { minor: 1, negative: false, rounded: true }],
    ["-0.004", "RON", { minor: 0, negative: true, rounded: true }],
    ["2.675", "RON", { minor: 268, negative: false, rounded: true }], // 2.675 is 2.67499… as a float
    ["-2.675", "RON", { minor: 268, negative: true, rounded: true }],
    ["-24.5806912", "RON", { minor: 2458, negative: true, rounded: true }],
    ["1.0049999999", "EUR", { minor: 100, negative: false, rounded: true }],
    ["-30.500", "RON", { minor: 3050, negative: true, rounded: false }], // trailing zeros change nothing
    ["0.995", "EUR", { minor: 100, negative: false, rounded: true }],
    ["-1500.4", "JPY", { minor: 1500, negative: true, rounded: true }],
    ["-1500.5", "JPY", { minor: 1501, negative: true, rounded: true }],
    ["1.2345", "KWD", { minor: 1235, negative: false, rounded: true }],
    ["-1.2344", "KWD", { minor: 1234, negative: true, rounded: true }],
    ["-0", "RON", { minor: 0, negative: true, rounded: false }],
  ])("%s %s", async (input, currency, expected) => {
    expect(parseDecimalRounded(input, currency)).toEqual(expected);
  });

  it.each(["", "abc", "12,50", "1 000", "1e3", ".5", "5.", "--5", "−5", "1.2.3"])("rejects %j", async (input) => {
    expect(parseDecimalRounded(input, "EUR")).toBeNull();
  });

  it("rejects magnitudes beyond the safe integer range instead of losing precision", async () => {
    expect(parseDecimalRounded("90071992547409.91", "EUR")).toEqual({ minor: Number.MAX_SAFE_INTEGER, negative: false, rounded: false });
    expect(parseDecimalRounded("90071992547409.915", "EUR")).toBeNull();
  });
});

describe("Spendee detection", () => {
  it("recognises the Spendee header and names the format", async () => {
    const p = await previewImport(alice.id, SAMPLE);
    expect(p).toMatchObject({ format: "spendee", formatLabel: "Spendee export", ok: true, problemCount: 0 });
  });

  it("still reads the app's own CSV (comma or semicolon) and backup as before", async () => {
    const w = await createWallet(alice.id, { name: "Main", currency: "EUR", initialBalanceMinor: 0 });
    await createTransaction(alice.id, { walletId: w.id, kind: "expense", categoryId: alice.cat("Food"), amountMinor: 100, date: "2026-01-01" });
    const bob = await makeUser(db, "bob@example.com");
    const native = await buildTransactionsCsv(alice.id);
    expect(await previewImport(bob.id, native)).toMatchObject({ format: "csv", formatLabel: "Transactions (CSV)", ok: true, transactionsToAdd: 1, notices: [] });
    const semicolons = toCsv([["date", "type", "wallet", "currency", "amount", "category"], ["2026-01-01", "expense", "Main", "EUR", "1,00", "Food"]], {
      delimiter: ";",
    });
    expect(await previewImport(bob.id, semicolons)).toMatchObject({ format: "csv", ok: true, transactionsToAdd: 1 });
    expect(await previewImport(bob.id, JSON.stringify(await buildBackup(alice.id)))).toMatchObject({ format: "backup", formatLabel: "Backup (JSON)", ok: true });
  });

  it("a native CSV with an extra 'Category name' column stays native (it has a category column)", async () => {
    const text = "date,type,wallet,currency,amount,category,Category name\n2026-01-01,expense,Cash,EUR,1,Food,x\n";
    expect(await previewImport(alice.id, text)).toMatchObject({ format: "csv", ok: true });
  });

  it("accepts the header in any order and case, without the name columns, with LF and commas", async () => {
    const text = 'notes,AMOUNT,currency,category NAME,type,WALLET,date\n"",-12.5,EUR,Food,Expense,Cash,2020-01-02\n';
    const r = await runImport(alice.id, text);
    expect(r).toMatchObject({ format: "spendee", ok: true, imported: true, transactionsToAdd: 1 });
    expect(await rowsOf(alice.id)).toEqual([{ kind: "expense", amountMinor: 1250, date: "2020-01-02", note: null }]);
  });

  it("reports missing Spendee columns on line 1", async () => {
    const text = '"Date";"Type";"Category name";"Amount"\r\n"2020-01-01";"expense";"Food";"-1"\r\n';
    const p = await previewImport(alice.id, text);
    expect(p.format).toBe("spendee");
    expectProblems(p, [{ line: 1, message: /missing the columns Wallet, Currency/ }]);
  });
});

describe("Spendee rows", () => {
  it("imports the sample: dates without time, absolute amounts, kinds, notes, wallet and categories", async () => {
    const p = await previewImport(alice.id, SAMPLE);
    expect(p).toMatchObject({
      ok: true,
      transactionsToAdd: 7,
      transfersToAdd: 0,
      walletsToCreate: [{ name: "Personal Account", currency: "RON", archived: false }],
    });
    // Food and Salary exist (defaults); Other exists under neither kind, so it is created twice.
    expect(p.categoriesToCreate).toEqual([
      { name: "Travel", kind: "expense" },
      { name: "Other", kind: "expense" },
      { name: "Other", kind: "income" },
      { name: "Food & Drinks", kind: "expense" },
    ]);
    expect(p.notices).toEqual([
      { code: "amounts-rounded", count: 2, message: "2 amounts had more decimals than RON allows and were rounded to 2 decimals." },
    ]);

    const r = await runImport(alice.id, SAMPLE);
    expect(r).toMatchObject({ imported: true, transactionsToAdd: 7, notices: p.notices });
    expect(await rowsOf(alice.id)).toEqual([
      { kind: "expense", amountMinor: 3000, date: "2019-04-29", note: "Mc" },
      { kind: "expense", amountMinor: 3050, date: "2019-04-30", note: null },
      { kind: "income", amountMinor: 500000, date: "2019-05-02", note: "May" },
      { kind: "expense", amountMinor: 2458, date: "2019-05-03", note: "two\nline note" },
      { kind: "expense", amountMinor: 1000, date: "2019-05-04", note: null },
      { kind: "income", amountMinor: 1235, date: "2019-05-05", note: "cashback" },
      { kind: "expense", amountMinor: 725, date: "2019-05-06", note: null },
    ]);
    const [wallet] = await listWallets(alice.id);
    // Independently: income 5000 + 12.35, expenses 30 + 30.50 + 24.58 + 10 + 7.25 = 102.33.
    expect(wallet).toMatchObject({ name: "Personal Account", currency: "RON", initialBalanceMinor: 0, balanceMinor: 501235 - 10233 });
    const names = (await listCategories(alice.id)).map((c) => `${c.kind}:${c.name}`);
    expect(names).toEqual(expect.arrayContaining(["expense:Other", "income:Other", "expense:Food & Drinks", "expense:Travel"]));
  });

  it("adds nothing when the same export is imported again", async () => {
    await runImport(alice.id, SAMPLE);
    const before = await snapshot();
    const r = await runImport(alice.id, SAMPLE);
    expect(r).toMatchObject({ ok: true, imported: true, transactionsToAdd: 0, duplicateTransactions: 7, walletsToCreate: [], categoriesToCreate: [] });
    expect(await snapshot()).toEqual(before);
  });

  it("keeps genuinely repeated rows inside one file", async () => {
    const twice = spendee({ amount: "-5" }, { amount: "-5" });
    expect(await runImport(alice.id, twice)).toMatchObject({ imported: true, transactionsToAdd: 2 });
    expect(await previewImport(alice.id, twice)).toMatchObject({ transactionsToAdd: 0, duplicateTransactions: 2 });
  });

  it("matches existing wallets and categories ignoring case", async () => {
    await createWallet(alice.id, { name: "personal account", currency: "RON", initialBalanceMinor: 10_000 });
    const p = await previewImport(alice.id, spendee({ amount: "-1", category: "FOOD" }, { amount: "100", type: "INCOME", category: "salary" }));
    expect(p).toMatchObject({ ok: true, transactionsToAdd: 2, walletsToCreate: [], categoriesToCreate: [] });
  });

  it("rounds half away from zero in both directions, with 0, 2 and 3 decimal currencies", async () => {
    const r = await runImport(
      alice.id,
      spendee(
        { amount: "-0.005" },
        { amount: "2.675" },
        { amount: "-24.5806912" },
        { amount: "-1500.4", currency: "JPY", wallet: "Tokyo" },
        { amount: "-1500.5", currency: "JPY", wallet: "Tokyo" },
        { amount: "-1.2345", currency: "KWD", wallet: "Kuwait" },
        { amount: "0.0005", currency: "KWD", wallet: "Kuwait" },
        { amount: "-30.500" }, // more digits, same value: not counted as rounded
      ),
    );
    expect(r.imported).toBe(true);
    expect((await rowsOf(alice.id)).map((t) => `${t.kind}:${t.amountMinor}`)).toEqual([
      "expense:1",
      "income:268",
      "expense:2458",
      "expense:1500",
      "expense:1501",
      "expense:1235",
      "income:1",
      "expense:3050",
    ]);
    expect(r.notices).toEqual([
      { code: "amounts-rounded", count: 3, message: "3 amounts had more decimals than RON allows and were rounded to 2 decimals." },
      { code: "amounts-rounded", count: 2, message: "2 amounts had more decimals than JPY allows and were rounded to whole units." },
      { code: "amounts-rounded", count: 2, message: "2 amounts had more decimals than KWD allows and were rounded to 3 decimals." },
    ]);
  });

  it("uses the singular for one rounded amount and has no notice when nothing was rounded", async () => {
    expect((await previewImport(alice.id, spendee({ amount: "-1.234" }))).notices[0].message).toBe(
      "1 amount had more decimals than RON allows and was rounded to 2 decimals.",
    );
    expect((await previewImport(alice.id, spendee({ amount: "-1.23" }))).notices).toEqual([]);
  });

  it("reports every bad line with its line number, counts lines across multi-line notes, and imports nothing", async () => {
    const p = await problemsFor(
      { amount: "-1", note: "fine\nwith a second line" }, // 2-3: fine
      { amount: "-0.004" }, // 4: rounds to zero
      { amount: "0" }, // 5: zero
      { amount: "-0", type: "expense" }, // 6: zero
      { amount: "30", type: "expense" }, // 7: sign contradicts type
      { amount: "-30", type: "income" }, // 8: sign contradicts type
      { amount: "-30", type: "transfer" }, // 9: not supported
      { amount: "-30", type: "" }, // 10: required
      { amount: "-30", date: "29.04.2019" }, // 11: date format
      { amount: "-30", date: "2019-02-30 10:00:00" }, // 12: impossible date
      { amount: "-30", date: "2019-02-03 25:00:00" }, // 13: impossible time
      { amount: "-30", wallet: "" }, // 14: wallet
      { amount: "-30", currency: "" }, // 15: currency
      { amount: "-30", currency: "XXX" }, // 16: invalid currency
      { amount: "-30", category: "  " }, // 17: category
      { amount: "-30", category: "C".repeat(41) }, // 18: category too long
      { amount: "-30", note: "n".repeat(501) }, // 19: note too long
      { amount: "-30", wallet: "W".repeat(61) }, // 20: wallet too long
      { amount: "-30,50" }, // 21: decimal comma
      { amount: "" }, // 22: amount missing
      { amount: "-1.5", currency: "JPY", wallet: "Tokyo" }, // 23: fine (rounded)
    );
    expectProblems(p, [
      { line: 4, message: /^Amount: “-0\.004” rounds to 0\.00 RON; amounts must be greater than zero\.$/ },
      { line: 5, message: /^Amount: Must not be zero\.$/ },
      { line: 6, message: /^Amount: Must not be zero\.$/ },
      { line: 7, message: /“30” is positive, but the row is an expense/ },
      { line: 8, message: /“-30” is negative, but the row is an income/ },
      { line: 9, message: /^Type: “transfer” is not supported\. Only expense and income rows can be imported/ },
      { line: 10, message: /^Type: Required/ },
      { line: 11, message: /^Date: “29\.04\.2019” is not a valid date\. Expected YYYY-MM-DD HH:MM:SS/ },
      { line: 12, message: /^Date: “2019-02-30 10:00:00”/ },
      { line: 13, message: /^Date: “2019-02-03 25:00:00”/ },
      { line: 14, message: /^Wallet: Required\.$/ },
      { line: 15, message: /^Currency: Required/ },
      { line: 16, message: /^Currency: “XXX” is not a supported ISO 4217/ },
      { line: 17, message: /^Category name: Required\.$/ },
      { line: 18, message: /^Category name: Keep the name under 40/ },
      { line: 19, message: /^Notes: Keep the note under 500/ },
      { line: 20, message: /^Wallet: Keep the name under 60/ },
      { line: 21, message: /^Amount: “-30,50” is not a valid amount/ },
      { line: 22, message: /^Amount: Required\.$/ },
    ]);
    expect(p.problemCount).toBe(19);
    expect(p.problems.some((x) => x.line === 2 || x.line === 3 || x.line === 23)).toBe(false);
    // Valid rows still produce their notice; problems block, notices never decide anything.
    expect(p.notices).toEqual([expect.objectContaining({ code: "amounts-rounded", count: 1 })]);
  });

  it("is all or nothing: one bad line among many valid ones writes nothing", async () => {
    const rows: Row[] = Array.from({ length: 500 }, (_, i) => ({ amount: `-${i + 1}.123` }));
    rows.push({ amount: "-abc" });
    const p = await problemsFor(...rows);
    expect(p).toMatchObject({ problemCount: 1, transactionsToAdd: 0 });
    expect(p.problems[0].line).toBe(502);
  });

  it("refuses new rows on an archived wallet with the same name, like the native CSV", async () => {
    const { archiveWallet } = await import("@/server/wallets");
    const w = await createWallet(alice.id, { name: "Personal Account", currency: "RON", initialBalanceMinor: 0 });
    await archiveWallet(alice.id, w.id);
    expectProblems(await previewImport(alice.id, spendee({ amount: "-1" })), [{ line: 2, message: /is archived in your account/ }]);
  });

  it("creates everything under the importing user only", async () => {
    await runImport(alice.id, SAMPLE);
    const before = await snapshot();
    const bob = await makeUser(db, "bob@example.com");
    // Alice already has every row, but none of them is a duplicate for Bob.
    const r = await runImport(bob.id, SAMPLE);
    expect(r).toMatchObject({ imported: true, transactionsToAdd: 7, duplicateTransactions: 0, walletsToCreate: [{ name: "Personal Account" }] });
    const after = await snapshot();
    const onlyAlice = (s: typeof before) => ({
      wallets: s.wallets.filter((x) => x.userId === alice.id),
      categories: s.categories.filter((x) => x.userId === alice.id),
      transactions: s.transactions.filter((x) => x.userId === alice.id),
    });
    expect(onlyAlice(after)).toEqual(onlyAlice(before));
    const bobWallet = (await listWallets(bob.id))[0];
    expect(bobWallet.balanceMinor).toBe((await listWallets(alice.id))[0].balanceMinor);
    expect(bobWallet.id).not.toBe((await listWallets(alice.id))[0].id);
  });
});
