// Bulk edits on /transactions (src/server/bulk.ts): delete, set category, add / remove a tag, by ids and by filters,
// with mixed kinds, transfers, the tag limit, archived categories, another user's ids, the upper bound and
// all-or-nothing.
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DB } from "@/db";
import { transactions, transfers } from "@/db/schema";
import { ServiceError } from "@/lib/errors";
import {
  MAX_BULK_ENTRIES,
  bulkAddTag,
  bulkDelete,
  bulkRemoveTag,
  bulkSetCategory,
  previewBulk,
} from "@/server/bulk";
import { archiveCategory } from "@/server/categories";
import { listTags } from "@/server/tags";
import { createTransaction, getTransaction, listTransactions } from "@/server/transactions";
import { createTransfer, getTransfer } from "@/server/transfers";
import { createWallet } from "@/server/wallets";
import { makeUser, useFreshDb } from "./helpers";

let db: DB;
let alice: Awaited<ReturnType<typeof makeUser>>;
let bob: Awaited<ReturnType<typeof makeUser>>;
let eur: number;
let jpy: number;

beforeEach(async () => {
  db = await useFreshDb();
  alice = await makeUser(db, "alice@example.com");
  bob = await makeUser(db, "bob@example.com");
  eur = (await createWallet(alice.id, { name: "Bank", currency: "EUR", initialBalanceMinor: 0 })).id;
  jpy = (await createWallet(alice.id, { name: "Yen", currency: "JPY", initialBalanceMinor: 0 })).id;
});

const add = (opts: { kind?: "expense" | "income"; category?: string; amountMinor?: number; note?: string; tags?: string[]; date?: string } = {}) =>
  createTransaction(alice.id, {
    walletId: eur,
    kind: opts.kind ?? "expense",
    categoryId: alice.cat(opts.category ?? (opts.kind === "income" ? "Salary" : "Food")),
    amountMinor: opts.amountMinor ?? 1000,
    date: opts.date ?? "2026-11-05",
    note: opts.note ?? null,
    tags: opts.tags,
  });

const transfer = (note = "move") =>
  createTransfer(alice.id, { fromWalletId: eur, toWalletId: jpy, amountMinor: 1000, receivedAmountMinor: 160, date: "2026-11-06", note });

/** The transfer's two legs (out first). */
async function legsOf(transferId: number) {
  return db.select().from(transactions).where(eq(transactions.transferId, transferId)).orderBy(transactions.kind);
}

async function rejectsWith(promise: Promise<unknown>, code: string, field?: string, message?: RegExp) {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ServiceError);
  expect((err as ServiceError).code).toBe(code);
  expect((err as ServiceError).field).toBe(field);
  if (message) expect((err as ServiceError).message).toMatch(message);
}

describe("bulkDelete", () => {
  it("by ids: removes the entries and, for a selected leg, the whole transfer", async () => {
    const a = await add({ note: "a" });
    const b = await add({ note: "b" });
    const keep = await add({ note: "keep" });
    const t = await transfer();
    const [leg] = await legsOf(t.id);
    expect(await previewBulk(alice.id, { ids: [a.id, b.id, leg.id] })).toEqual({ entries: 2, transfers: 1 });
    expect(await bulkDelete(alice.id, { ids: [a.id, b.id, leg.id] })).toEqual({ entries: 2, transfers: 1 });
    expect(await getTransaction(alice.id, a.id)).toBeNull();
    expect(await getTransfer(alice.id, t.id)).toBeNull();
    expect(await legsOf(t.id)).toEqual([]);
    expect((await listTransactions(alice.id)).items.map((x) => x.id)).toEqual([keep.id]);
  });

  it("by filters: re-evaluated on the server; both legs of a transfer count once", async () => {
    await add({ note: "Lidl", date: "2026-11-01" });
    await add({ note: "lidl again", date: "2026-11-02" });
    await add({ note: "other" });
    await add({ note: "lidl october", date: "2026-10-20" });
    await transfer("lidl cash");
    const target = { filters: { month: "2026-11", q: "lidl" } };
    expect(await previewBulk(alice.id, target)).toEqual({ entries: 2, transfers: 1 });
    expect(await bulkDelete(alice.id, target)).toEqual({ entries: 2, transfers: 1 });
    expect((await listTransactions(alice.id)).items.map((x) => x.note).sort()).toEqual(["lidl october", "other"]);
    expect(await db.select().from(transfers)).toEqual([]);
  });

  it("refuses when the target no longer matches the confirmed counts, and changes nothing", async () => {
    const a = await add();
    const b = await add();
    await rejectsWith(bulkDelete(alice.id, { ids: [a.id, b.id] }, { expected: { entries: 3, transfers: 0 } }), "CONFLICT");
    expect((await listTransactions(alice.id)).total).toBe(2);
    expect(await bulkDelete(alice.id, { ids: [a.id, b.id] }, { expected: { entries: 2, transfers: 0 } })).toEqual({ entries: 2, transfers: 0 });
  });

  it("another user's ids behave like missing ones", async () => {
    const mine = await add();
    const theirs = await createTransaction(bob.id, {
      walletId: (await createWallet(bob.id, { name: "B", currency: "EUR", initialBalanceMinor: 0 })).id,
      kind: "expense",
      categoryId: bob.cat("Food"),
      amountMinor: 100,
      date: "2026-11-05",
    });
    await rejectsWith(bulkDelete(alice.id, { ids: [theirs.id] }), "NOT_FOUND");
    expect(await bulkDelete(alice.id, { ids: [mine.id, theirs.id] })).toEqual({ entries: 1, transfers: 0 });
    expect(await getTransaction(bob.id, theirs.id)).not.toBeNull();
    // Filters are scoped to the user too.
    await rejectsWith(bulkDelete(bob.id, { filters: { categoryIds: [alice.cat("Food")] } }), "NOT_FOUND");
  });

  it("refuses an empty or malformed selection", async () => {
    await rejectsWith(bulkDelete(alice.id, { ids: [] }), "VALIDATION", "ids");
    await rejectsWith(bulkDelete(alice.id, { ids: [0] }), "VALIDATION", "ids");
    await rejectsWith(bulkDelete(alice.id, { filters: { month: "2026-11" } }), "NOT_FOUND");
  });
});

