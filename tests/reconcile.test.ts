// reconcileWallet: the actual balance minus the tracked balance at the end of the date becomes one entry in
// "Balance adjustment" (src/server/reconcile.ts).
import { beforeEach, describe, expect, it } from "vitest";
import type { DB } from "@/db";
import { adjustmentPreview, adjustmentResultMessage, balanceOnDate } from "@/lib/reconcile";
import { archiveCategory, createCategory, listCategories } from "@/server/categories";
import { BALANCE_ADJUSTMENT, getWalletBalanceOn, listWalletClosingBalances, reconcileWallet } from "@/server/reconcile";
import { createTransaction, listTransactions } from "@/server/transactions";
import { createTransfer } from "@/server/transfers";
import { archiveWalletGroup, createWalletGroup } from "@/server/wallet-groups";
import { archiveWallet, createWallet, getWallet } from "@/server/wallets";
import { getWalletMonth } from "@/server/insights";
import { makeUser, useFreshDb } from "./helpers";

const TODAY = "2026-11-25";

let db: DB;
let user: Awaited<ReturnType<typeof makeUser>>;

beforeEach(async () => {
  db = await useFreshDb();
  user = await makeUser(db, "alice@example.com");
});

async function wallet(currency = "EUR", initialBalanceMinor = 100_000, groupId?: number) {
  return createWallet(user.id, { name: `W ${currency}`, currency, initialBalanceMinor, groupId });
}

async function spend(walletId: number, amountMinor: number, date: string) {
  return createTransaction(user.id, { walletId, kind: "expense", categoryId: user.cat("Food"), amountMinor, date });
}

const reconcile = (walletId: number, actualBalanceMinor: number, date = TODAY) =>
  reconcileWallet(user.id, walletId, { actualBalanceMinor, date }, { today: TODAY });

async function adjustmentCategories() {
  return (await listCategories(user.id, undefined, { includeArchived: true })).filter((c) => c.name === BALANCE_ADJUSTMENT);
}

