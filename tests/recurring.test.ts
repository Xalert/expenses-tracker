import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { DB } from "@/db";
import { recurringTransactions, transactions } from "@/db/schema";
import { listBudgets, setBudget } from "@/server/budgets";
import { archiveCategory, changeCategoryKind, deleteCategory, unarchiveCategory } from "@/server/categories";
import {
  createRecurringEntry,
  deleteRecurring,
  getRecurring,
  listRecurring,
  materializeDueRecurring,
  pauseRecurring,
  resumeRecurring,
  updateRecurring,
} from "@/server/recurring";
import { deleteTransaction, listTransactions, updateTransaction } from "@/server/transactions";
import { archiveWalletGroup, createWalletGroup, unarchiveWalletGroup } from "@/server/wallet-groups";
import { archiveWallet, createWallet, deleteWallet, unarchiveWallet, updateWallet } from "@/server/wallets";
import { makeUser, useFreshDb } from "./helpers";

let db: DB;
let alice: Awaited<ReturnType<typeof makeUser>>;
let bank: number;

const TODAY = "2026-11-25";

beforeEach(async () => {
  db = await useFreshDb();
  alice = await makeUser(db, "alice@example.com");
  bank = (await createWallet(alice.id, { name: "Bank", currency: "EUR", initialBalanceMinor: 0 })).id;
});

function rent(date: string, extra: Partial<{ walletId: number; note: string }> = {}) {
  return {
    kind: "expense" as const,
    walletId: extra.walletId ?? bank,
    categoryId: alice.cat("Housing"),
    amountMinor: 95_000,
    date,
    note: extra.note ?? "rent",
  };
}

async function entriesOf(ruleId: number) {
  return db
    .select({ date: transactions.date, amountMinor: transactions.amountMinor, note: transactions.note })
    .from(transactions)
    .where(eq(transactions.recurringId, ruleId))
    .orderBy(transactions.date);
}

const datesOf = async (ruleId: number) => (await entriesOf(ruleId)).map((e) => e.date);

describe("createRecurringEntry", () => {
  it("creates the entry as the first occurrence and catches up to today", async () => {
    const r = await createRecurringEntry(alice.id, rent("2026-09-25"), { frequency: "monthly" }, TODAY);
    expect(r.added).toBe(2);
    expect(r.transaction).toMatchObject({ date: "2026-09-25", amountMinor: 95_000, recurringId: r.rule.id });
    expect(r.rule).toMatchObject({
      startDate: "2026-09-25",
      nextDate: "2026-12-25",
      status: "active",
      interval: 1,
      endDate: null,
      entryCount: 3,
      categoryName: "Housing",
      walletName: "Bank",
      currency: "EUR",
    });
    expect(await entriesOf(r.rule.id)).toEqual([
      { date: "2026-09-25", amountMinor: 95_000, note: "rent" },
      { date: "2026-10-25", amountMinor: 95_000, note: "rent" },
      { date: "2026-11-25", amountMinor: 95_000, note: "rent" },
    ]);
  });

  it("a future start makes only that entry", async () => {
    const r = await createRecurringEntry(alice.id, rent("2026-12-03"), { frequency: "weekly", interval: 2 }, TODAY);
    expect(r.added).toBe(0);
    expect(r.rule.nextDate).toBe("2026-12-17");
    expect(await datesOf(r.rule.id)).toEqual(["2026-12-03"]);
  });

  it("an end date before the next occurrence ends the rule at once", async () => {
    const r = await createRecurringEntry(
      alice.id,
      rent("2026-11-01"),
      { frequency: "monthly", endDate: "2026-11-20" },
      TODAY,
    );
    expect(r.rule).toMatchObject({ status: "ended", nextDate: null, endDate: "2026-11-20" });
  });

  it("validates the schedule and the entry, and writes nothing when refused", async () => {
    await expect(
      createRecurringEntry(alice.id, rent("2026-11-01"), { frequency: "hourly" as never }, TODAY),
    ).rejects.toMatchObject({ field: "frequency" });
    await expect(
      createRecurringEntry(alice.id, rent("2026-11-01"), { frequency: "daily", interval: 0 }, TODAY),
    ).rejects.toMatchObject({ field: "interval" });
    await expect(
      createRecurringEntry(alice.id, rent("2026-11-01"), { frequency: "daily", interval: 100 }, TODAY),
    ).rejects.toMatchObject({ field: "interval" });
    await expect(
      createRecurringEntry(alice.id, rent("2026-11-01"), { frequency: "daily", endDate: "2026-10-31" }, TODAY),
    ).rejects.toMatchObject({ field: "endDate" });
    await expect(
      createRecurringEntry(alice.id, { ...rent("2026-11-01"), categoryId: alice.cat("Salary") }, { frequency: "daily" }, TODAY),
    ).rejects.toMatchObject({ field: "categoryId" });
    expect(await listRecurring(alice.id)).toEqual([]);
    expect((await listTransactions(alice.id)).total).toBe(0);
  });

  it("is bounded per run; the next run continues", async () => {
    const r = await createRecurringEntry(alice.id, rent("2025-01-01"), { frequency: "daily" }, TODAY);
    // 2025-01-01 → 2026-11-25 is 693 days later: the first entry plus 300, then 300 more, then the last 93.
    expect(r.added).toBe(300);
    expect((await getRecurring(alice.id, r.rule.id))!.nextDate).toBe("2025-10-29");
    expect(await materializeDueRecurring(alice.id, TODAY)).toEqual({ created: 300, paused: 0 });
    expect(await materializeDueRecurring(alice.id, TODAY)).toEqual({ created: 93, paused: 0 });
    expect(await materializeDueRecurring(alice.id, TODAY)).toEqual({ created: 0, paused: 0 });
    const dates = await datesOf(r.rule.id);
    expect(dates).toHaveLength(694);
    expect(new Set(dates).size).toBe(694);
    expect(dates.at(-1)).toBe(TODAY);
  });
});