describe("the upper bound", () => {
  it(`refuses more than ${MAX_BULK_ENTRIES} entries with the count, and changes nothing`, async () => {
    // Fast insert of MAX + 1 rows straight into the table.
    await db.execute(sql`
      insert into transactions (user_id, wallet_id, kind, category_id, amount_minor, date)
      select ${alice.id}, ${eur}, 'expense', ${alice.cat("Food")}, 100, '2026-11-05' from generate_series(1, ${MAX_BULK_ENTRIES + 1})`);
    await rejectsWith(
      bulkSetCategory(alice.id, { filters: { month: "2026-11" } }, alice.cat("Groceries")),
      "VALIDATION",
      undefined,
      /2,001 entries; one change can touch at most 2,000/,
    );
    await rejectsWith(bulkDelete(alice.id, { ids: Array.from({ length: MAX_BULK_ENTRIES + 1 }, (_, i) => i + 1) }), "VALIDATION");
    expect((await listTransactions(alice.id, { categoryIds: [alice.cat("Food")] })).total).toBe(MAX_BULK_ENTRIES + 1);
    // At the bound it goes through.
    await db.execute(sql`delete from transactions where id = (select max(id) from transactions)`);
    const r = await bulkSetCategory(alice.id, { filters: { month: "2026-11" } }, alice.cat("Groceries"));
    expect(r.changed).toBe(MAX_BULK_ENTRIES);
  });
});

describe("bulkSetCategory", () => {
  it("moves the entries of the category's kind and counts the rest", async () => {
    const food = await add({ category: "Food" });
    const already = await add({ category: "Groceries" });
    const pay = await add({ kind: "income" });
    const t = await transfer();
    const [leg] = await legsOf(t.id);
    const r = await bulkSetCategory(alice.id, { ids: [food.id, already.id, pay.id, leg.id] }, alice.cat("Groceries"));
    expect(r).toEqual({
      category: { id: alice.cat("Groceries"), name: "Groceries", kind: "expense" },
      changed: 1,
      unchanged: 1,
      skippedOtherKind: 1,
      skippedTransfers: 1,
    });
    expect((await getTransaction(alice.id, food.id))!.categoryName).toBe("Groceries");
    expect((await getTransaction(alice.id, pay.id))!.categoryName).toBe("Salary");
    expect((await legsOf(t.id)).every((l) => l.categoryId === null)).toBe(true);
  });

  it("by filters (an income category on a mixed list)", async () => {
    await add({ kind: "income", category: "Salary", note: "x" });
    await add({ kind: "income", category: "Refund", note: "x" });
    await add({ note: "x" });
    const r = await bulkSetCategory(alice.id, { filters: { q: "x" } }, alice.cat("Extra Income"));
    expect([r.changed, r.unchanged, r.skippedOtherKind, r.skippedTransfers]).toEqual([2, 0, 1, 0]);
  });

  it("refuses an archived, missing or another user's category, and a target with none of its kind", async () => {
    const e = await add();
    await archiveCategory(alice.id, alice.cat("Groceries"));
    await rejectsWith(bulkSetCategory(alice.id, { ids: [e.id] }, alice.cat("Groceries")), "VALIDATION", "categoryId", /archived/);
    await rejectsWith(bulkSetCategory(alice.id, { ids: [e.id] }, bob.cat("Bills")), "NOT_FOUND", "categoryId");
    await rejectsWith(bulkSetCategory(alice.id, { ids: [e.id] }, alice.cat("Salary")), "VALIDATION", "categoryId", /none of the selected/);
    expect((await getTransaction(alice.id, e.id))!.categoryName).toBe("Food");
  });
});