describe("reconcileWallet", () => {
  it("records a lower actual balance as an expense in a new Balance adjustment category", async () => {
    const w = await wallet();
    await spend(w.id, 2_000, "2026-11-20");
    const r = await reconcile(w.id, 96_760);
    expect(r).toMatchObject({ trackedBalanceMinor: 98_000, actualBalanceMinor: 96_760, differenceMinor: -1_240, categoryCreated: true });
    expect(r.transaction).toMatchObject({
      kind: "expense",
      walletId: w.id,
      amountMinor: 1_240,
      date: TODAY,
      note: null, // the category names it
      categoryName: "Balance adjustment",
    });
    expect((await getWallet(user.id, w.id, { balanceOn: TODAY }))!.balanceMinor).toBe(96_760);
    expect(await adjustmentCategories()).toEqual([expect.objectContaining({ kind: "expense", archivedAt: null })]);
  });

  it("records a higher actual balance as income, and reuses the category the next time", async () => {
    const w = await wallet();
    const first = await reconcile(w.id, 100_500);
    expect(first).toMatchObject({ differenceMinor: 500, categoryCreated: true });
    expect(first.transaction).toMatchObject({ kind: "income", amountMinor: 500 });
    const second = await reconcile(w.id, 101_000);
    expect(second).toMatchObject({ differenceMinor: 500, categoryCreated: false });
    expect(second.transaction!.categoryId).toBe(first.transaction!.categoryId);
    expect(await adjustmentCategories()).toHaveLength(1);
  });

  it("creates one category per kind", async () => {
    const w = await wallet();
    await reconcile(w.id, 100_100);
    await reconcile(w.id, 99_000);
    expect((await adjustmentCategories()).map((c) => c.kind).sort()).toEqual(["expense", "income"]);
  });

  it("records nothing when the balance already matches", async () => {
    const w = await wallet();
    const r = await reconcile(w.id, 100_000);
    expect(r).toMatchObject({ differenceMinor: 0, transaction: null, categoryCreated: false });
    expect((await listTransactions(user.id, { walletId: w.id })).total).toBe(0);
    expect(await adjustmentCategories()).toEqual([]);
  });

  it("works in whole yen and in three-decimal dinars", async () => {
    const yen = await wallet("JPY", 5_000);
    const r1 = await reconcile(yen.id, 4_321);
    expect(r1.transaction).toMatchObject({ kind: "expense", amountMinor: 679, currency: "JPY" });
    const kwd = await wallet("KWD", 1_000);
    const r2 = await reconcile(kwd.id, 1_235);
    expect(r2.transaction).toMatchObject({ kind: "income", amountMinor: 235, currency: "KWD" });
  });

  it("takes a negative actual balance (a card in debt)", async () => {
    const w = await wallet("EUR", -10_000);
    const r = await reconcile(w.id, -12_550);
    expect(r).toMatchObject({ trackedBalanceMinor: -10_000, differenceMinor: -2_550 });
    expect((await getWallet(user.id, w.id, { balanceOn: TODAY }))!.balanceMinor).toBe(-12_550);
    const up = await reconcile(w.id, 3_000);
    expect(up.transaction).toMatchObject({ kind: "income", amountMinor: 15_550 });
  });

  it("for a past date compares with the balance at the end of that day, ignoring later entries", async () => {
    const w = await wallet();
    await spend(w.id, 1_000, "2026-11-10");
    await spend(w.id, 3_000, "2026-11-20");
    const r = await reconcile(w.id, 98_500, "2026-11-15");
    expect(r).toMatchObject({ trackedBalanceMinor: 99_000, differenceMinor: -500 });
    expect(r.transaction).toMatchObject({ date: "2026-11-15", amountMinor: 500 });
    expect(await getWalletBalanceOn(user.id, w.id, "2026-11-15")).toBe(98_500);
    expect(await getWalletBalanceOn(user.id, w.id, TODAY)).toBe(95_500);
  });

  it("leaves future-dated entries out of today's balance, as the wallet page does", async () => {
    const w = await wallet();
    await spend(w.id, 1_000, TODAY);
    await spend(w.id, 5_000, "2026-11-28");
    const r = await reconcile(w.id, 98_000);
    expect(r).toMatchObject({ trackedBalanceMinor: 99_000, differenceMinor: -1_000 });
    // The wallet page's balance today (and the last day of getWalletMonth) is now the balance typed.
    expect(await getWalletBalanceOn(user.id, w.id, TODAY)).toBe(98_000);
    const month = await getWalletMonth(user.id, w.id, "2026-11", { today: TODAY });
    expect(month!.days.at(-1)).toMatchObject({ date: TODAY, closingMinor: 98_000 });
    expect(month!.projectedDays.at(-1)!.closingMinor).toBe(93_000);
  });

  it("counts transfers in the tracked balance", async () => {
    const a = await wallet();
    const b = await wallet("EUR", 0);
    await createTransfer(user.id, { fromWalletId: a.id, toWalletId: b.id, amountMinor: 20_000, date: "2026-11-01" });
    expect((await reconcile(a.id, 80_000)).differenceMinor).toBe(0);
    expect((await reconcile(b.id, 20_100)).differenceMinor).toBe(100);
  });

  it("refuses a date after today and an invalid one", async () => {
    const w = await wallet();
    await expect(reconcile(w.id, 1, "2026-11-26")).rejects.toMatchObject({ code: "VALIDATION", field: "date" });
    await expect(reconcile(w.id, 1, "2026-02-30")).rejects.toMatchObject({ code: "VALIDATION", field: "date" });
  });

  it("refuses a balance that is not a safe integer", async () => {
    const w = await wallet();
    await expect(reconcile(w.id, 1.5)).rejects.toMatchObject({ code: "VALIDATION", field: "actualBalance" });
    await expect(reconcile(w.id, Number.MAX_SAFE_INTEGER + 2)).rejects.toMatchObject({ field: "actualBalance" });
  });

  it("refuses an archived wallet and a wallet in an archived group", async () => {
    const w = await wallet();
    await archiveWallet(user.id, w.id);
    await expect(reconcile(w.id, 1)).rejects.toThrow("This wallet is archived.");
    const trips = await createWalletGroup(user.id, { name: "Trips" });
    const t = await wallet("USD", 0, trips.id);
    await archiveWalletGroup(user.id, trips.id);
    await expect(reconcile(t.id, 1)).rejects.toThrow("This wallet is in the archived group “Trips”.");
    expect(await adjustmentCategories()).toEqual([]);
  });

  it("treats another user's wallet like a missing one", async () => {
    const bob = await makeUser(db, "bob@example.com");
    const theirs = await createWallet(bob.id, { name: "Bob", currency: "EUR", initialBalanceMinor: 0 });
    await expect(reconcile(theirs.id, 500)).rejects.toMatchObject({ code: "NOT_FOUND", message: "Wallet not found." });
    await expect(reconcile(987_654, 500)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await getWalletBalanceOn(user.id, theirs.id, TODAY)).toBeNull();
    expect(await listWalletClosingBalances(user.id, theirs.id, TODAY)).toBeNull();
    expect((await listTransactions(bob.id)).total).toBe(0);
  });

  it("uses an archived Balance adjustment category as it is and leaves it archived", async () => {
    const existing = await createCategory(user.id, { name: "balance ADJUSTMENT", kind: "expense" });
    await archiveCategory(user.id, existing.id);
    const w = await wallet();
    const r = await reconcile(w.id, 99_000);
    expect(r).toMatchObject({ categoryCreated: false });
    expect(r.transaction).toMatchObject({ categoryId: existing.id, categoryName: "balance ADJUSTMENT" });
    const cats = (await listCategories(user.id, "expense", { includeArchived: true })).filter((c) => c.id === existing.id);
    expect(cats[0].archivedAt).not.toBeNull();
  });

  it("does not file under a same-named category of the other kind", async () => {
    const income = await createCategory(user.id, { name: BALANCE_ADJUSTMENT, kind: "income" });
    const w = await wallet();
    const r = await reconcile(w.id, 90_000);
    expect(r.categoryCreated).toBe(true);
    expect(r.transaction!.categoryId).not.toBe(income.id);
  });

  // PGlite has one connection, so this checks the outcome, not the row lock itself (see DECISIONS "Not verified").
  it("two submissions at once add the difference once", async () => {
    const w = await wallet();
    const [a, b] = await Promise.all([reconcile(w.id, 95_000), reconcile(w.id, 95_000)]);
    expect([a.differenceMinor, b.differenceMinor].sort()).toEqual([-5_000, 0]);
    expect((await getWallet(user.id, w.id, { balanceOn: TODAY }))!.balanceMinor).toBe(95_000);
  });
});

