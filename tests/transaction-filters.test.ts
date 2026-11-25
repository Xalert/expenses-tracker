// The richer /transactions filters (SPEC /transactions, DECISIONS "Filters and bulk edit"): the amount range in each
// entry's own currency (0 / 2 / 3 decimals), several categories, several tags, the search over category and tag names,
// each alone and combined, and everything that follows them (day totals, the day strip, the CSV export).
import { beforeEach, describe, expect, it } from "vitest";
import type { DB } from "@/db";
import { boundToMinor, parseAmountBound, parseAmountRange, amountRangeLabel } from "@/lib/amount-filter";
import { ServiceError } from "@/lib/errors";
import { parseAmount, splitDecimalInput } from "@/lib/money";
import { buildTransactionsCsv } from "@/server/export";
import { getMonthTimeline } from "@/server/insights";
import { createTransaction, listDayTotals, listTransactions, type TransactionFilters } from "@/server/transactions";
import { createTransfer } from "@/server/transfers";
import { createWallet } from "@/server/wallets";
import { makeUser, useFreshDb } from "./helpers";

let db: DB;
let alice: Awaited<ReturnType<typeof makeUser>>;
let bob: Awaited<ReturnType<typeof makeUser>>;
let eur: number;
let jpy: number;
let kwd: number;

const M = "2026-11";

beforeEach(async () => {
  db = await useFreshDb();
  alice = await makeUser(db, "alice@example.com");
  bob = await makeUser(db, "bob@example.com");
  eur = (await createWallet(alice.id, { name: "Bank", currency: "EUR", initialBalanceMinor: 0 })).id;
  jpy = (await createWallet(alice.id, { name: "Yen", currency: "JPY", initialBalanceMinor: 0 })).id;
  kwd = (await createWallet(alice.id, { name: "Dinar", currency: "KWD", initialBalanceMinor: 0 })).id;
});

async function add(
  walletId: number,
  amountMinor: number,
  opts: { category?: string; kind?: "expense" | "income"; note?: string; tags?: string[]; date?: string } = {},
) {
  return createTransaction(alice.id, {
    walletId,
    kind: opts.kind ?? "expense",
    categoryId: alice.cat(opts.category ?? "Food"),
    amountMinor,
    date: opts.date ?? `${M}-05`,
    note: opts.note ?? null,
    tags: opts.tags,
  });
}

const notes = async (f: TransactionFilters) =>
  (await listTransactions(alice.id, { month: M, ...f })).items.map((t) => t.note).sort();

async function rejectsOn(promise: Promise<unknown>, field: string, message?: RegExp) {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ServiceError);
  expect((err as ServiceError).field).toBe(field);
  if (message) expect((err as ServiceError).message).toMatch(message);
}

describe("amount bounds (src/lib/amount-filter.ts)", () => {
  it("parses like amounts elsewhere: decimal comma, grouping, up to 3 decimals, never negative", () => {
    expect(splitDecimalInput("1.234,5")).toEqual({ negative: false, whole: "1234", frac: "5" });
    expect(parseAmount("12,50", "EUR")).toBe(1250);
    expect(parseAmountBound("12,5", "min")).toEqual({ scaled: BigInt(12500), text: "12,5" });
    expect(parseAmountBound(" 1 000 ", "max")).toEqual({ scaled: BigInt(1_000_000), text: "1 000" });
    expect(parseAmountBound("", "min")).toBeNull();
    expect(parseAmountBound("0", "min")).toEqual({ scaled: BigInt(0), text: "0" });
    expect(parseAmountBound("-0", "min")).toEqual({ scaled: BigInt(0), text: "-0" });
    expect(parseAmountBound("-5", "min")).toEqual({ error: "The minimum cannot be negative." });
    expect(parseAmountBound("abc", "max")).toEqual({ error: "Enter the maximum as an amount, like 12.50." });
    expect(parseAmountBound("1.2345", "min")).toEqual({ error: "Enter the minimum with at most 3 decimals." });
    expect(parseAmountBound("99999999999999999", "min")).toEqual({ error: "That minimum is too large." });
  });

  it("puts a maximum below the minimum on `max`; an invalid bound is left out of the range", () => {
    expect(parseAmountRange("10", "5").errors).toEqual({ max: "The maximum is below the minimum." });
    expect(parseAmountRange("10", "5").range.min?.text).toBe("10");
    expect(parseAmountRange("x", "5").range).toEqual({ max: { scaled: BigInt(5000), text: "5" } });
    expect(parseAmountRange(undefined, undefined)).toEqual({ range: {}, errors: {} });
  });

  it("scales into each currency's minor units, rounding inwards when the bound has more decimals", () => {
    const b = parseAmountBound("12.5", "min") as { scaled: bigint; text: string };
    expect(boundToMinor(b, 0, "min")).toBe(13); // ¥12.5 or more: ¥13
    expect(boundToMinor(b, 0, "max")).toBe(12);
    expect(boundToMinor(b, 2, "min")).toBe(1250);
    expect(boundToMinor(b, 3, "max")).toBe(12500);
    const exact = parseAmountBound("12", "min") as { scaled: bigint; text: string };
    expect(boundToMinor(exact, 0, "min")).toBe(12);
  });

  it("labels the chip", () => {
    expect(amountRangeLabel("10", "50")).toBe("10 – 50");
    expect(amountRangeLabel("10", undefined)).toBe("≥ 10");
    expect(amountRangeLabel(undefined, "50")).toBe("≤ 50");
    expect(amountRangeLabel(undefined, " ")).toBeUndefined();
  });
});

