// Tags (SPEC "Tags"): the name rules, create-on-use, replacing an entry's set, rename / merge / delete, the user
// scope, the 10-tag limit, the /transactions filter and that the list loads tags without a query per row.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DB } from "@/db";
import { ServiceError } from "@/lib/errors";
import { dedupeTagNames, splitTagInput, sortTagNames, tagListProblem } from "@/lib/tags";
import { createRecurringEntry } from "@/server/recurring";
import { deleteTag, getTag, listTags, renameTag } from "@/server/tags";
import { getMonthTimeline } from "@/server/insights";
import {
  createTransaction,
  deleteTransaction,
  getTransaction,
  listDayTotals,
  listTransactions,
  updateTransaction,
} from "@/server/transactions";
import { createTransfer } from "@/server/transfers";
import { createWallet } from "@/server/wallets";
import { makeUser, useFreshDb } from "./helpers";

let db: DB;
let alice: Awaited<ReturnType<typeof makeUser>>;
let bob: Awaited<ReturnType<typeof makeUser>>;
let cash: number;

beforeEach(async () => {
  db = await useFreshDb();
  alice = await makeUser(db, "alice@example.com");
  bob = await makeUser(db, "bob@example.com");
  cash = (await createWallet(alice.id, { name: "Cash", currency: "EUR", initialBalanceMinor: 0 })).id;
});

const spend = (tags: string[] | undefined, over: { date?: string; amountMinor?: number; note?: string } = {}) =>
  createTransaction(alice.id, {
    walletId: cash,
    kind: "expense",
    categoryId: alice.cat("Food"),
    amountMinor: over.amountMinor ?? 1000,
    date: over.date ?? "2026-11-05",
    note: over.note ?? null,
    tags,
  });

async function rejectsOn(promise: Promise<unknown>, field: string, message?: RegExp) {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ServiceError);
  expect((err as ServiceError).field).toBe(field);
  if (message) expect((err as ServiceError).message).toMatch(message);
}

describe("tag names (src/lib/tags.ts)", () => {
  it("splits on commas, trims, collapses spaces and drops blanks and repeats ignoring case (first spelling wins)", () => {
    expect(splitTagInput(" holiday  2026 , Reimbursable,,reimbursable ,  ")).toEqual(["holiday 2026", "Reimbursable"]);
    expect(dedupeTagNames(["A", "a", " b "])).toEqual(["A", "b"]);
    expect(sortTagNames(["b", "A", "c"])).toEqual(["A", "b", "c"]);
  });

  it("refuses a name over 40 characters, a comma and more than 10 tags", () => {
    expect(tagListProblem(["x".repeat(40)])).toBeNull();
    expect(tagListProblem(["x".repeat(41)])).toMatch(/40 characters/);
    expect(tagListProblem(["a,b"])).toMatch(/comma/);
    expect(tagListProblem(Array.from({ length: 10 }, (_, i) => `t${i}`))).toBeNull();
    expect(tagListProblem(Array.from({ length: 11 }, (_, i) => `t${i}`))).toMatch(/at most 10/);
  });
});

