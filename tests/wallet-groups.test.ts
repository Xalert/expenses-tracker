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
let alice: ReturnType<typeof makeUser>;
let bob: ReturnType<typeof makeUser>;

beforeEach(() => {
  db = useFreshDb();
  alice = makeUser(db, "alice@example.com");
  bob = makeUser(db, "bob@example.com");
});

function expectServiceError(fn: () => unknown, code: ServiceError["code"], field?: string): ServiceError {
  try {
    fn();
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
function setup() {
  const personal = getDefaultGroupId(alice.id);
  const business = createWalletGroup(alice.id, { name: "Business" }).id;
  const home = createWallet(alice.id, { name: "Home", currency: "EUR", initialBalanceMinor: 1000 });
  const shop = createWallet(alice.id, { name: "Shop", currency: "EUR", initialBalanceMinor: 5000, groupId: business });
  const shopUsd = createWallet(alice.id, { name: "Shop USD", currency: "USD", initialBalanceMinor: 0, groupId: business });
  const spend = (walletId: number, amountMinor: number, date: string, category = "Food") =>
    createTransaction(alice.id, { walletId, kind: "expense", categoryId: alice.cat(category), amountMinor, date });
  spend(home.id, 1000, "2026-03-05");
  spend(home.id, 200, "2026-03-06", "Bills");
  spend(shop.id, 3000, "2026-03-05", "Bills");
  spend(shopUsd.id, 700, "2026-03-07");
  createTransaction(alice.id, { walletId: shop.id, kind: "income", categoryId: alice.cat("Salary"), amountMinor: 9000, date: "2026-03-08" });
  createTransfer(alice.id, { fromWalletId: shop.id, toWalletId: home.id, amountMinor: 500, date: "2026-03-09" });
  return { personal, business, home, shop, shopUsd };
}

describe("wallet-groups service", () => {
  it("registration and makeUser give every user a Personal group", async () => {
    expect(listWalletGroups(alice.id)).toMatchObject([{ name: "Personal", walletCount: 0 }]);
    const u = await registerUser({ username: "newbie", password: "long-enough-pw" });
    expect(listWalletGroups(u.id).map((g) => g.name)).toEqual(["Personal"]);
    seedDefaultGroup(u.id); // idempotent
    expect(listWalletGroups(u.id)).toHaveLength(1);
  });

  it("creates, lists (by name ignoring case, with wallet counts) and renames", () => {
    createWalletGroup(alice.id, { name: "  business   stuff " });
    createWalletGroup(alice.id, { name: "Archive" });
    expect(listWalletGroups(alice.id).map((g) => g.name)).toEqual(["Archive", "business stuff", "Personal"]);
    const g = listWalletGroups(alice.id)[1];
    createWallet(alice.id, { name: "W", currency: "EUR", initialBalanceMinor: 0, groupId: g.id });
    expect(getWalletGroup(alice.id, g.id)).toMatchObject({ walletCount: 1, name: "business stuff" });

    expect(renameWalletGroup(alice.id, g.id, { name: "Business" }).name).toBe("Business");
    expect(renameWalletGroup(alice.id, g.id, { name: "BUSINESS" }).name).toBe("BUSINESS"); // own name, other case
  });

  it("validates names and keeps them unique per user ignoring case", () => {
    expectServiceError(() => createWalletGroup(alice.id, { name: "   " }), "VALIDATION", "name");
    expectServiceError(() => createWalletGroup(alice.id, { name: "x".repeat(41) }), "VALIDATION", "name");
    expectServiceError(() => createWalletGroup(alice.id, { name: "personal" }), "CONFLICT", "name");
    const b = createWalletGroup(alice.id, { name: "Business" });
    expectServiceError(() => renameWalletGroup(alice.id, b.id, { name: "PERSONAL" }), "CONFLICT", "name");
    // Another user may use the same name.
    expect(createWalletGroup(bob.id, { name: "Business" }).name).toBe("Business");
  });

  it("treats another user's group as missing", () => {
    const bobGroup = getDefaultGroupId(bob.id);
    expect(getWalletGroup(alice.id, bobGroup)).toBeNull();
    expectServiceError(() => renameWalletGroup(alice.id, bobGroup, { name: "Mine" }), "NOT_FOUND", "groupId");
    expectServiceError(() => deleteWalletGroup(alice.id, bobGroup), "NOT_FOUND", "groupId");
    expectServiceError(
      () => createWallet(alice.id, { name: "W", currency: "EUR", initialBalanceMinor: 0, groupId: bobGroup }),
      "NOT_FOUND",
      "groupId",
    );
    expect(listWalletGroups(bob.id)).toHaveLength(1);
  });

  it("deletes only an empty group that is not the last one", () => {
    const { personal, business, shop, shopUsd } = setup();
    expectServiceError(() => deleteWalletGroup(alice.id, business), "CONFLICT", "groupId"); // has wallets
    archiveWallet(alice.id, shop.id);
    expectServiceError(() => deleteWalletGroup(alice.id, business), "CONFLICT"); // archived ones count
    const empty = createWalletGroup(alice.id, { name: "Empty" });
    deleteWalletGroup(alice.id, empty.id);
    expect(getWalletGroup(alice.id, empty.id)).toBeNull();
    void shopUsd;

    // The last group cannot go, even when empty.
    const solo = bob;
    expectServiceError(() => deleteWalletGroup(solo.id, getDefaultGroupId(solo.id)), "CONFLICT", "groupId");
    expect(personal).toBe(getDefaultGroupId(alice.id));
  });

  it("the default group is the oldest one", () => {
    const first = getDefaultGroupId(alice.id);
    createWalletGroup(alice.id, { name: "Aaa" });
    expect(getDefaultGroupId(alice.id)).toBe(first);
  });
});

describe("wallets and groups", () => {
  it("createWallet uses the default group unless one is given; views carry groupId and groupName", () => {
    const { personal, business, home, shop } = setup();
    expect(home).toMatchObject({ groupId: personal, groupName: "Personal" });
    expect(shop).toMatchObject({ groupId: business, groupName: "Business" });
    expect(getWallet(alice.id, shop.id)).toMatchObject({ groupId: business, groupName: "Business" });
  });

  it("updateWallet moves a wallet with its history; omitted groupId leaves it", () => {
    const { personal, business, shop } = setup();
    expect(updateWallet(alice.id, shop.id, { name: "Shop", initialBalanceMinor: 5000 }).groupId).toBe(business);
    const moved = updateWallet(alice.id, shop.id, { name: "Shop", initialBalanceMinor: 5000, groupId: personal });
    expect(moved).toMatchObject({ groupId: personal, groupName: "Personal", transactionCount: moved.transactionCount });
    expect(moved.transactionCount).toBeGreaterThan(0);
    expectServiceError(
      () => updateWallet(alice.id, shop.id, { name: "Shop", initialBalanceMinor: 0, groupId: getDefaultGroupId(bob.id) }),
      "NOT_FOUND",
      "groupId",
    );
    expect(getWallet(alice.id, shop.id)!.balanceMinor).toBe(moved.balanceMinor);
  });

  it("listWallets narrows by group; another user's group is just empty", () => {
    const { personal, business } = setup();
    expect(listWallets(alice.id).map((w) => w.name).sort()).toEqual(["Home", "Shop", "Shop USD"]);
    expect(listWallets(alice.id, { groupId: personal }).map((w) => w.name)).toEqual(["Home"]);
    expect(listWallets(alice.id, { groupId: business }).map((w) => w.name)).toEqual(["Shop", "Shop USD"]);
    expect(listWallets(alice.id, { groupId: getDefaultGroupId(bob.id) })).toEqual([]);
  });

  it("archived wallets stay in their group when includeArchived", () => {
    const { business, shop } = setup();
    archiveWallet(alice.id, shop.id);
    expect(listWallets(alice.id, { groupId: business }).map((w) => w.name)).toEqual(["Shop USD"]);
    expect(listWallets(alice.id, { groupId: business, includeArchived: true }).map((w) => w.name)).toEqual(["Shop USD", "Shop"]);
  });
});

describe("transactions, dashboard, categories and insights by group", () => {
  it("listTransactions / listDayTotals narrow by group; an explicit walletId wins", () => {
    const { personal, business, home, shop } = setup();
    const all = listTransactions(alice.id).total;
    const biz = listTransactions(alice.id, { groupId: business });
    const per = listTransactions(alice.id, { groupId: personal });
    expect(biz.items.every((t) => ["Shop", "Shop USD"].includes(t.walletName))).toBe(true);
    // Every row is in exactly one group: the transfer's two legs sit in different ones.
    expect(biz.total + per.total).toBe(all);
    expect(biz.total).toBe(4);
    expect(per.items.map((t) => t.walletName)).toEqual(["Home", "Home", "Home"]);
    // walletId wins over groupId (wallet in another group).
    expect(listTransactions(alice.id, { walletId: shop.id, groupId: personal }).items.every((t) => t.walletId === shop.id)).toBe(true);
    expect(listTransactions(alice.id, { walletId: shop.id, groupId: personal }).total).toBe(
      listTransactions(alice.id, { walletId: shop.id }).total,
    );
    expect(listTransactions(alice.id, { walletId: home.id, groupId: business }).total).toBe(3);
    expect(listTransactions(alice.id, { groupId: getDefaultGroupId(bob.id) }).total).toBe(0);
    expectServiceError(() => listTransactions(alice.id, { groupId: 0 }), "VALIDATION", "groupId");

    const totals = listDayTotals(alice.id, { groupId: personal }, ["2026-03-05", "2026-03-09"]);
    expect(totals).toEqual([
      { date: "2026-03-09", currency: "EUR", netMinor: 500 },
      { date: "2026-03-05", currency: "EUR", netMinor: -1000 },
    ]);
  });

  it("getDashboard narrows wallets, totals, categories and recent entries", () => {
    const { personal, business } = setup();
    const d = getDashboard(alice.id, { month: MONTH, groupId: personal });
    expect(d.wallets.map((w) => w.name)).toEqual(["Home"]);
    expect(d.totalsByCurrency).toEqual([{ currency: "EUR", balanceMinor: 1000 - 1200 + 500, incomeMinor: 0, expenseMinor: 1200 }]);
    expect(d.expenseByCategory.map((c) => c.categoryName).sort()).toEqual(["Bills", "Food"]);
    expect(d.recent.every((t) => t.walletName === "Home")).toBe(true);

    const b = getDashboard(alice.id, { month: MONTH, groupId: business });
    expect(b.totalsByCurrency.map((t) => t.currency)).toEqual(["EUR", "USD"]);
    expect(b.totalsByCurrency[0]).toMatchObject({ incomeMinor: 9000, expenseMinor: 3000 });
    expect(getDashboard(alice.id, { month: MONTH }).wallets).toHaveLength(3);
  });

  it("listCategoriesWithUsage counts only the group's wallets; the list itself is not narrowed", () => {
    const { personal, business } = setup();
    const usage = (groupId?: number) =>
      Object.fromEntries(
        listCategoriesWithUsage(alice.id, { month: MONTH, currency: "EUR", groupId }).map((c) => [c.name, [c.transactionCount, c.monthAmountMinor]]),
      );
    expect(usage()).toMatchObject({ Food: [2, 1000], Bills: [2, 3200] });
    expect(usage(personal)).toMatchObject({ Food: [1, 1000], Bills: [1, 200], Salary: [0, 0] });
    expect(usage(business)).toMatchObject({ Food: [1, 0], Bills: [1, 3000], Salary: [1, 9000] });
    const other = listCategoriesWithUsage(alice.id, { groupId: getDefaultGroupId(bob.id) });
    expect(other).toHaveLength(listCategoriesWithUsage(alice.id).length);
    expect(other.every((c) => c.transactionCount === 0)).toBe(true);
  });

  it("insights, currencies and the default currency narrow by group", () => {
    const { personal, business, shopUsd } = setup();
    expect(listUserCurrencies(alice.id)).toEqual(["EUR", "USD"]);
    expect(listUserCurrencies(alice.id, { groupId: personal })).toEqual(["EUR"]);
    expect(listUserCurrencies(alice.id, { groupId: business })).toEqual(["EUR", "USD"]);
    expect(listUserCurrencies(alice.id, { groupId: getDefaultGroupId(bob.id) })).toEqual([]);

    expect(pickDefaultCurrency(alice.id, MONTH, { groupId: personal })).toBe("EUR");
    expect(pickDefaultCurrency(alice.id, MONTH, { groupId: getDefaultGroupId(bob.id) })).toBeNull();

    const i = (groupId?: number) => getMonthInsights(alice.id, { month: MONTH, currency: "EUR", groupId });
    expect(i()).toMatchObject({ expenseMinor: 4200, incomeMinor: 9000 });
    expect(i(personal)).toMatchObject({ expenseMinor: 1200, incomeMinor: 0, topCategory: { categoryName: "Food" } });
    expect(i(business)).toMatchObject({ expenseMinor: 3000, incomeMinor: 9000, topCategory: { categoryName: "Bills" } });
    expect(i(getDefaultGroupId(bob.id))).toMatchObject({ expenseMinor: 0, incomeMinor: 0, topCategory: null });

    const t = (groupId?: number) => getMonthTimeline(alice.id, { month: MONTH, currency: "EUR", groupId });
    const spent = (x: ReturnType<typeof t>) => x.days.reduce((s, d) => s + d.expenseMinor, 0);
    expect(spent(t())).toBe(4200);
    expect(spent(t(personal))).toBe(1200);
    expect(t(personal).largestDay).toMatchObject({ date: "2026-03-05", amountMinor: 1000 });
    // walletId wins over groupId.
    expect(spent(getMonthTimeline(alice.id, { month: MONTH, currency: "USD", walletId: shopUsd.id, groupId: personal }))).toBe(700);
  });

  it("insights with convert are narrowed by group too", () => {
    const { personal, business } = setup();
    const rates: DailyRates = { base: "EUR", days: [{ date: "2026-03-06", rates: { USD: 2 } }] };
    const convert = { rates };
    const i = (groupId?: number) => getMonthInsights(alice.id, { month: MONTH, currency: "EUR", groupId, convert });
    expect(i(personal).expenseMinor).toBe(1200);
    expect(i(business).expenseMinor).toBe(3000 + 350); // 700 USD at 2 USD per EUR
    expect(i().expenseMinor).toBe(1200 + 3350);
    const t = getMonthTimeline(alice.id, { month: MONTH, currency: "EUR", groupId: personal, convert });
    expect(t.days.reduce((s, d) => s + d.expenseMinor, 0)).toBe(1200);
  });

  it("the CSV export is narrowed only by an explicit group", () => {
    const { personal } = setup();
    const rows = (groupId?: number) => buildTransactionsCsv(alice.id, { groupId }).trim().split("\r\n").length - 1;
    expect(rows()).toBe(6);
    expect(rows(personal)).toBe(3); // two entries + the transfer (its incoming leg matches)
    expect(buildTransactionsCsv(alice.id)).not.toMatch(/group/i);
  });
});

describe("import and backup with groups", () => {
  const csv = "date,type,wallet,currency,amount,category,note\n2026-03-01,expense,Brand new,EUR,5.00,Food,x\n";

  it("puts wallets created by an import into the target group, or the default one", () => {
    const biz = createWalletGroup(alice.id, { name: "Business" });
    const p = previewImport(alice.id, csv, { groupId: biz.id });
    expect(p.walletsToCreate).toEqual([{ name: "Brand new", currency: "EUR", archived: false, group: "Business" }]);
    expect(p.groupsToCreate).toEqual([]);
    runImport(alice.id, csv, { groupId: biz.id });
    expect(listWallets(alice.id, { groupId: biz.id }).map((w) => w.name)).toEqual(["Brand new"]);

    runImport(bob.id, csv);
    expect(listWallets(bob.id)[0]).toMatchObject({ groupName: "Personal" });
  });

  it("validates the target group as owned", () => {
    expectServiceError(() => previewImport(alice.id, csv, { groupId: getDefaultGroupId(bob.id) }), "NOT_FOUND", "groupId");
    expectServiceError(() => runImport(alice.id, csv, { groupId: 99999 }), "NOT_FOUND", "groupId");
  });

  it("does not move an existing wallet", () => {
    const biz = createWalletGroup(alice.id, { name: "Business" });
    const w = createWallet(alice.id, { name: "Brand new", currency: "EUR", initialBalanceMinor: 0 });
    const r = runImport(alice.id, csv, { groupId: biz.id });
    expect(r).toMatchObject({ imported: true, walletsToCreate: [] });
    expect(getWallet(alice.id, w.id)!.groupName).toBe("Personal");
  });

  it("the backup writes each wallet's group and a round trip restores them, creating missing groups", () => {
    const { home, shop } = setup();
    const backup = buildBackup(alice.id);
    expect(backup.wallets.map((w) => w.group)).toEqual(["Personal", "Business", "Business"]);
    expect(backup.version).toBe(1);

    const text = JSON.stringify(backup);
    const p = previewImport(bob.id, text);
    expect(p).toMatchObject({ ok: true, groupsToCreate: ["Business"] });
    expect(p.walletsToCreate.map((w) => w.group)).toEqual(["Personal", "Business", "Business"]);
    const r = runImport(bob.id, text);
    expect(r.imported).toBe(true);
    const byName = Object.fromEntries(listWallets(bob.id).map((w) => [w.name, w.groupName]));
    expect(byName).toEqual({ Home: "Personal", Shop: "Business", "Shop USD": "Business" });
    expect(listWalletGroups(bob.id).map((g) => g.name)).toEqual(["Business", "Personal"]);
    // Same balances as the original.
    expect(listWallets(bob.id).find((w) => w.name === "Shop")!.balanceMinor).toBe(getWallet(alice.id, shop.id)!.balanceMinor);
    expect(listWallets(bob.id).find((w) => w.name === "Home")!.balanceMinor).toBe(getWallet(alice.id, home.id)!.balanceMinor);
  });

  it("matches group names ignoring case and falls back to the target group for a file without groups", () => {
    const { shop } = setup();
    const backup = JSON.parse(JSON.stringify(buildBackup(alice.id)));
    createWalletGroup(bob.id, { name: "BUSINESS" });
    const r = runImport(bob.id, JSON.stringify(backup));
    expect(r.imported).toBe(true);
    expect(listWalletGroups(bob.id).map((g) => g.name)).toEqual(["BUSINESS", "Personal"]);
    expect(listWallets(bob.id).find((w) => w.name === "Shop")!.groupName).toBe("BUSINESS");

    // An old backup (no `group`) goes into the target group.
    for (const w of backup.wallets) delete w.group;
    const carol = makeUser(db, "carol@example.com");
    const target = createWalletGroup(carol.id, { name: "Target" });
    runImport(carol.id, JSON.stringify(backup), { groupId: target.id });
    expect(listWallets(carol.id).every((w) => w.groupId === target.id)).toBe(true);
    void shop;
  });

  it("rejects a backup group name that is too long", () => {
    setup();
    const backup = JSON.parse(JSON.stringify(buildBackup(alice.id)));
    backup.wallets[0].group = "x".repeat(41);
    const p = previewImport(bob.id, JSON.stringify(backup));
    expect(p.ok).toBe(false);
    expect(p.problems[0].path).toBe("wallets[0].group");
  });
});
