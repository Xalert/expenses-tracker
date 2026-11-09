import { beforeEach, describe, expect, it } from "vitest";
import type { DB } from "@/db";
import { ServiceError } from "@/lib/errors";
import type { DailyRates } from "@/lib/fx";
import { listCategoriesWithUsage } from "@/server/categories";
import { getDashboard } from "@/server/dashboard";
import { buildBackup, buildTransactionsCsv } from "@/server/export";
import { previewImport, runImport } from "@/server/import";
import { getMonthInsights, getMonthTimeline, listUserCurrencies, pickDefaultCurrency } from "@/server/insights";
import { createTransaction, listDayTotals, listTransactions } from "@/server/transactions";
import { createTransfer } from "@/server/transfers";
import { registerUser } from "@/server/users";
import {
  createWalletGroup,
  deleteWalletGroup,
  getDefaultGroupId,
  getWalletGroup,
  listWalletGroups,
  renameWalletGroup,
  seedDefaultGroup,
} from "@/server/wallet-groups";
import { archiveWallet, createWallet, getWallet, listWallets, updateWallet } from "@/server/wallets";
import { makeUser, useFreshDb } from "./helpers";

let db: DB;
let alice: Awaited<ReturnType<typeof makeUser>>;
let bob: Awaited<ReturnType<typeof makeUser>>;

beforeEach(async () => {
  db = await useFreshDb();
  alice = await makeUser(db, "alice@example.com");
  bob = await makeUser(db, "bob@example.com");
});

async function expectServiceError(fn: () => unknown, code: ServiceError["code"], field?: string): Promise<ServiceError> {
  try {
    await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe(code);
    if (field !== undefined) expect((err as ServiceError).field).toBe(field);
    return err as ServiceError;
  }
  throw new Error(`expected ServiceError ${code}`);
}

const MONTH = "2026-03";

/** Alice: Personal (default) with an EUR wallet; Business with an EUR and a USD wallet; some entries in each. */
async function setup() {
  const personal = await getDefaultGroupId(alice.id);
  const business = (await createWalletGroup(alice.id, { name: "Business" })).id;
  const home = await createWallet(alice.id, { name: "Home", currency: "EUR", initialBalanceMinor: 1000 });
  const shop = await createWallet(alice.id, { name: "Shop", currency: "EUR", initialBalanceMinor: 5000, groupId: business });
  const shopUsd = await createWallet(alice.id, { name: "Shop USD", currency: "USD", initialBalanceMinor: 0, groupId: business });
  const spend = async (walletId: number, amountMinor: number, date: string, category = "Food") =>
    await createTransaction(alice.id, { walletId, kind: "expense", categoryId: alice.cat(category), amountMinor, date });
  await spend(home.id, 1000, "2026-03-05");
  await spend(home.id, 200, "2026-03-06", "Bills");
  await spend(shop.id, 3000, "2026-03-05", "Bills");
  await spend(shopUsd.id, 700, "2026-03-07");
  await createTransaction(alice.id, { walletId: shop.id, kind: "income", categoryId: alice.cat("Salary"), amountMinor: 9000, date: "2026-03-08" });
  await createTransfer(alice.id, { fromWalletId: shop.id, toWalletId: home.id, amountMinor: 500, date: "2026-03-09" });
  return { personal, business, home, shop, shopUsd };
}