describe("entry tags", () => {
  it("creates a tag the first time it is used, and reuses it (ignoring case) afterwards", async () => {
    const first = await spend(["Holiday 2026", "reimbursable"]);
    expect(first.tags).toEqual(["Holiday 2026", "reimbursable"]);
    const second = await spend(["holiday 2026"]);
    // The existing tag (and its spelling) is used; no second tag.
    expect(second.tags).toEqual(["Holiday 2026"]);
    expect((await listTags(alice.id)).map((t) => [t.name, t.transactionCount])).toEqual([
      ["Holiday 2026", 2],
      ["reimbursable", 1],
    ]);
  });

  it("returns the tags sorted by name ignoring case, and none for an entry without", async () => {
    expect((await spend(["zeta", "Alpha", "beta"])).tags).toEqual(["Alpha", "beta", "zeta"]);
    expect((await spend(undefined)).tags).toEqual([]);
    expect((await spend([])).tags).toEqual([]);
  });

  it("refuses more than 10 tags and an over-long name on the field `tags`, writing nothing", async () => {
    await rejectsOn(spend(Array.from({ length: 11 }, (_, i) => `t${i}`)), "tags", /at most 10/);
    await rejectsOn(spend(["x".repeat(41)]), "tags", /40 characters/);
    await rejectsOn(spend(["a,b"]), "tags", /comma/);
    expect((await listTransactions(alice.id)).total).toBe(0);
    expect(await listTags(alice.id)).toEqual([]);
  });

  it("an update replaces the whole set in the entry's DB transaction; omitting tags keeps them", async () => {
    const t = await spend(["a", "b"]);
    const input = { walletId: cash, kind: "expense" as const, categoryId: alice.cat("Food"), amountMinor: 1000, date: "2026-11-05" };
    expect((await updateTransaction(alice.id, t.id, { ...input, tags: ["b", "c"] })).tags).toEqual(["b", "c"]);
    expect((await updateTransaction(alice.id, t.id, { ...input, amountMinor: 2000 })).tags).toEqual(["b", "c"]);
    expect((await updateTransaction(alice.id, t.id, { ...input, tags: [] })).tags).toEqual([]);
    // A refused update changes neither the entry nor its tags.
    await updateTransaction(alice.id, t.id, { ...input, tags: ["keep"] });
    await rejectsOn(updateTransaction(alice.id, t.id, { ...input, amountMinor: 5, tags: Array(11).fill(0).map((_, i) => `n${i}`) }), "tags");
    const after = (await getTransaction(alice.id, t.id))!;
    expect([after.amountMinor, after.tags]).toEqual([1000, ["keep"]]);
    // The tags a, b, c stay (unused) until deleted.
    expect((await listTags(alice.id)).map((x) => [x.name, x.transactionCount])).toEqual([
      ["a", 0],
      ["b", 0],
      ["c", 0],
      ["keep", 1],
    ]);
  });

  it("deleting the entry removes its links, not the tag", async () => {
    const t = await spend(["trip"]);
    await deleteTransaction(alice.id, t.id);
    expect((await listTags(alice.id)).map((x) => [x.name, x.transactionCount])).toEqual([["trip", 0]]);
  });

  it("keeps users apart: the same name is a different tag per user", async () => {
    await spend(["shared"]);
    const bobCash = (await createWallet(bob.id, { name: "Cash", currency: "EUR", initialBalanceMinor: 0 })).id;
    const b = await createTransaction(bob.id, {
      walletId: bobCash,
      kind: "expense",
      categoryId: bob.cat("Food"),
      amountMinor: 100,
      date: "2026-11-05",
      tags: ["Shared"],
    });
    expect(b.tags).toEqual(["Shared"]);
    const [aliceTag] = await listTags(alice.id);
    const [bobTag] = await listTags(bob.id);
    expect(aliceTag.id).not.toBe(bobTag.id);
    expect(await getTag(bob.id, aliceTag.id)).toBeNull();
    await expect(renameTag(bob.id, aliceTag.id, { name: "mine" })).rejects.toThrow("Tag not found.");
    await expect(deleteTag(bob.id, aliceTag.id)).rejects.toThrow("Tag not found.");
    // Filtering by another user's tag matches nothing.
    expect((await listTransactions(bob.id, { tagId: aliceTag.id })).total).toBe(0);
    expect((await getTag(alice.id, aliceTag.id))?.name).toBe("shared");
  });

  it("a repeating entry's first entry gets the tags; the rule's later entries do not", async () => {
    const { transaction, added } = await createRecurringEntry(
      alice.id,
      { walletId: cash, kind: "expense", categoryId: alice.cat("Housing"), amountMinor: 50000, date: "2026-09-01", note: "Rent", tags: ["home"] },
      { frequency: "monthly" },
      "2026-11-05",
    );
    expect(added).toBe(2);
    expect(transaction.tags).toEqual(["home"]);
    const all = (await listTransactions(alice.id, { q: "Rent" })).items;
    expect(all.map((t) => [t.date, t.tags])).toEqual([
      ["2026-11-01", []],
      ["2026-10-01", []],
      ["2026-09-01", ["home"]],
    ]);
  });
});

