// Tags in the native CSV (`tags` column) and the JSON backup (entry `tags`, top-level `tags`): round trips, files
// without them, duplicates that do not gain tags (import adds, never changes), a re-import that adds nothing, and the
// cell's rules. Spendee labels stay in the note (see tests/spendee-import.test.ts).
import { beforeEach, describe, expect, it } from "vitest";
import type { DB } from "@/db";
import { parseCsv, toCsv } from "@/lib/csv";
import { buildBackup, buildTransactionsCsv } from "@/server/export";
import { previewImport, runImport } from "@/server/import";
import { listTags } from "@/server/tags";
import { createTransaction, listTransactions } from "@/server/transactions";
import { createTransfer } from "@/server/transfers";
import { createWallet } from "@/server/wallets";
import { makeUser, useFreshDb } from "./helpers";

let db: DB;
let alice: Awaited<ReturnType<typeof makeUser>>;
let bob: Awaited<ReturnType<typeof makeUser>>;

beforeEach(async () => {
  db = await useFreshDb();
  alice = await makeUser(db, "alice@example.com");
  bob = await makeUser(db, "bob@example.com");
});

async function seed() {
  const cash = await createWallet(alice.id, { name: "Cash", currency: "EUR", initialBalanceMinor: 0 });
  const bank = await createWallet(alice.id, { name: "Bank", currency: "EUR", initialBalanceMinor: 0 });
  const add = (amountMinor: number, note: string, tags?: string[]) =>
    createTransaction(alice.id, { walletId: cash.id, kind: "expense", categoryId: alice.cat("Food"), amountMinor, date: "2026-10-02", note, tags });
  await add(1200, "Pizza", ["holiday 2026", "=sum"]);
  await add(800, "Coffee", ["holiday 2026"]);
  await add(500, "Bread");
  await createTransfer(alice.id, { fromWalletId: bank.id, toWalletId: cash.id, amountMinor: 5000, date: "2026-10-01", note: "ATM" });
  return { cash, bank };
}

const tagsByNote = async (userId: number) =>
  Object.fromEntries((await listTransactions(userId, { limit: 200 })).items.filter((t) => t.note).map((t) => [t.note, t.tags]));

const HEADER = "date,type,wallet,currency,amount,category,note,to_wallet,to_currency,to_amount";