describe("wallet-groups service", () => {
  it("registration and makeUser give every user a Personal group", async () => {
    expect(await listWalletGroups(alice.id)).toMatchObject([{ name: "Personal", walletCount: 0 }]);
    const u = await registerUser({ username: "newbie", password: "long-enough-pw" });
    expect((await listWalletGroups(u.id)).map((g) => g.name)).toEqual(["Personal"]);
    await seedDefaultGroup(u.id); // idempotent
    expect(await listWalletGroups(u.id)).toHaveLength(1);
  });

  it("creates, lists (by name ignoring case, with wallet counts) and renames", async () => {
    await createWalletGroup(alice.id, { name: "  business   stuff " });
    await createWalletGroup(alice.id, { name: "Archive" });
    expect((await listWalletGroups(alice.id)).map((g) => g.name)).toEqual(["Archive", "business stuff", "Personal"]);
    const g = (await listWalletGroups(alice.id))[1];
    await createWallet(alice.id, { name: "W", currency: "EUR", initialBalanceMinor: 0, groupId: g.id });
    expect(await getWalletGroup(alice.id, g.id)).toMatchObject({ walletCount: 1, name: "business stuff" });

    expect((await renameWalletGroup(alice.id, g.id, { name: "Business" })).name).toBe("Business");
    expect((await renameWalletGroup(alice.id, g.id, { name: "BUSINESS" })).name).toBe("BUSINESS"); // own name, other case
  });

  it("validates names and keeps them unique per user ignoring case", async () => {
    await expectServiceError(async () => createWalletGroup(alice.id, { name: "   " }), "VALIDATION", "name");
    await expectServiceError(async () => createWalletGroup(alice.id, { name: "x".repeat(41) }), "VALIDATION", "name");
    await expectServiceError(async () => createWalletGroup(alice.id, { name: "personal" }), "CONFLICT", "name");
    const b = await createWalletGroup(alice.id, { name: "Business" });
    await expectServiceError(async () => renameWalletGroup(alice.id, b.id, { name: "PERSONAL" }), "CONFLICT", "name");
    // Another user may use the same name.
    expect((await createWalletGroup(bob.id, { name: "Business" })).name).toBe("Business");
  });

  it("treats another user's group as missing", async () => {
    const bobGroup = await getDefaultGroupId(bob.id);
    expect(await getWalletGroup(alice.id, bobGroup)).toBeNull();
    await expectServiceError(async () => renameWalletGroup(alice.id, bobGroup, { name: "Mine" }), "NOT_FOUND", "groupId");
    await expectServiceError(async () => deleteWalletGroup(alice.id, bobGroup), "NOT_FOUND", "groupId");
    await expectServiceError(
      async () => createWallet(alice.id, { name: "W", currency: "EUR", initialBalanceMinor: 0, groupId: bobGroup }),
      "NOT_FOUND",
      "groupId",
    );
    expect(await listWalletGroups(bob.id)).toHaveLength(1);
  });

  it("deletes only an empty group that is not the last one", async () => {
    const { personal, business, shop, shopUsd } = await setup();
    await expectServiceError(async () => deleteWalletGroup(alice.id, business), "CONFLICT", "groupId"); // has wallets
    await archiveWallet(alice.id, shop.id);
    await expectServiceError(async () => deleteWalletGroup(alice.id, business), "CONFLICT"); // archived ones count
    const empty = await createWalletGroup(alice.id, { name: "Empty" });
    await deleteWalletGroup(alice.id, empty.id);
    expect(await getWalletGroup(alice.id, empty.id)).toBeNull();
    void shopUsd;

    // The last group cannot go, even when empty.
    const solo = bob;
    await expectServiceError(async () => deleteWalletGroup(solo.id, await getDefaultGroupId(solo.id)), "CONFLICT", "groupId");
    expect(personal).toBe(await getDefaultGroupId(alice.id));
  });

  it("the default group is the oldest one", async () => {
    const first = await getDefaultGroupId(alice.id);
    await createWalletGroup(alice.id, { name: "Aaa" });
    expect(await getDefaultGroupId(alice.id)).toBe(first);
  });
});

describe("wallets and groups", () => {
  it("createWallet uses the default group unless one is given; views carry groupId and groupName", async () => {
    const { personal, business, home, shop } = await setup();
    expect(home).toMatchObject({ groupId: personal, groupName: "Personal" });
    expect(shop).toMatchObject({ groupId: business, groupName: "Business" });
    expect(await getWallet(alice.id, shop.id)).toMatchObject({ groupId: business, groupName: "Business" });
  });

  it("updateWallet moves a wallet with its history; omitted groupId leaves it", async () => {
    const { personal, business, shop } = await setup();
    expect((await updateWallet(alice.id, shop.id, { name: "Shop", initialBalanceMinor: 5000 })).groupId).toBe(business);
    const moved = await updateWallet(alice.id, shop.id, { name: "Shop", initialBalanceMinor: 5000, groupId: personal });
    expect(moved).toMatchObject({ groupId: personal, groupName: "Personal", transactionCount: moved.transactionCount });
    expect(moved.transactionCount).toBeGreaterThan(0);
    await expectServiceError(
      async () => updateWallet(alice.id, shop.id, { name: "Shop", initialBalanceMinor: 0, groupId: await getDefaultGroupId(bob.id) }),
      "NOT_FOUND",
      "groupId",
    );
    expect((await getWallet(alice.id, shop.id))!.balanceMinor).toBe(moved.balanceMinor);
  });

  it("listWallets narrows by group; another user's group is just empty", async () => {
    const { personal, business } = await setup();
    expect((await listWallets(alice.id)).map((w) => w.name).sort()).toEqual(["Home", "Shop", "Shop USD"]);
    expect((await listWallets(alice.id, { groupId: personal })).map((w) => w.name)).toEqual(["Home"]);
    expect((await listWallets(alice.id, { groupId: business })).map((w) => w.name)).toEqual(["Shop", "Shop USD"]);
    expect(await listWallets(alice.id, { groupId: await getDefaultGroupId(bob.id) })).toEqual([]);
  });

  it("archived wallets stay in their group when includeArchived", async () => {
    const { business, shop } = await setup();
    await archiveWallet(alice.id, shop.id);
    expect((await listWallets(alice.id, { groupId: business })).map((w) => w.name)).toEqual(["Shop USD"]);
    expect((await listWallets(alice.id, { groupId: business, includeArchived: true })).map((w) => w.name)).toEqual(["Shop USD", "Shop"]);
  });
});