describe("materializeDueRecurring", () => {
  it("creates every missed occurrence on its own day after an absence, and nothing twice", async () => {
    const r = await createRecurringEntry(alice.id, rent("2026-01-31"), { frequency: "monthly" }, "2026-01-31");
    expect(await materializeDueRecurring(alice.id, "2026-01-31")).toEqual({ created: 0, paused: 0 });
    expect(await materializeDueRecurring(alice.id, "2026-05-30")).toEqual({ created: 3, paused: 0 });
    expect(await datesOf(r.rule.id)).toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]);
    expect(await materializeDueRecurring(alice.id, "2026-05-30")).toEqual({ created: 0, paused: 0 });
    expect((await getRecurring(alice.id, r.rule.id))!.nextDate).toBe("2026-05-31");
  });

  it("two runs at once create each entry once", async () => {
    const r = await createRecurringEntry(alice.id, rent("2026-11-01"), { frequency: "daily" }, "2026-11-01");
    const runs = await Promise.all([
      materializeDueRecurring(alice.id, TODAY),
      materializeDueRecurring(alice.id, TODAY),
      materializeDueRecurring(alice.id, TODAY),
    ]);
    expect(runs.reduce((n, x) => n + x.created, 0)).toBe(24);
    const dates = await datesOf(r.rule.id);
    expect(dates).toHaveLength(25);
    expect(new Set(dates).size).toBe(25);
  });

  it("stops at the end date", async () => {
    const r = await createRecurringEntry(
      alice.id,
      rent("2026-01-15"),
      { frequency: "monthly", endDate: "2026-03-15" },
      "2026-01-15",
    );
    await materializeDueRecurring(alice.id, TODAY);
    expect(await datesOf(r.rule.id)).toEqual(["2026-01-15", "2026-02-15", "2026-03-15"]);
    expect(await getRecurring(alice.id, r.rule.id)).toMatchObject({ status: "ended", nextDate: null });
  });

  it("only touches the given user's rules", async () => {
    const bob = await makeUser(db, "bob@example.com");
    const bobBank = (await createWallet(bob.id, { name: "Bank", currency: "EUR", initialBalanceMinor: 0 })).id;
    const b = await createRecurringEntry(
      bob.id,
      { kind: "income", walletId: bobBank, categoryId: bob.cat("Salary"), amountMinor: 1, date: "2026-11-01" },
      { frequency: "daily" },
      "2026-11-01",
    );
    await createRecurringEntry(alice.id, rent("2026-11-01"), { frequency: "daily" }, "2026-11-01");
    expect((await materializeDueRecurring(alice.id, TODAY)).created).toBe(24);
    expect(await datesOf(b.rule.id)).toEqual(["2026-11-01"]);
  });

  it("refuses a malformed today", async () => {
    await expect(materializeDueRecurring(alice.id, "2026-13-01")).rejects.toThrow("Invalid date");
  });
});