describe("CSV tags", () => {
  it("exports the tags column (\", \"-separated, formula-guarded) and round-trips into another account", async () => {
    await seed();
    const csv = await buildTransactionsCsv(alice.id);
    const records = parseCsv(csv).records.map((r) => r.cells);
    const header = records[0];
    expect(header[header.length - 1]).toBe("tags");
    const col = header.indexOf("tags");
    const byNote = new Map(records.slice(1).map((r) => [r[6], r[col]]));
    // Sorted by name: "=sum" before "holiday 2026"; the cell starts with "=", so it is prefixed.
    expect(byNote.get("Pizza")).toBe("'=sum, holiday 2026");
    expect(byNote.get("Coffee")).toBe("holiday 2026");
    expect(byNote.get("Bread")).toBe("");
    expect(byNote.get("ATM")).toBe("");

    const preview = await previewImport(bob.id, csv);
    expect(preview.problems).toEqual([]);
    expect(preview.tagsToCreate).toEqual(["=sum", "holiday 2026"]);
    expect((await runImport(bob.id, csv)).imported).toBe(true);
    expect(await tagsByNote(bob.id)).toEqual({ Pizza: ["=sum", "holiday 2026"], Coffee: ["holiday 2026"], Bread: [], ATM: [] });
    // Re-importing adds nothing, not even tags.
    const again = await previewImport(bob.id, csv);
    expect([again.transactionsToAdd, again.duplicateTransactions, again.tagsToCreate]).toEqual([0, 3, []]);
  });

  it("a file without the column imports as before", async () => {
    const csv = `${HEADER}\n2026-10-02,expense,Cash,EUR,12.00,Food,Pizza,,,\n`;
    const result = await runImport(alice.id, csv);
    expect(result.imported).toBe(true);
    expect(result.tagsToCreate).toEqual([]);
    expect(await tagsByNote(alice.id)).toEqual({ Pizza: [] });
  });

  it("matches existing tags ignoring case, creates the missing ones, and drops repeats in a cell", async () => {
    await seed();
    const csv = `${HEADER},tags\n2026-10-03,expense,Cash,EUR,3.00,Food,Tea,,,,"Holiday 2026, work ,WORK,"\n`;
    const preview = await previewImport(alice.id, csv);
    expect(preview.tagsToCreate).toEqual(["work"]);
    await runImport(alice.id, csv);
    expect((await tagsByNote(alice.id)).Tea).toEqual(["holiday 2026", "work"]);
    expect((await listTags(alice.id)).map((t) => t.name)).toEqual(["=sum", "holiday 2026", "work"]);
  });

  it("a duplicate row does not add its tags to the existing entry, and creates no tag only it uses", async () => {
    await seed();
    // Same as the existing "Bread" entry (no tags) and "Coffee", with tags.
    const csv = `${HEADER},tags\n2026-10-02,expense,Cash,EUR,5.00,Food,Bread,,,,new tag\n2026-10-02,expense,Cash,EUR,8.00,Food,Coffee,,,,other\n`;
    const preview = await previewImport(alice.id, csv);
    expect([preview.transactionsToAdd, preview.duplicateTransactions, preview.tagsToCreate]).toEqual([0, 2, []]);
    await runImport(alice.id, csv);
    expect((await tagsByNote(alice.id)).Bread).toEqual([]);
    expect((await tagsByNote(alice.id)).Coffee).toEqual(["holiday 2026"]);
    expect((await listTags(alice.id)).map((t) => t.name)).toEqual(["=sum", "holiday 2026"]);
    // With duplicates not skipped, the rows are added with their tags.
    const added = await runImport(alice.id, csv, { skipDuplicates: false });
    expect([added.transactionsToAdd, added.tagsToCreate]).toEqual([2, ["new tag", "other"]]);
  });

  it("reports a tag cell on a transfer, wallet or category row, an over-long tag and more than 10", async () => {
    const eleven = Array.from({ length: 11 }, (_, i) => `t${i}`).join(", ");
    const csv = [
      `${HEADER},group,archived,kind,tags`,
      `2026-10-01,transfer,Bank,EUR,10.00,,ATM,Cash,EUR,,,,,trip`,
      `,wallet,Cash,EUR,0,,,,,,,,,trip`,
      `,category,,,,Snacks,,,,,,,expense,trip`,
      `2026-10-02,expense,Cash,EUR,1.00,Food,a,,,,,,,${"x".repeat(41)}`,
      `2026-10-02,expense,Cash,EUR,1.00,Food,b,,,,,,,"${eleven}"`,
    ].join("\n");
    const p = await previewImport(alice.id, csv);
    expect(p.ok).toBe(false);
    expect(p.problems.map((x) => [x.line, x.message.split(":")[0]])).toEqual([
      [2, "tags"],
      [3, "tags"],
      [4, "tags"],
      [5, "tags"],
      [6, "tags"],
    ]);
    expect(p.problems[0].message).toMatch(/Transfers cannot have tags/);
    expect(p.problems[1].message).toMatch(/A wallet row only describes a wallet; leave tags empty/);
    expect(p.problems[2].message).toMatch(/A category row only describes a category; leave tags empty/);
    expect(p.problems[3].message).toMatch(/40 characters/);
    expect(p.problems[4].message).toMatch(/at most 10 tags/);
  });

  it("several files: one tag per name across them", async () => {
    const a = `${HEADER},tags\n2026-10-02,expense,Cash,EUR,1.00,Food,one,,,,Trip\n`;
    const b = `${HEADER},tags\n2026-10-03,expense,Cash,EUR,2.00,Food,two,,,,trip\n`;
    const r = await runImport(alice.id, [
      { name: "a.csv", text: a },
      { name: "b.csv", text: b },
    ]);
    expect(r.imported).toBe(true);
    expect(r.tagsToCreate).toEqual(["Trip"]);
    expect(await tagsByNote(alice.id)).toEqual({ one: ["Trip"], two: ["Trip"] });
  });

  it("parses the export of an untagged account to the same rows as before (the extra cell is empty)", async () => {
    const cash = await createWallet(alice.id, { name: "Cash", currency: "EUR", initialBalanceMinor: 0 });
    await createTransaction(alice.id, { walletId: cash.id, kind: "expense", categoryId: alice.cat("Food"), amountMinor: 100, date: "2026-10-02" });
    const rows = parseCsv(await buildTransactionsCsv(alice.id)).records.map((r) => r.cells);
    expect(rows.every((r) => r.length === rows[0].length)).toBe(true);
    expect(rows.slice(1).every((r) => r[r.length - 1] === "")).toBe(true);
    expect(toCsv([rows[0]])).toContain("kind,tags");
  });
});