describe("transactions, dashboard, categories and insights by group", () => {
  it("listTransactions / listDayTotals narrow by group; an explicit walletId wins", async () => {
    const { personal, business, home, shop } = await setup();
    const all = (await listTransactions(alice.id)).total;
    const biz = await listTransactions(alice.id, { groupId: business });
    const per = await listTransactions(alice.id, { groupId: personal });
    expect(biz.items.every((t) => ["Shop", "Shop USD"].includes(t.walletName))).toBe(true);
    // Every row is in exactly one group: the transfer's two legs sit in different ones.
    expect(biz.total + per.total).toBe(all);
    expect(biz.total).toBe(4);
    expect(per.items.map((t) => t.walletName)).toEqual(["Home", "Home", "Home"]);
    // walletId wins over groupId (wallet in another group).
    expect((await listTransactions(alice.id, { walletId: shop.id, groupId: personal })).items.every((t) => t.walletId === shop.id)).toBe(true);
    expect((await listTransactions(alice.id, { walletId: shop.id, groupId: personal })).total).toBe(
      (await listTransactions(alice.id, { walletId: shop.id })).total,
    );
    expect((await listTransactions(alice.id, { walletId: home.id, groupId: business })).total).toBe(3);
    expect((await listTransactions(alice.id, { groupId: await getDefaultGroupId(bob.id) })).total).toBe(0);
    await expectServiceError(async () => listTransactions(alice.id, { groupId: 0 }), "VALIDATION", "groupId");

    const totals = await listDayTotals(alice.id, { groupId: personal }, ["2026-03-05", "2026-03-09"]);
    expect(totals).toEqual([
      { date: "2026-03-09", currency: "EUR", netMinor: 500 },
      { date: "2026-03-05", currency: "EUR", netMinor: -1000 },
    ]);
  });

  it("getDashboard narrows wallets, totals, categories and recent entries", async () => {
    const { personal, business } = await setup();
    const d = await getDashboard(alice.id, { month: MONTH, groupId: personal });
    expect(d.wallets.map((w) => w.name)).toEqual(["Home"]);
    expect(d.totalsByCurrency).toEqual([{ currency: "EUR", balanceMinor: 1000 - 1200 + 500, incomeMinor: 0, expenseMinor: 1200 }]);
    expect(d.expenseByCategory.map((c) => c.categoryName).sort()).toEqual(["Bills", "Food"]);
    expect(d.recent.every((t) => t.walletName === "Home")).toBe(true);

    const b = await getDashboard(alice.id, { month: MONTH, groupId: business });
    expect(b.totalsByCurrency.map((t) => t.currency)).toEqual(["EUR", "USD"]);
    expect(b.totalsByCurrency[0]).toMatchObject({ incomeMinor: 9000, expenseMinor: 3000 });
    expect((await getDashboard(alice.id, { month: MONTH })).wallets).toHaveLength(3);
  });

  it("listCategoriesWithUsage counts only the group's wallets; the list itself is not narrowed", async () => {
    const { personal, business } = await setup();
    const usage = async (groupId?: number) =>
      Object.fromEntries(
        (await listCategoriesWithUsage(alice.id, { month: MONTH, currency: "EUR", groupId })).map((c) => [c.name, [c.transactionCount, c.monthAmountMinor]]),
      );
    expect(await usage()).toMatchObject({ Food: [2, 1000], Bills: [2, 3200] });
    expect(await usage(personal)).toMatchObject({ Food: [1, 1000], Bills: [1, 200], Salary: [0, 0] });
    expect(await usage(business)).toMatchObject({ Food: [1, 0], Bills: [1, 3000], Salary: [1, 9000] });
    const other = await listCategoriesWithUsage(alice.id, { groupId: await getDefaultGroupId(bob.id) });
    expect(other).toHaveLength((await listCategoriesWithUsage(alice.id)).length);
    expect(other.every((c) => c.transactionCount === 0)).toBe(true);
  });

  it("insights, currencies and the default currency narrow by group", async () => {
    const { personal, business, shopUsd } = await setup();
    expect(await listUserCurrencies(alice.id)).toEqual(["EUR", "USD"]);
    expect(await listUserCurrencies(alice.id, { groupId: personal })).toEqual(["EUR"]);
    expect(await listUserCurrencies(alice.id, { groupId: business })).toEqual(["EUR", "USD"]);
    expect(await listUserCurrencies(alice.id, { groupId: await getDefaultGroupId(bob.id) })).toEqual([]);

    expect(await pickDefaultCurrency(alice.id, MONTH, { groupId: personal })).toBe("EUR");
    expect(await pickDefaultCurrency(alice.id, MONTH, { groupId: await getDefaultGroupId(bob.id) })).toBeNull();

    const i = async (groupId?: number) => getMonthInsights(alice.id, { month: MONTH, currency: "EUR", groupId });
    expect(await i()).toMatchObject({ expenseMinor: 4200, incomeMinor: 9000 });
    expect(await i(personal)).toMatchObject({ expenseMinor: 1200, incomeMinor: 0, topCategory: { categoryName: "Food" } });
    expect(await i(business)).toMatchObject({ expenseMinor: 3000, incomeMinor: 9000, topCategory: { categoryName: "Bills" } });
    expect(await i(await getDefaultGroupId(bob.id))).toMatchObject({ expenseMinor: 0, incomeMinor: 0, topCategory: null });

    const t = async (groupId?: number) => getMonthTimeline(alice.id, { month: MONTH, currency: "EUR", groupId });
    const spent = (x: Awaited<ReturnType<typeof t>>) => x.days.reduce((s, d) => s + d.expenseMinor, 0);
    expect(spent(await t())).toBe(4200);
    expect(spent(await t(personal))).toBe(1200);
    expect((await t(personal)).largestDay).toMatchObject({ date: "2026-03-05", amountMinor: 1000 });
    // walletId wins over groupId.
    expect(spent(await getMonthTimeline(alice.id, { month: MONTH, currency: "USD", walletId: shopUsd.id, groupId: personal }))).toBe(700);
  });

  it("insights with convert are narrowed by group too", async () => {
    const { personal, business } = await setup();
    const rates: DailyRates = { base: "EUR", days: [{ date: "2026-03-06", rates: { USD: 2 } }] };
    const convert = { rates };
    const i = async (groupId?: number) => getMonthInsights(alice.id, { month: MONTH, currency: "EUR", groupId, convert });
    expect((await i(personal)).expenseMinor).toBe(1200);
    expect((await i(business)).expenseMinor).toBe(3000 + 350); // 700 USD at 2 USD per EUR
    expect((await i()).expenseMinor).toBe(1200 + 3350);
    const t = await getMonthTimeline(alice.id, { month: MONTH, currency: "EUR", groupId: personal, convert });
    expect(t.days.reduce((s, d) => s + d.expenseMinor, 0)).toBe(1200);
  });

  it("the CSV export is narrowed only by an explicit group", async () => {
    const { personal } = await setup();
    const rows = async (groupId?: number) => (await buildTransactionsCsv(alice.id, { groupId })).trim().split("\r\n").length - 1;
    expect(await rows()).toBe(6);
    expect(await rows(personal)).toBe(3); // two entries + the transfer (its incoming leg matches)
    expect(await buildTransactionsCsv(alice.id)).not.toMatch(/group/i);
  });
});

