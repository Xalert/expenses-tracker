import { beforeEach, describe, expect, it } from "vitest";
import type { DB } from "@/db";
import { ServiceError } from "@/lib/errors";
import { buildTransactionsCsv } from "@/server/export";
import { createTransaction, listDayTotals, listTransactions } from "@/server/transactions";
import { createTransfer } from "@/server/transfers";
import { archiveWallet, createWallet } from "@/server/wallets";
import { makeUser, useFreshDb } from "./helpers";

let db: DB;
let alice: Awaited<ReturnType<typeof makeUser>>;
let bob: Awaited<ReturnType<typeof makeUser>>;

beforeEach(async () => {
  db = await useFreshDb();
  alice = await makeUser(db, "alice@example.com");
  bob = await makeUser(db, "bob@example.com");
});

async function expectServiceError(fn: () => unknown, code: ServiceError["code"], field?: string): Promise<void> {
  try {
    await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe(code);
    if (field !== undefined) expect((err as ServiceError).field).toBe(field);
    return;
  }
  throw new Error("expected a ServiceError");
}

type User = Awaited<ReturnType<typeof makeUser>>;
const wallet = async (u: User, currency = "EUR", name = `${currency} wallet`) =>
  (await createWallet(u.id, { name, currency, initialBalanceMinor: 0 })).id;
const spend = (u: User, walletId: number, amountMinor: number, date: string, note?: string) =>
  createTransaction(u.id, { walletId, kind: "expense", categoryId: u.cat("Food"), amountMinor, date, note });
const earn = (u: User, walletId: number, amountMinor: number, date: string) =>
  createTransaction(u.id, { walletId, kind: "income", categoryId: u.cat("Salary"), amountMinor, date });

describe("TransactionFilters.month", () => {
  beforeEach(async () => {
    const w = await wallet(alice);
    await spend(alice, w, 1, "2026-03-31");
    await spend(alice, w, 2, "2026-04-01");
    await spend(alice, w, 3, "2026-04-30");
    await spend(alice, w, 4, "2026-05-01");
  });

  const amounts = async (filters: Parameters<typeof listTransactions>[1]) =>
    (await listTransactions(alice.id, filters)).items.map((t) => t.amountMinor);

  it("limits the list to the month's first through last day", async () => {
    expect(await amounts({ month: "2026-04" })).toEqual([3, 2]);
    expect((await listTransactions(alice.id, { month: "2026-04" })).total).toBe(2);
    expect(await amounts({ month: "2026-06" })).toEqual([]);
  });

  it("is overridden by an explicit from or to", async () => {
    expect(await amounts({ month: "2026-04", from: "2026-03-31", to: "2026-03-31" })).toEqual([1]);
    expect(await amounts({ month: "2026-04", from: "2026-04-30" })).toEqual([4, 3]);
    expect(await amounts({ month: "2026-04", to: "2026-04-01" })).toEqual([2, 1]);
  });

  it("rejects an invalid month even when from/to are given", async () => {
    await expectServiceError(() => listTransactions(alice.id, { month: "2026-4" }), "VALIDATION", "month");
    await expectServiceError(
      () => listTransactions(alice.id, { month: "April", from: "2026-04-01" }),
      "VALIDATION",
      "month",
    );
  });

  it("also applies to the CSV export", async () => {
    const csv = await buildTransactionsCsv(alice.id, { month: "2026-04" });
    expect(csv.split("\n").filter((l) => l.includes("2026-")).map((l) => l.slice(0, 10))).toEqual([
      "2026-04-01",
      "2026-04-30",
    ]);
  });
});

describe("listDayTotals", () => {
  it("nets every match per date and currency, ignoring limit and offset", async () => {
    const eur = await wallet(alice, "EUR");
    const usd = await wallet(alice, "USD");
    await spend(alice, eur, 100, "2026-03-02");
    await spend(alice, eur, 250, "2026-03-02");
    await earn(alice, eur, 1000, "2026-03-02");
    await spend(alice, usd, 70, "2026-03-02");
    await spend(alice, eur, 5, "2026-03-01");
    await spend(alice, eur, 9, "2026-03-03"); // not asked for

    // A page of one row still gets the full day totals.
    const page = await listTransactions(alice.id, { limit: 1, offset: 1 });
    expect(page.items).toHaveLength(1);
    expect(await listDayTotals(alice.id, { limit: 1, offset: 1 }, ["2026-03-02", "2026-03-01", "2026-03-04"])).toEqual([
      { date: "2026-03-02", currency: "EUR", netMinor: 650 },
      { date: "2026-03-02", currency: "USD", netMinor: -70 },
      { date: "2026-03-01", currency: "EUR", netMinor: -5 },
    ]);
  });

  it("counts transfer legs as money out of / into their own wallet, in its own currency", async () => {
    const cash = await wallet(alice, "EUR", "Cash");
    const savings = await wallet(alice, "EUR", "Savings");
    const usd = await wallet(alice, "USD");
    await createTransfer(alice.id, { fromWalletId: cash, toWalletId: savings, amountMinor: 300, date: "2026-03-02" });
    await createTransfer(alice.id, {
      fromWalletId: usd,
      toWalletId: cash,
      amountMinor: 1000,
      receivedAmountMinor: 900,
      date: "2026-03-02",
    });
    const dates = ["2026-03-02"];
    // Across all wallets a same-currency transfer nets to zero; the cross-currency one does not.
    expect(await listDayTotals(alice.id, {}, dates)).toEqual([
      { date: "2026-03-02", currency: "EUR", netMinor: 900 },
      { date: "2026-03-02", currency: "USD", netMinor: -1000 },
    ]);
    expect(await listDayTotals(alice.id, { walletId: cash }, dates)).toEqual([
      { date: "2026-03-02", currency: "EUR", netMinor: 600 },
    ]);
    expect(await listDayTotals(alice.id, { walletId: savings, kind: "transfer" }, dates)).toEqual([
      { date: "2026-03-02", currency: "EUR", netMinor: 300 },
    ]);
    expect(await listDayTotals(alice.id, { kind: "expense" }, dates)).toEqual([]);
  });

  it("applies the other filters, includes archived wallets and ignores other users and bad dates", async () => {
    const eur = await wallet(alice, "EUR");
    const old = await wallet(alice, "EUR", "Old");
    await spend(alice, eur, 100, "2026-03-02", "coffee beans");
    await spend(alice, old, 40, "2026-03-02", "Coffee");
    await spend(alice, eur, 7, "2026-03-02", "bread");
    await archiveWallet(alice.id, old);
    await spend(bob, await wallet(bob, "EUR"), 999, "2026-03-02");

    expect(await listDayTotals(alice.id, {}, ["2026-03-02", "nope", "2026-02-30"])).toEqual([
      { date: "2026-03-02", currency: "EUR", netMinor: -147 },
    ]);
    expect(await listDayTotals(alice.id, { q: "coffee" }, ["2026-03-02"])).toEqual([
      { date: "2026-03-02", currency: "EUR", netMinor: -140 },
    ]);
    expect(await listDayTotals(alice.id, { month: "2026-04" }, ["2026-03-02"])).toEqual([]);
    expect(await listDayTotals(alice.id, { month: "2026-03" }, ["2026-03-02"])).toHaveLength(1);
    expect(await listDayTotals(alice.id, {}, [])).toEqual([]);
    expect(await listDayTotals(bob.id, {}, ["2026-03-02"])).toEqual([{ date: "2026-03-02", currency: "EUR", netMinor: -999 }]);
    await expectServiceError(() => listDayTotals(alice.id, { month: "x" }, ["2026-03-02"]), "VALIDATION", "month");
  });
});