describe("renameTag / deleteTag", () => {
  it("renames, and allows changing only the letter case", async () => {
    await spend(["trip"]);
    const [tag] = await listTags(alice.id);
    expect((await renameTag(alice.id, tag.id, { name: "  Summer   trip " })).tag.name).toBe("Summer trip");
    expect((await renameTag(alice.id, tag.id, { name: "summer TRIP" })).mergedFrom).toBeNull();
    expect((await getTag(alice.id, tag.id))?.name).toBe("summer TRIP");
    await rejectsOn(renameTag(alice.id, tag.id, { name: " " }), "name");
    await rejectsOn(renameTag(alice.id, tag.id, { name: "a, b" }), "name", /comma/);
    await rejectsOn(renameTag(alice.id, tag.id, { name: "x".repeat(41) }), "name");
  });

  it("renaming onto another tag's name merges the two in one step; an entry with both keeps one", async () => {
    const both = await spend(["work", "Office"]);
    const onlyWork = await spend(["work"]);
    const onlyOffice = await spend(["office"]);
    const tags = await listTags(alice.id);
    const work = tags.find((t) => t.name === "work")!;
    const office = tags.find((t) => t.name === "Office")!;
    const result = await renameTag(alice.id, work.id, { name: "OFFICE" });
    expect(result.mergedFrom).toBe("work");
    // The other tag keeps its own spelling and gains the entries.
    expect(result.tag).toEqual({ id: office.id, name: "Office", transactionCount: 3 });
    expect(await getTag(alice.id, work.id)).toBeNull();
    for (const t of [both, onlyWork, onlyOffice]) expect((await getTransaction(alice.id, t.id))!.tags).toEqual(["Office"]);
  });

  it("deletes a tag from its entries; the entries stay", async () => {
    const t = await spend(["a", "b"]);
    const a = (await listTags(alice.id)).find((x) => x.name === "a")!;
    expect(await deleteTag(alice.id, a.id)).toEqual({ name: "a", transactionCount: 1 });
    expect((await getTransaction(alice.id, t.id))!.tags).toEqual(["b"]);
    await expect(deleteTag(alice.id, a.id)).rejects.toThrow("Tag not found.");
  });
});

describe("the tag filter", () => {
  it("narrows the list, its total, the day totals and the day strip", async () => {
    await spend(["trip"], { amountMinor: 1200, date: "2026-11-03" });
    await spend(["trip", "food"], { amountMinor: 300, date: "2026-11-04" });
    await spend(["food"], { amountMinor: 5000, date: "2026-11-04" });
    await spend(undefined, { amountMinor: 700, date: "2026-11-04" });
    // A transfer is never tagged, so the filter leaves transfers out.
    const bank = (await createWallet(alice.id, { name: "Bank", currency: "EUR", initialBalanceMinor: 0 })).id;
    await createTransfer(alice.id, { fromWalletId: bank, toWalletId: cash, amountMinor: 999, date: "2026-11-04" });
    const trip = (await listTags(alice.id)).find((t) => t.name === "trip")!;

    const list = await listTransactions(alice.id, { tagId: trip.id, month: "2026-11" });
    expect(list.total).toBe(2);
    expect(list.items.map((t) => t.amountMinor)).toEqual([300, 1200]);
    expect(await listDayTotals(alice.id, { tagId: trip.id }, ["2026-11-03", "2026-11-04"])).toEqual([
      { date: "2026-11-04", currency: "EUR", netMinor: -300 },
      { date: "2026-11-03", currency: "EUR", netMinor: -1200 },
    ]);
    const timeline = await getMonthTimeline(alice.id, { month: "2026-11", currency: "EUR", tagId: trip.id });
    expect(timeline.days.filter((d) => d.expenseMinor > 0).map((d) => [d.date, d.expenseMinor])).toEqual([
      ["2026-11-03", 1200],
      ["2026-11-04", 300],
    ]);
    // Combined with the other filters.
    expect((await listTransactions(alice.id, { tagId: trip.id, q: "nothing" })).total).toBe(0);
    await expect(listTransactions(alice.id, { tagId: -1 })).rejects.toThrow(ServiceError);
  });

  it("loads the tags of a whole page with one query, not one per row", async () => {
    for (let i = 0; i < 12; i++) await spend([`t${i % 3}`, "all"], { amountMinor: 100 + i });
    const spy = vi.spyOn(db, "select");
    const { items } = await listTransactions(alice.id);
    expect(items).toHaveLength(12);
    expect(items.every((t) => t.tags.includes("all"))).toBe(true);
    // The page, the total and the tags: three queries whatever the page size.
    expect(spy).toHaveBeenCalledTimes(3);
    spy.mockRestore();
  });
});