describe("import and backup with groups", () => {
  const csv = "date,type,wallet,currency,amount,category,note\n2026-03-01,expense,Brand new,EUR,5.00,Food,x\n";

  it("puts wallets created by an import into the target group, or the default one", async () => {
    const biz = await createWalletGroup(alice.id, { name: "Business" });
    const p = await previewImport(alice.id, csv, { groupId: biz.id });
    expect(p.walletsToCreate).toEqual([{ name: "Brand new", currency: "EUR", archived: false, group: "Business" }]);
    expect(p.groupsToCreate).toEqual([]);
    await runImport(alice.id, csv, { groupId: biz.id });
    expect((await listWallets(alice.id, { groupId: biz.id })).map((w) => w.name)).toEqual(["Brand new"]);

    await runImport(bob.id, csv);
    expect((await listWallets(bob.id))[0]).toMatchObject({ groupName: "Personal" });
  });

  it("validates the target group as owned", async () => {
    await expectServiceError(async () => previewImport(alice.id, csv, { groupId: await getDefaultGroupId(bob.id) }), "NOT_FOUND", "groupId");
    await expectServiceError(async () => runImport(alice.id, csv, { groupId: 99999 }), "NOT_FOUND", "groupId");
  });

  it("does not move an existing wallet", async () => {
    const biz = await createWalletGroup(alice.id, { name: "Business" });
    const w = await createWallet(alice.id, { name: "Brand new", currency: "EUR", initialBalanceMinor: 0 });
    const r = await runImport(alice.id, csv, { groupId: biz.id });
    expect(r).toMatchObject({ imported: true, walletsToCreate: [] });
    expect((await getWallet(alice.id, w.id))!.groupName).toBe("Personal");
  });

  it("the backup writes each wallet's group and a round trip restores them, creating missing groups", async () => {
    const { home, shop } = await setup();
    const backup = await buildBackup(alice.id);
    expect(backup.wallets.map((w) => w.group)).toEqual(["Personal", "Business", "Business"]);
    expect(backup.version).toBe(1);

    const text = JSON.stringify(backup);
    const p = await previewImport(bob.id, text);
    expect(p).toMatchObject({ ok: true, groupsToCreate: ["Business"] });
    expect(p.walletsToCreate.map((w) => w.group)).toEqual(["Personal", "Business", "Business"]);
    const r = await runImport(bob.id, text);
    expect(r.imported).toBe(true);
    const byName = Object.fromEntries((await listWallets(bob.id)).map((w) => [w.name, w.groupName]));
    expect(byName).toEqual({ Home: "Personal", Shop: "Business", "Shop USD": "Business" });
    expect((await listWalletGroups(bob.id)).map((g) => g.name)).toEqual(["Business", "Personal"]);
    // Same balances as the original.
    expect((await listWallets(bob.id)).find((w) => w.name === "Shop")!.balanceMinor).toBe((await getWallet(alice.id, shop.id))!.balanceMinor);
    expect((await listWallets(bob.id)).find((w) => w.name === "Home")!.balanceMinor).toBe((await getWallet(alice.id, home.id))!.balanceMinor);
  });

  it("matches group names ignoring case and falls back to the target group for a file without groups", async () => {
    const { shop } = await setup();
    const backup = JSON.parse(JSON.stringify(await buildBackup(alice.id)));
    await createWalletGroup(bob.id, { name: "BUSINESS" });
    const r = await runImport(bob.id, JSON.stringify(backup));
    expect(r.imported).toBe(true);
    expect((await listWalletGroups(bob.id)).map((g) => g.name)).toEqual(["BUSINESS", "Personal"]);
    expect((await listWallets(bob.id)).find((w) => w.name === "Shop")!.groupName).toBe("BUSINESS");

    // An old backup (no `group`) goes into the target group.
    for (const w of backup.wallets) delete w.group;
    const carol = await makeUser(db, "carol@example.com");
    const target = await createWalletGroup(carol.id, { name: "Target" });
    await runImport(carol.id, JSON.stringify(backup), { groupId: target.id });
    expect((await listWallets(carol.id)).every((w) => w.groupId === target.id)).toBe(true);
    void shop;
  });

  it("rejects a backup group name that is too long", async () => {
    await setup();
    const backup = JSON.parse(JSON.stringify(await buildBackup(alice.id)));
    backup.wallets[0].group = "x".repeat(41);
    const p = await previewImport(bob.id, JSON.stringify(backup));
    expect(p.ok).toBe(false);
    expect(p.problems[0].path).toBe("wallets[0].group");
  });
});
