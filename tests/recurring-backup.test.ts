// Repeating entries in the JSON backup: exported with their schedule and state, imported additively (an identical
// rule the account already has is skipped), and the entries keep their link to the rule.
import { beforeEach, describe, expect, it } from "vitest";
import type { DB } from "@/db";
import { listBudgets, setBudget } from "@/server/budgets";
import { buildBackup } from "@/server/export";
import { previewImport, runImport } from "@/server/import";
import { createRecurringEntry, listRecurring, pauseRecurring } from "@/server/recurring";
import { listTransactions } from "@/server/transactions";
import { createWallet } from "@/server/wallets";
import { makeUser, useFreshDb } from "./helpers";

const TODAY = "2026-11-25";
let db: DB;
let alice: Awaited<ReturnType<typeof makeUser>>;

beforeEach(async () => {
  db = await useFreshDb();
  alice = await makeUser(db, "alice@example.com");
  const bank = (await createWallet(alice.id, { name: "Bank", currency: "EUR", initialBalanceMinor: 0 })).id;
  await createRecurringEntry(
    alice.id,
    { kind: "expense", walletId: bank, categoryId: alice.cat("Housing"), amountMinor: 95_000, date: "2026-09-01", note: "rent" },
    { frequency: "monthly" },
    TODAY,
  );
  const gym = await createRecurringEntry(
    alice.id,
    { kind: "expense", walletId: bank, categoryId: alice.cat("Bills"), amountMinor: 3_000, date: "2026-11-03" },
    { frequency: "weekly", interval: 2, endDate: "2027-06-30" },
    TODAY,
  );
  await pauseRecurring(alice.id, gym.rule.id);
});

/** A rule without the account's own ids and timestamps, for comparing two accounts. */
const strip = (rules: Awaited<ReturnType<typeof listRecurring>>) =>
  rules.map((r) => {
    const rest: Partial<typeof r> = { ...r };
    delete rest.id;
    delete rest.walletId;
    delete rest.categoryId;
    delete rest.pausedAt;
    return { ...rest, paused: r.pausedAt !== null };
  });

describe("backup: repeating entries", () => {
  it("exports each rule with its schedule and state, and the entries' link", async () => {
    const backup = await buildBackup(alice.id);
    expect(backup.recurring).toEqual([
      {
        id: 1,
        walletId: 1,
        kind: "expense",
        category: "Housing",
        amountMinor: 95_000,
        amount: "950.00",
        note: "rent",
        frequency: "monthly",
        interval: 1,
        startDate: "2026-09-01",
        endDate: null,
        nextDate: "2026-12-01",
        paused: false,
      },
      expect.objectContaining({ id: 2, category: "Bills", frequency: "weekly", interval: 2, endDate: "2027-06-30", paused: true }),
    ]);
    expect(backup.transactions.map((t) => [t.date, t.recurringId])).toEqual([
      ["2026-09-01", 1],
      ["2026-10-01", 1],
      ["2026-11-01", 1],
      ["2026-11-03", 2],
      ["2026-11-17", 2],
    ]);
  });

  it("round-trips into another account: rules created as they were, entries linked to them", async () => {
    const bob = await makeUser(db, "bob@example.com");
    const file = JSON.stringify(await buildBackup(alice.id));
    expect(await previewImport(bob.id, file)).toMatchObject({ ok: true, recurringToAdd: 2, duplicateRecurring: 0 });
    expect(await runImport(bob.id, file)).toMatchObject({ imported: true, recurringToAdd: 2, transactionsToAdd: 5 });
    expect(strip(await listRecurring(bob.id))).toEqual(strip(await listRecurring(alice.id)));
    const bobRules = await listRecurring(bob.id);
    const { items } = await listTransactions(bob.id);
    const rent = bobRules.find((r) => r.categoryName === "Housing")!;
    expect(items.filter((t) => t.recurringId === rent.id).map((t) => t.date)).toEqual(["2026-11-01", "2026-10-01", "2026-09-01"]);
    expect(rent.entryCount).toBe(3);
  });

  it("importing into the same account adds nothing (identical rules skipped)", async () => {
    const file = JSON.stringify(await buildBackup(alice.id));
    const result = await runImport(alice.id, file);
    expect(result).toMatchObject({ imported: true, recurringToAdd: 0, duplicateRecurring: 2, transactionsToAdd: 0 });
    expect(await listRecurring(alice.id)).toHaveLength(2);
  });

  it("creates a category only a rule names, and reports bad rules", async () => {
    const bob = await makeUser(db, "bob@example.com");
    const backup = await buildBackup(alice.id);
    backup.recurring![0].category = "Rent";
    backup.transactions = backup.transactions.filter((t) => t.recurringId !== 1);
    const preview = await previewImport(bob.id, JSON.stringify(backup));
    expect(preview).toMatchObject({ ok: true, recurringToAdd: 2 });
    expect(preview.categoriesToCreate).toContainEqual({ name: "Rent", kind: "expense" });

    const bad = await buildBackup(alice.id);
    bad.recurring![0] = { ...bad.recurring![0], walletId: 9, interval: 0, endDate: "2026-08-01" };
    bad.transactions[0].recurringId = 7;
    const refused = await previewImport(bob.id, JSON.stringify(bad));
    expect(refused.ok).toBe(false);
    expect(refused.problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "recurring[0].walletId" }),
        expect.objectContaining({ path: "recurring[0].interval" }),
        expect.objectContaining({ path: "recurring[0].endDate" }),
        expect.objectContaining({ path: "transactions[0].recurringId", message: "No repeating entry with id 7 in this file." }),
      ]),
    );
  });

  it("a file without the list imports as before", async () => {
    const bob = await makeUser(db, "bob@example.com");
    const backup = await buildBackup(alice.id);
    delete backup.recurring;
    for (const t of backup.transactions) delete t.recurringId;
    expect(await runImport(bob.id, JSON.stringify(backup))).toMatchObject({ imported: true, recurringToAdd: 0 });
    expect(await listRecurring(bob.id)).toEqual([]);
    expect((await listTransactions(bob.id)).items.every((t) => t.recurringId === null)).toBe(true);
  });
});

describe("backup: repeating entries and budgets together", () => {
  it("round-trips both into another account, onto the same category", async () => {
    await setBudget(alice.id, { categoryId: alice.cat("Housing"), currency: "EUR", amountMinor: 120_000 });
    const bob = await makeUser(db, "bob@example.com");
    const result = await runImport(bob.id, JSON.stringify(await buildBackup(alice.id)));
    expect(result).toMatchObject({ imported: true, budgetsToAdd: 1, recurringToAdd: 2, transactionsToAdd: 5 });
    const [budget] = await listBudgets(bob.id);
    const rent = (await listRecurring(bob.id)).find((r) => r.categoryName === "Housing")!;
    expect(budget.categoryId).toBe(rent.categoryId);
  });
});