describe("pause and resume", () => {
  it("a paused rule creates nothing, and resuming does not backfill", async () => {
    const r = await createRecurringEntry(alice.id, rent("2026-06-10"), { frequency: "monthly" }, "2026-06-10");
    expect((await pauseRecurring(alice.id, r.rule.id)).status).toBe("paused");
    expect(await materializeDueRecurring(alice.id, TODAY)).toEqual({ created: 0, paused: 0 });
    const resumed = await resumeRecurring(alice.id, r.rule.id, TODAY);
    expect(resumed).toMatchObject({ status: "active", nextDate: "2026-12-10" });
    expect(await datesOf(r.rule.id)).toEqual(["2026-06-10"]);
  });

  it("resuming on an occurrence day creates that day's entry, once", async () => {
    const r = await createRecurringEntry(alice.id, rent("2026-06-25"), { frequency: "monthly" }, "2026-06-25");
    await pauseRecurring(alice.id, r.rule.id);
    await resumeRecurring(alice.id, r.rule.id, TODAY);
    expect(await datesOf(r.rule.id)).toEqual(["2026-06-25", "2026-11-25"]);
    // Paused again on the same day and resumed: today's entry already exists.
    await pauseRecurring(alice.id, r.rule.id);
    await resumeRecurring(alice.id, r.rule.id, TODAY);
    expect(await datesOf(r.rule.id)).toEqual(["2026-06-25", "2026-11-25"]);
    expect((await getRecurring(alice.id, r.rule.id))!.nextDate).toBe("2026-12-25");
  });

  it("pause and resume are idempotent; an ended rule stays ended", async () => {
    const r = await createRecurringEntry(alice.id, rent("2026-11-01"), { frequency: "monthly", endDate: "2026-11-01" }, TODAY);
    expect((await pauseRecurring(alice.id, r.rule.id)).status).toBe("ended");
    const active = await createRecurringEntry(alice.id, rent("2026-11-02"), { frequency: "monthly" }, TODAY);
    expect((await resumeRecurring(alice.id, active.rule.id, TODAY)).status).toBe("active");
    const p1 = await pauseRecurring(alice.id, active.rule.id);
    const p2 = await pauseRecurring(alice.id, active.rule.id);
    expect(p2.pausedAt).toEqual(p1.pausedAt);
  });
});

describe("archived wallet, group or category", () => {
  it("an archived wallet pauses the rule when an occurrence falls due, with the reason", async () => {
    const r = await createRecurringEntry(alice.id, rent("2026-10-25"), { frequency: "monthly" }, "2026-10-25");
    await archiveWallet(alice.id, bank);
    expect(await materializeDueRecurring(alice.id, TODAY)).toEqual({ created: 0, paused: 1 });
    expect(await getRecurring(alice.id, r.rule.id)).toMatchObject({
      status: "paused",
      blockedBy: "The wallet “Bank” is archived.",
      nextDate: "2026-11-25",
    });
    await expect(resumeRecurring(alice.id, r.rule.id, TODAY)).rejects.toThrow("The wallet “Bank” is archived.");
    await unarchiveWallet(alice.id, bank);
    // Still paused after unarchiving: the user resumes by hand.
    expect(await materializeDueRecurring(alice.id, TODAY)).toEqual({ created: 0, paused: 0 });
    expect((await resumeRecurring(alice.id, r.rule.id, TODAY)).nextDate).toBe("2026-12-25");
    expect(await datesOf(r.rule.id)).toEqual(["2026-10-25", "2026-11-25"]);
  });

  it("a wallet in an archived group, and an archived category, pause it too", async () => {
    const business = await createWalletGroup(alice.id, { name: "Business" });
    const till = (await createWallet(alice.id, { name: "Till", currency: "EUR", initialBalanceMinor: 0, groupId: business.id })).id;
    const a = await createRecurringEntry(alice.id, rent("2026-10-25", { walletId: till }), { frequency: "monthly" }, "2026-10-25");
    const b = await createRecurringEntry(
      alice.id,
      { ...rent("2026-10-25"), categoryId: alice.cat("Bills") },
      { frequency: "monthly" },
      "2026-10-25",
    );
    await archiveWalletGroup(alice.id, business.id);
    await archiveCategory(alice.id, alice.cat("Bills"));
    expect(await materializeDueRecurring(alice.id, TODAY)).toEqual({ created: 0, paused: 2 });
    expect((await getRecurring(alice.id, a.rule.id))!.blockedBy).toBe("The wallet “Till” is in the archived group “Business”.");
    expect((await getRecurring(alice.id, b.rule.id))!.blockedBy).toBe("The category “Bills” is archived.");
    await unarchiveWalletGroup(alice.id, business.id);
    await unarchiveCategory(alice.id, alice.cat("Bills"));
    expect((await getRecurring(alice.id, a.rule.id))!).toMatchObject({ status: "paused", blockedBy: null });
  });

  it("archiving alone does nothing until an occurrence is due", async () => {
    const r = await createRecurringEntry(alice.id, rent("2026-11-25"), { frequency: "monthly" }, TODAY);
    await archiveWallet(alice.id, bank);
    expect(await materializeDueRecurring(alice.id, TODAY)).toEqual({ created: 0, paused: 0 });
    expect((await getRecurring(alice.id, r.rule.id))!.status).toBe("active");
  });
});