describe("bulkAddTag / bulkRemoveTag", () => {
  it("adds a tag (created on use, matched ignoring case), skipping entries at 10 tags and transfers", async () => {
    const full = await add({ tags: ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9", "t10"] });
    const plain = await add();
    const has = await add({ tags: ["Trip"] });
    const t = await transfer();
    const [leg] = await legsOf(t.id);
    const r = await bulkAddTag(alice.id, { ids: [full.id, plain.id, has.id, leg.id] }, "  trip ");
    expect(r).toMatchObject({ tag: { name: "Trip" }, added: 1, already: 1, skippedAtLimit: 1, skippedTransfers: 1 });
    expect((await getTransaction(alice.id, plain.id))!.tags).toEqual(["Trip"]);
    expect((await getTransaction(alice.id, full.id))!.tags).toHaveLength(10);

    const created = await bulkAddTag(alice.id, { ids: [plain.id] }, "new one");
    expect(created.tag.id).not.toBeNull();
    expect((await listTags(alice.id)).some((x) => x.name === "new one")).toBe(true);
  });

  it("does not create the tag when no entry gets it", async () => {
    const full = await add({ tags: ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9", "t10"] });
    const r = await bulkAddTag(alice.id, { ids: [full.id] }, "ghost");
    expect(r).toMatchObject({ tag: { id: null, name: "ghost" }, added: 0, skippedAtLimit: 1 });
    expect((await listTags(alice.id)).some((x) => x.name === "ghost")).toBe(false);
  });

  it("refuses a bad tag name and a selection of transfers only, changing nothing", async () => {
    const e = await add();
    await rejectsWith(bulkAddTag(alice.id, { ids: [e.id] }, "a,b"), "VALIDATION", "tagName");
    await rejectsWith(bulkAddTag(alice.id, { ids: [e.id] }, ""), "VALIDATION", "tagName");
    const t = await transfer();
    const [leg] = await legsOf(t.id);
    await rejectsWith(bulkAddTag(alice.id, { ids: [leg.id] }, "x"), "VALIDATION", "tagName", /expenses and income/);
    expect(await listTags(alice.id)).toEqual([]);
  });

  it("removes a tag from the entries that have it; the tag stays", async () => {
    const a = await add({ tags: ["home", "work"] });
    const b = await add({ tags: ["home"] });
    const c = await add();
    const home = (await listTags(alice.id)).find((x) => x.name === "home")!;
    const r = await bulkRemoveTag(alice.id, { filters: { tagIds: [home.id] } }, home.id);
    expect(r).toEqual({ tag: { id: home.id, name: "home" }, removed: 2, notTagged: 0, skippedTransfers: 0 });
    expect((await getTransaction(alice.id, a.id))!.tags).toEqual(["work"]);
    expect((await getTransaction(alice.id, b.id))!.tags).toEqual([]);
    expect((await listTags(alice.id)).find((x) => x.name === "home")?.transactionCount).toBe(0);
    const again = await bulkRemoveTag(alice.id, { ids: [a.id, c.id] }, home.id);
    expect([again.removed, again.notTagged]).toEqual([0, 2]);
    await rejectsWith(bulkRemoveTag(bob.id, { ids: [a.id] }, home.id), "NOT_FOUND", "tagId");
  });
});

describe("all or nothing", () => {
  it("a failure mid-way rolls the whole call back", async () => {
    const a = await add();
    const b = await add();
    const t = await transfer();
    const [leg] = await legsOf(t.id);
    // Make the second statement of the delete (the transfer legs) fail.
    const real = db.transaction.bind(db);
    const spy = vi.spyOn(db, "transaction").mockImplementation((fn, config) =>
      real(async (tx) => {
        const del = tx.delete.bind(tx);
        let calls = 0;
        (tx as unknown as { delete: typeof tx.delete }).delete = ((table: Parameters<typeof del>[0]) => {
          calls += 1;
          if (calls === 2) throw new Error("boom");
          return del(table);
        }) as typeof tx.delete;
        return fn(tx);
      }, config),
    );
    await expect(bulkDelete(alice.id, { ids: [a.id, b.id, leg.id] })).rejects.toThrow("boom");
    spy.mockRestore();
    expect((await listTransactions(alice.id)).total).toBe(4);
    expect(await getTransfer(alice.id, t.id)).not.toBeNull();
  });
});