describe("backup tags", () => {
  it("writes each entry's tags and the account's tag list (unused ones too), and restores both", async () => {
    await seed();
    await createTransaction(alice.id, {
      walletId: (await createWallet(alice.id, { name: "Spare", currency: "EUR", initialBalanceMinor: 0 })).id,
      kind: "expense",
      categoryId: alice.cat("Food"),
      amountMinor: 1,
      date: "2026-10-04",
      note: "temp",
      tags: ["unused later"],
    });
    // Make "unused later" unused: replace that entry's tags.
    const temp = (await listTransactions(alice.id, { q: "temp" })).items[0];
    const { updateTransaction } = await import("@/server/transactions");
    await updateTransaction(alice.id, temp.id, { walletId: temp.walletId, kind: "expense", categoryId: temp.categoryId!, amountMinor: 1, date: temp.date, note: "temp", tags: [] });

    const backup = await buildBackup(alice.id);
    expect(backup.tags).toEqual([{ name: "=sum" }, { name: "holiday 2026" }, { name: "unused later" }]);
    expect(backup.transactions.find((t) => t.note === "Pizza")?.tags).toEqual(["=sum", "holiday 2026"]);
    expect(backup.transactions.find((t) => t.note === "Bread")).not.toHaveProperty("tags");

    const text = JSON.stringify(backup);
    const preview = await previewImport(bob.id, text);
    expect(preview.problems).toEqual([]);
    expect(preview.tagsToCreate).toEqual(["=sum", "holiday 2026", "unused later"]);
    await runImport(bob.id, text);
    expect((await listTags(bob.id)).map((t) => [t.name, t.transactionCount])).toEqual([
      ["=sum", 1],
      ["holiday 2026", 2],
      ["unused later", 0],
    ]);
    expect((await tagsByNote(bob.id)).Pizza).toEqual(["=sum", "holiday 2026"]);
    // Again: nothing to add.
    const again = await previewImport(bob.id, text);
    expect([again.transactionsToAdd, again.tagsToCreate]).toEqual([0, []]);
  });

  it("an older backup without tags imports as before; bad tag names are problems at their path", async () => {
    await seed();
    const backup = await buildBackup(alice.id);
    const old = { ...backup, tags: undefined, transactions: backup.transactions.map((t) => ({ ...t, tags: undefined })) };
    const r = await runImport(bob.id, JSON.stringify(old));
    expect(r.imported).toBe(true);
    expect(await listTags(bob.id)).toEqual([]);

    const bad = {
      ...backup,
      tags: [{ name: "a,b" }],
      transactions: backup.transactions.map((t, i) => (i === 0 ? { ...t, tags: ["x".repeat(41)] } : t)),
    };
    const p = await previewImport(bob.id, JSON.stringify(bad));
    expect(p.problems.map((x) => x.path)).toEqual(["tags[0].name", "transactions[0].tags"]);
  });
});