describe("listWalletClosingBalances and balanceOnDate", () => {
  it("give the tracked balance at the end of any day up to today", async () => {
    const w = await wallet("EUR", 1_000);
    await spend(w.id, 100, "2026-11-02");
    await spend(w.id, 200, "2026-11-02");
    await spend(w.id, 50, "2026-11-10");
    await spend(w.id, 999, "2026-11-30");
    const data = (await listWalletClosingBalances(user.id, w.id, TODAY))!;
    expect(data).toEqual({ initialBalanceMinor: 1_000, closings: [["2026-11-02", 700], ["2026-11-10", 650]] });
    const on = (d: string) => balanceOnDate(data.initialBalanceMinor, data.closings, d);
    expect(on("2026-11-01")).toBe(1_000);
    expect(on("2026-11-02")).toBe(700);
    expect(on("2026-11-09")).toBe(700);
    expect(on(TODAY)).toBe(650);
    for (const d of ["2026-11-01", "2026-11-02", "2026-11-09", TODAY]) {
      expect(on(d)).toBe(await getWalletBalanceOn(user.id, w.id, d));
    }
  });
});

describe("messages", () => {
  it("say what saving adds and what was added", () => {
    expect(adjustmentPreview(-1_240, "EUR")).toBe("This adds an expense of €12.40.");
    expect(adjustmentPreview(500, "JPY")).toBe("This adds income of ¥500.");
    expect(adjustmentPreview(0, "EUR")).toBe("The balance already matches. Nothing will be added.");
    expect(adjustmentResultMessage({ differenceMinor: -1_240, actualBalanceMinor: 96_760 }, TODAY, "EUR")).toBe(
      "Added an expense of €12.40 on 25 Nov 2026 in “Balance adjustment”. The balance on that day is now €967.60.",
    );
    expect(adjustmentResultMessage({ differenceMinor: 0, actualBalanceMinor: 1_234 }, TODAY, "KWD")).toBe(
      "The balance already matches KWD 1.234 on 25 Nov 2026. Nothing was added.",
    );
  });
});