describe("updateRecurring", () => {
  const base = (over: Partial<Parameters<typeof updateRecurring>[2]> = {}) => ({
    walletId: bank,
    categoryId: alice.cat("Housing"),
    amountMinor: 99_000,
    note: "new rent",
    frequency: "monthly" as const,
    interval: 1,
    nextDate: "2026-12-31",
    endDate: null,
    ...over,
  });

  it("changes only future entries and keeps the 31st anchor when the schedule is unchanged", async () => {
    const r = await createRecurringEntry(alice.id, rent("2026-10-31"), { frequency: "monthly" }, "2026-11-30");
    expect(r.rule.nextDate).toBe("2026-12-31");
    const updated = await updateRecurring(alice.id, r.rule.id, base(), "2026-11-30");
    expect(updated).toMatchObject({ startDate: "2026-10-31", nextDate: "2026-12-31", amountMinor: 99_000, note: "new rent" });
    await materializeDueRecurring(alice.id, "2027-03-31");
    expect(await entriesOf(r.rule.id)).toEqual([
      { date: "2026-10-31", amountMinor: 95_000, note: "rent" },
      { date: "2026-11-30", amountMinor: 95_000, note: "rent" },
      { date: "2026-12-31", amountMinor: 99_000, note: "new rent" },
      { date: "2027-01-31", amountMinor: 99_000, note: "new rent" },
      { date: "2027-02-28", amountMinor: 99_000, note: "new rent" },
      { date: "2027-03-31", amountMinor: 99_000, note: "new rent" },
    ]);
  });

  it("a new schedule or next date restarts from the next date, which must not be in the past", async () => {
    const r = await createRecurringEntry(alice.id, rent("2026-10-31"), { frequency: "monthly" }, TODAY);
    await expect(updateRecurring(alice.id, r.rule.id, base({ nextDate: "2026-11-24" }), TODAY)).rejects.toMatchObject({
      field: "nextDate",
    });
    const weekly = await updateRecurring(alice.id, r.rule.id, base({ frequency: "weekly", nextDate: "2026-12-02" }), TODAY);
    expect(weekly).toMatchObject({ startDate: "2026-12-02", nextDate: "2026-12-02" });
    // Next date today: today's entry is made at once.
    const today = await updateRecurring(alice.id, r.rule.id, base({ frequency: "weekly", nextDate: TODAY }), TODAY);
    expect(today).toMatchObject({ startDate: TODAY, nextDate: "2026-12-02" });
    expect(await datesOf(r.rule.id)).toEqual(["2026-10-31", "2026-11-25"]);
  });

  it("an end date before the next date ends it; one before the anchor is refused", async () => {
    const r = await createRecurringEntry(alice.id, rent("2026-10-31"), { frequency: "monthly" }, TODAY);
    const ended = await updateRecurring(alice.id, r.rule.id, base({ nextDate: "2026-11-30", endDate: TODAY }), TODAY);
    expect(ended).toMatchObject({ status: "ended", startDate: "2026-10-31", nextDate: null });
    await expect(updateRecurring(alice.id, r.rule.id, base({ nextDate: "2026-12-31", endDate: "2026-10-01" }), TODAY)).rejects.toMatchObject(
      { field: "endDate" },
    );
  });

  it("keeps the kind, and follows the wallet / category rules", async () => {
    const r = await createRecurringEntry(alice.id, rent("2026-10-31"), { frequency: "monthly" }, TODAY);
    await expect(updateRecurring(alice.id, r.rule.id, base({ categoryId: alice.cat("Salary") }), TODAY)).rejects.toMatchObject({
      field: "categoryId",
    });
    const old = (await createWallet(alice.id, { name: "Old", currency: "EUR", initialBalanceMinor: 0 })).id;
    await archiveWallet(alice.id, old);
    await expect(updateRecurring(alice.id, r.rule.id, base({ walletId: old }), TODAY)).rejects.toMatchObject({ field: "walletId" });
    await expect(updateRecurring(alice.id, r.rule.id, base({ interval: 0 }), TODAY)).rejects.toMatchObject({ field: "interval" });
    // An archived wallet the rule already uses may stay.
    await archiveWallet(alice.id, bank);
    expect((await updateRecurring(alice.id, r.rule.id, base(), TODAY)).walletId).toBe(bank);
  });

  it("an ended rule needs a next date to continue", async () => {
    const r = await createRecurringEntry(alice.id, rent("2026-11-01"), { frequency: "monthly", endDate: "2026-11-01" }, TODAY);
    await expect(updateRecurring(alice.id, r.rule.id, base({ nextDate: "" }), TODAY)).rejects.toMatchObject({ field: "nextDate" });
    const revived = await updateRecurring(alice.id, r.rule.id, base({ nextDate: "2026-12-01" }), TODAY);
    expect(revived).toMatchObject({ status: "active", startDate: "2026-12-01", nextDate: "2026-12-01", endDate: null });
  });
});