describe("the amount range on the list", () => {
  beforeEach(async () => {
    await add(eur, 999, { note: "eur 9.99" });
    await add(eur, 1000, { note: "eur 10.00" });
    await add(eur, 5000, { note: "eur 50.00" });
    await add(jpy, 10, { note: "jpy 10" });
    await add(jpy, 11, { note: "jpy 11" });
    await add(kwd, 9_999, { note: "kwd 9.999" });
    await add(kwd, 10_000, { note: "kwd 10.000" });
  });

  it("compares each entry in its own currency, bounds included", async () => {
    expect(await notes({ minAmount: "10" })).toEqual(["eur 10.00", "eur 50.00", "jpy 10", "jpy 11", "kwd 10.000"]);
    expect(await notes({ maxAmount: "10" })).toEqual(["eur 10.00", "eur 9.99", "jpy 10", "kwd 10.000", "kwd 9.999"]);
    expect(await notes({ minAmount: "10", maxAmount: "10" })).toEqual(["eur 10.00", "jpy 10", "kwd 10.000"]);
    // A decimal comma, and a bound finer than yen: ¥10.5 or more is ¥11 and up.
    expect(await notes({ minAmount: "10,5", maxAmount: "49,999" })).toEqual(["jpy 11"]);
    expect(await notes({ minAmount: "9.999", maxAmount: "9.999" })).toEqual(["kwd 9.999"]);
  });

  it("refuses an invalid, negative or crossed bound on its field", async () => {
    await rejectsOn(listTransactions(alice.id, { minAmount: "-1" }), "min", /negative/);
    await rejectsOn(listTransactions(alice.id, { maxAmount: "ten" }), "max");
    await rejectsOn(listTransactions(alice.id, { minAmount: "20", maxAmount: "10" }), "max", /below the minimum/);
  });

  it("applies to the day totals and the day strip too", async () => {
    expect(await listDayTotals(alice.id, { month: M, minAmount: "10" }, [`${M}-05`])).toEqual([
      { date: `${M}-05`, currency: "EUR", netMinor: -6000 },
      { date: `${M}-05`, currency: "JPY", netMinor: -21 },
      { date: `${M}-05`, currency: "KWD", netMinor: -10_000 },
    ]);
    const strip = await getMonthTimeline(alice.id, { month: M, currency: "EUR", minAmount: "10" });
    expect(strip.days.find((d) => d.date === `${M}-05`)?.expenseMinor).toBe(6000);
    await expect(getMonthTimeline(alice.id, { month: M, currency: "EUR", minAmount: "-2" })).rejects.toThrow(ServiceError);
  });
});

describe("several categories and tags", () => {
  beforeEach(async () => {
    await add(eur, 100, { category: "Food", note: "lunch", tags: ["work"] });
    await add(eur, 200, { category: "Groceries", note: "market", tags: ["home"] });
    await add(eur, 300, { category: "Bills", note: "power", tags: ["home", "work"] });
    await add(eur, 400, { category: "Salary", kind: "income", note: "pay" });
  });

  it("an entry matches any of the categories, any of the tags; different filters combine with AND", async () => {
    const [food, groceries, salary] = [alice.cat("Food"), alice.cat("Groceries"), alice.cat("Salary")];
    expect(await notes({ categoryIds: [food, groceries] })).toEqual(["lunch", "market"]);
    expect(await notes({ categoryIds: [food, salary] })).toEqual(["lunch", "pay"]);
    // The single value still works, merged with the list.
    expect(await notes({ categoryId: groceries, categoryIds: [food] })).toEqual(["lunch", "market"]);

    const { listTags } = await import("@/server/tags");
    const byName = new Map((await listTags(alice.id)).map((t) => [t.name, t.id]));
    const [home, work] = [byName.get("home")!, byName.get("work")!];
    expect(await notes({ tagIds: [home] })).toEqual(["market", "power"]);
    expect(await notes({ tagIds: [home, work] })).toEqual(["lunch", "market", "power"]);
    // AND across filters.
    expect(await notes({ tagIds: [home, work], categoryIds: [food, groceries] })).toEqual(["lunch", "market"]);
    expect(await notes({ tagIds: [work], minAmount: "2" })).toEqual(["power"]);
    expect(await notes({ tagIds: [home], categoryIds: [food] })).toEqual([]);
  });

  it("another user's ids match nothing; malformed ids are refused", async () => {
    const bobFood = bob.cat("Food");
    expect(await notes({ categoryIds: [bobFood] })).toEqual([]);
    expect(await notes({ tagIds: [9999] })).toEqual([]);
    await rejectsOn(listTransactions(alice.id, { categoryIds: [0] }), "categoryId");
    await rejectsOn(listTransactions(alice.id, { tagIds: [-1] }), "tagId");
  });

  it("the strip follows them", async () => {
    const strip = await getMonthTimeline(alice.id, {
      month: M,
      currency: "EUR",
      categoryIds: [alice.cat("Food"), alice.cat("Bills")],
    });
    expect(strip.days.find((d) => d.date === `${M}-05`)?.expenseMinor).toBe(400);
  });
});

describe("search", () => {
  beforeEach(async () => {
    await add(eur, 100, { category: "Groceries", note: "Lidl" });
    await add(eur, 200, { category: "Food", note: "pizza", tags: ["Holiday 2026"] });
    await add(eur, 300, { category: "Bills", note: null as unknown as string });
    await createTransfer(alice.id, { fromWalletId: eur, toWalletId: jpy, amountMinor: 500, receivedAmountMinor: 80, date: `${M}-06`, note: "grocery money" });
  });

  it("matches the note, the category name or a tag name, ignoring case; transfers on their note", async () => {
    expect(await notes({ q: "lidl" })).toEqual(["Lidl"]);
    // "groc" is in the Groceries category and in the transfer's note (both legs).
    const groc = (await listTransactions(alice.id, { month: M, q: "GROC" })).items.map((t) => t.kind).sort();
    expect(groc).toEqual(["expense", "transfer_in", "transfer_out"]);
    expect(await notes({ q: "holiday" })).toEqual(["pizza"]);
    expect((await listTransactions(alice.id, { month: M, q: "bills" })).items.map((t) => t.categoryName)).toEqual(["Bills"]);
    // LIKE wildcards are literal.
    expect(await notes({ q: "%" })).toEqual([]);
  });
});

describe("the CSV export follows the filters", () => {
  it("amount range, several categories, tags and the search", async () => {
    await add(eur, 1000, { category: "Food", note: "ten", tags: ["trip"] });
    await add(eur, 2000, { category: "Groceries", note: "twenty" });
    await add(jpy, 500, { category: "Bills", note: "yen" });
    const rows = async (f: TransactionFilters) =>
      (await buildTransactionsCsv(alice.id, f))
        .split("\r\n")
        .filter((l) => /^\d{4}-/.test(l.replace(/^﻿/, "")));
    expect((await rows({ minAmount: "15", maxAmount: "600" })).map((l) => /twenty|yen/.exec(l)?.[0])).toEqual(["twenty", "yen"]);
    expect(await rows({ categoryIds: [alice.cat("Food"), alice.cat("Bills")] })).toHaveLength(2);
    expect(await rows({ q: "trip" })).toHaveLength(1);
    await expect(buildTransactionsCsv(alice.id, { minAmount: "-1" })).rejects.toThrow(ServiceError);
  });
});

describe("the category colour on rows", () => {
  it("comes with each row (null without one), in the same query", async () => {
    const { renameCategory } = await import("@/server/categories");
    await renameCategory(alice.id, alice.cat("Food"), { name: "Food", color: "teal" });
    await add(eur, 100, { category: "Food" });
    await add(eur, 100, { category: "Bills" });
    const items = (await listTransactions(alice.id, { month: M })).items;
    expect(items.map((t) => [t.categoryName, t.categoryColor]).sort()).toEqual([
      ["Bills", null],
      ["Food", "teal"],
    ]);
  });
});