describe("entries and deletion", () => {
  it("editing or deleting a created entry leaves the rule alone", async () => {
    const r = await createRecurringEntry(alice.id, rent("2026-09-25"), { frequency: "monthly" }, TODAY);
    const [first, second] = (await listTransactions(alice.id, { from: "2026-09-01" })).items.reverse();
    await updateTransaction(alice.id, first.id, { ...rent("2026-09-26"), amountMinor: 1 });
    await deleteTransaction(alice.id, second.id);
    expect(await getRecurring(alice.id, r.rule.id)).toMatchObject({ amountMinor: 95_000, nextDate: "2026-12-25", entryCount: 2 });
    expect(await materializeDueRecurring(alice.id, TODAY)).toEqual({ created: 0, paused: 0 });
  });

  it("deleting the rule keeps its entries, unlinked", async () => {
    const r = await createRecurringEntry(alice.id, rent("2026-09-25"), { frequency: "monthly" }, TODAY);
    await deleteRecurring(alice.id, r.rule.id);
    expect(await getRecurring(alice.id, r.rule.id)).toBeNull();
    const { items } = await listTransactions(alice.id);
    expect(items).toHaveLength(3);
    expect(items.every((t) => t.recurringId === null)).toBe(true);
    await expect(deleteRecurring(alice.id, r.rule.id)).rejects.toThrow("not found");
  });

  it("a wallet without entries takes its rules with it", async () => {
    const r = await createRecurringEntry(alice.id, rent("2026-11-25"), { frequency: "monthly" }, TODAY);
    await deleteTransaction(alice.id, r.transaction.id);
    await deleteWallet(alice.id, bank);
    expect(await listRecurring(alice.id)).toEqual([]);
  });

  it("another user's rule behaves like a missing one", async () => {
    const r = await createRecurringEntry(alice.id, rent("2026-11-25"), { frequency: "monthly" }, TODAY);
    const bob = await makeUser(db, "bob@example.com");
    expect(await getRecurring(bob.id, r.rule.id)).toBeNull();
    expect(await listRecurring(bob.id)).toEqual([]);
    await expect(pauseRecurring(bob.id, r.rule.id)).rejects.toThrow("not found");
    await expect(resumeRecurring(bob.id, r.rule.id, TODAY)).rejects.toThrow("not found");
    await expect(deleteRecurring(bob.id, r.rule.id)).rejects.toThrow("not found");
    await expect(
      updateRecurring(
        bob.id,
        r.rule.id,
        { walletId: bank, categoryId: alice.cat("Housing"), amountMinor: 1, frequency: "monthly", interval: 1, nextDate: "2026-12-25" },
        TODAY,
      ),
    ).rejects.toThrow("not found");
    await expect(
      createRecurringEntry(bob.id, rent("2026-11-25"), { frequency: "monthly" }, TODAY),
    ).rejects.toMatchObject({ code: "NOT_FOUND", field: "walletId" });
    expect((await getRecurring(alice.id, r.rule.id))!.status).toBe("active");
  });

  it("lists active rules by next date, then paused, then ended", async () => {
    const a = await createRecurringEntry(alice.id, rent("2026-11-20"), { frequency: "monthly" }, TODAY);
    const b = await createRecurringEntry(alice.id, rent("2026-11-03"), { frequency: "monthly" }, TODAY);
    const c = await createRecurringEntry(alice.id, rent("2026-11-01"), { frequency: "monthly", endDate: "2026-11-01" }, TODAY);
    const d = await createRecurringEntry(alice.id, rent("2026-11-02"), { frequency: "monthly" }, TODAY);
    await pauseRecurring(alice.id, d.rule.id);
    expect((await listRecurring(alice.id)).map((r) => r.id)).toEqual([b.rule.id, a.rule.id, d.rule.id, c.rule.id]);
  });
});

describe("categories and rules", () => {
  it("a rule counts as use for the kind change, even without entries", async () => {
    const r = await createRecurringEntry(alice.id, rent("2026-11-25"), { frequency: "monthly" }, TODAY);
    await deleteTransaction(alice.id, r.transaction.id);
    await expect(changeCategoryKind(alice.id, alice.cat("Housing"), { kind: "income" })).rejects.toThrow(
      "“Housing” is used by 1 repeating entry",
    );
  });

  it("removing a category moves its rules with its entries, in one go", async () => {
    const r = await createRecurringEntry(alice.id, rent("2026-10-25"), { frequency: "monthly" }, TODAY);
    await expect(deleteCategory(alice.id, alice.cat("Housing"))).rejects.toThrow(
      "“Housing” is used by 2 transactions and 1 repeating entry. Choose a category to move them to.",
    );
    const result = await deleteCategory(alice.id, alice.cat("Housing"), { moveToCategoryId: alice.cat("Bills") });
    expect(result).toMatchObject({ movedTransactions: 2, movedRecurring: 1 });
    expect((await getRecurring(alice.id, r.rule.id))!.categoryId).toBe(alice.cat("Bills"));
    await materializeDueRecurring(alice.id, "2026-12-25");
    const [rows] = await db
      .select({ categoryId: transactions.categoryId })
      .from(transactions)
      .where(and(eq(transactions.recurringId, r.rule.id), eq(transactions.date, "2026-12-25")));
    expect(rows.categoryId).toBe(alice.cat("Bills"));
  });

  it("a category used only by a rule needs a replacement too (into a new one)", async () => {
    const r = await createRecurringEntry(alice.id, rent("2026-11-25"), { frequency: "monthly" }, TODAY);
    await deleteTransaction(alice.id, r.transaction.id);
    const result = await deleteCategory(alice.id, alice.cat("Housing"), { moveToNewCategoryName: "Home" });
    expect(result).toMatchObject({ movedTransactions: 0, movedRecurring: 1, movedTo: { name: "Home" } });
    expect((await getRecurring(alice.id, r.rule.id))!.categoryName).toBe("Home");
  });

  it("moving a wallet to another group or renaming it keeps its rules", async () => {
    const r = await createRecurringEntry(alice.id, rent("2026-11-25"), { frequency: "monthly" }, TODAY);
    await updateWallet(alice.id, bank, { name: "Main", initialBalanceMinor: 0 });
    expect((await getRecurring(alice.id, r.rule.id))!.walletName).toBe("Main");
    const rows = await db.select().from(recurringTransactions);
    expect(rows).toHaveLength(1);
  });
});

describe("rules and budgets together", () => {
  it("a rule blocks the kind change, so the category's budget stays", async () => {
    await setBudget(alice.id, { categoryId: alice.cat("Housing"), currency: "EUR", amountMinor: 100_000 });
    const r = await createRecurringEntry(alice.id, rent("2026-11-25"), { frequency: "monthly" }, TODAY);
    await deleteTransaction(alice.id, r.transaction.id);
    await expect(changeCategoryKind(alice.id, alice.cat("Housing"), { kind: "income" })).rejects.toThrow("1 repeating entry");
    expect((await listBudgets(alice.id)).map((b) => b.categoryId)).toEqual([alice.cat("Housing")]);
  });

  it("removing a category moves its rules to the replacement; its budget goes with it", async () => {
    await setBudget(alice.id, { categoryId: alice.cat("Housing"), currency: "EUR", amountMinor: 100_000 });
    const r = await createRecurringEntry(alice.id, rent("2026-11-25"), { frequency: "monthly" }, TODAY);
    await deleteCategory(alice.id, alice.cat("Housing"), { moveToCategoryId: alice.cat("Bills") });
    expect((await getRecurring(alice.id, r.rule.id))!.categoryId).toBe(alice.cat("Bills"));
    expect(await listBudgets(alice.id)).toEqual([]);
  });
});
