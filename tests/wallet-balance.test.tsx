// One definition of a wallet's balance: the balance at the end of the user's today (`balanceOn`), future-dated
// entries left out (src/server/wallets.ts). The service, the "projected" hint, and /wallets, the wallet page and the
// Overview rendered to HTML on PGlite data, which must show the same number for the same wallet.
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const TODAY = "2026-11-25";
const session = vi.hoisted(() => ({ userId: 0 }));
vi.mock("@/lib/auth", () => {
  const user = async () => ({ id: session.userId, timeZone: "Europe/Berlin", displayName: "Alice" });
  return { requireUser: user, getCurrentUser: user };
});
vi.mock("@/lib/group-scope", () => ({
  getGroupScope: async () => ({ groups: [], archivedGroups: [], selected: null }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ back() {}, refresh() {}, push() {}, replace() {} }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
  notFound: () => {
    throw new Error("notFound");
  },
  redirect: (url: string) => {
    throw new Error(`redirect ${url}`);
  },
}));

import OverviewPage from "@/app/(app)/page";
import WalletPage from "@/app/(app)/wallets/[id]/page";
import WalletsPage from "@/app/(app)/wallets/page";
import { WalletsCard } from "@/components/dashboard/overview-lists";
import { projectedLabel, WalletGroup } from "@/components/wallets/wallet-cards";
import { ServiceError } from "@/lib/errors";
import { formatMoney } from "@/lib/money";
import { getDashboard } from "@/server/dashboard";
import { setManualRate } from "@/server/manual-rates";
import { createTransaction } from "@/server/transactions";
import { createTransfer } from "@/server/transfers";
import { archiveWallet, createWallet, getWallet, listWallets, type WalletWithBalance } from "@/server/wallets";
import { makeUser, useFreshDb } from "./helpers";

type User = Awaited<ReturnType<typeof makeUser>>;
let alice: User;
let bob: User;

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(`${TODAY}T12:00:00Z`));
  vi.stubEnv("EXCHANGE_RATES", "false");
});
afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
beforeEach(async () => {
  const db = await useFreshDb();
  alice = await makeUser(db, "alice@example.com");
  bob = await makeUser(db, "bob@example.com");
  session.userId = alice.id;
});

const spend = (walletId: number, amountMinor: number, date: string) =>
  createTransaction(alice.id, { walletId, kind: "expense", categoryId: alice.cat("Food"), amountMinor, date });
const earn = (walletId: number, amountMinor: number, date: string) =>
  createTransaction(alice.id, { walletId, kind: "income", categoryId: alice.cat("Salary"), amountMinor, date });

/**
 * Main (EUR) and Travel (USD) with past, today's and future-dated entries and transfers both ways.
 * Main today: 100 000 − 1 000 + 500 + 4 000 = 103 500; later: −2 000 − 30 000 − 10 000 → projected 61 500.
 * Travel today: 50 000 − 5 000 = 45 000; later: +11 000 → projected 56 000.
 */
async function seed() {
  const main = await createWallet(alice.id, { name: "Main", currency: "EUR", initialBalanceMinor: 100_000 });
  const travel = await createWallet(alice.id, { name: "Travel", currency: "USD", initialBalanceMinor: 50_000 });
  await spend(main.id, 1_000, "2026-11-10"); // past
  await earn(main.id, 500, TODAY); // today counts
  await spend(main.id, 2_000, "2026-11-28"); // later this month
  await spend(main.id, 30_000, "2026-12-05"); // next month
  // Past transfer into Main, future transfer out of Main.
  await createTransfer(alice.id, { fromWalletId: travel.id, toWalletId: main.id, amountMinor: 5_000, receivedAmountMinor: 4_000, date: "2026-11-01" });
  await createTransfer(alice.id, { fromWalletId: main.id, toWalletId: travel.id, amountMinor: 10_000, receivedAmountMinor: 11_000, date: "2026-11-30" });
  return { main: main.id, travel: travel.id };
}

describe("listWallets / getWallet with balanceOn", () => {
  it("count entries through the end of that day; later ones are only in laterChangeMinor", async () => {
    const { main, travel } = await seed();
    const ws = await listWallets(alice.id, { balanceOn: TODAY });
    const byName = Object.fromEntries(ws.map((w) => [w.name, w]));
    expect(byName.Main).toMatchObject({ balanceOn: TODAY, balanceMinor: 103_500, laterChangeMinor: -42_000, transactionCount: 6 });
    expect(byName.Travel).toMatchObject({ balanceOn: TODAY, balanceMinor: 45_000, laterChangeMinor: 11_000, transactionCount: 2 });
    expect(await getWallet(alice.id, main, { balanceOn: TODAY })).toMatchObject({ balanceMinor: 103_500, laterChangeMinor: -42_000 });
    expect(await getWallet(alice.id, travel, { balanceOn: TODAY })).toMatchObject({ balanceMinor: 45_000, laterChangeMinor: 11_000 });

    // Another day: the day before today leaves today's income out; a later day takes the entries up to it.
    expect((await getWallet(alice.id, main, { balanceOn: "2026-11-24" }))!.balanceMinor).toBe(103_000);
    expect((await getWallet(alice.id, main, { balanceOn: "2026-11-30" }))).toMatchObject({ balanceMinor: 91_500, laterChangeMinor: -30_000 });
    expect((await getWallet(alice.id, travel, { balanceOn: "2026-11-30" }))!.balanceMinor).toBe(56_000);
    expect((await getWallet(alice.id, main, { balanceOn: "2026-10-31" }))).toMatchObject({ balanceMinor: 100_000, laterChangeMinor: 3_500 - 42_000 });
  });

  it("without balanceOn carry no balance; a bad day is VALIDATION; another user's wallet is missing", async () => {
    const { main } = await seed();
    expect(await getWallet(alice.id, main)).not.toHaveProperty("balanceMinor");
    expect((await listWallets(alice.id))[0]).not.toHaveProperty("balanceMinor");
    await expect(listWallets(alice.id, { balanceOn: "2026-13-01" })).rejects.toThrow(ServiceError);
    await expect(getWallet(alice.id, main, { balanceOn: "soon" })).rejects.toThrow("Enter a valid date.");
    expect(await getWallet(bob.id, main, { balanceOn: TODAY })).toBeNull();
    expect(await listWallets(bob.id, { balanceOn: TODAY })).toEqual([]);
  });

  it("archived wallets get the same balance", async () => {
    const { main } = await seed();
    await archiveWallet(alice.id, main);
    const all = await listWallets(alice.id, { includeArchived: true, balanceOn: TODAY });
    expect(all.find((w) => w.id === main)).toMatchObject({ balanceMinor: 103_500, laterChangeMinor: -42_000 });
  });
});

describe("getDashboard", () => {
  it("gives the wallets and per-currency totals at the end of balanceOn", async () => {
    await seed();
    const now = await getDashboard(alice.id, { month: "2026-11", balanceOn: TODAY });
    expect(now.wallets.map((w) => [w.name, w.balanceMinor])).toEqual([["Main", 103_500], ["Travel", 45_000]]);
    expect(now.totalsByCurrency.map((t) => [t.currency, t.balanceMinor])).toEqual([["EUR", 103_500], ["USD", 45_000]]);
    // A past month: its last day.
    const oct = await getDashboard(alice.id, { month: "2026-10", balanceOn: "2026-10-31" });
    expect(oct.wallets.map((w) => w.balanceMinor)).toEqual([100_000, 50_000]);
    await expect(getDashboard(alice.id, { month: "2026-11", balanceOn: "" })).rejects.toThrow("Enter a valid date.");
  });
});

const view = (over: Partial<WalletWithBalance>): WalletWithBalance => ({
  id: 1,
  groupId: 1,
  groupName: "Personal",
  groupPosition: 1,
  groupArchived: false,
  name: "Main",
  currency: "EUR",
  initialBalanceMinor: 0,
  transactionCount: 3,
  archivedAt: null,
  createdAt: new Date(0),
  balanceOn: TODAY,
  balanceMinor: 103_500,
  laterChangeMinor: 0,
  ...over,
});

describe("the projected hint and the currency total on /wallets", () => {
  it("shows the projected balance only when later entries change it; the total sums today's balances", () => {
    expect(projectedLabel(view({}))).toBeNull();
    expect(projectedLabel(view({ laterChangeMinor: -42_000 }))).toBe("€615.00 projected after later entries");
    const html = renderToStaticMarkup(
      <WalletGroup
        currency="EUR"
        wallets={[view({ laterChangeMinor: -42_000 }), view({ id: 2, name: "Cash", balanceMinor: 1_000 })]}
        months={new Map()}
      />,
    );
    expect(html).toContain("€1,035.00");
    expect(html).toContain("€615.00 projected after later entries");
    expect(html).toContain("Total in EUR: </span>€1,045.00");
    expect(html.match(/projected/g)).toHaveLength(1);
  });

  it("the Overview card shows the same balance, without the hint", () => {
    const html = renderToStaticMarkup(
      <WalletsCard wallets={[view({ laterChangeMinor: -42_000 })]} changes={new Map()} hrefFor={() => "/"} changeLabel="this month" />,
    );
    expect(html).toContain("€1,035.00");
    expect(html).not.toContain("projected");
  });
});

describe("/wallets, the wallet page and the Overview agree", () => {
  const eur = (minor: number) => formatMoney(minor, "EUR");
  const usd = (minor: number) => formatMoney(minor, "USD");

  it("show today's balance for each wallet; /wallets and the wallet page explain the projected one", async () => {
    const { main, travel } = await seed();
    // 1 USD = 0.5 EUR: Travel's $450.00 is €225.00 in the Overview's converted total.
    await setManualRate(alice.id, { currency: "USD", base: "EUR", effectiveDate: "2026-01-01", rate: "0.5" });

    const wallets = renderToStaticMarkup(await WalletsPage());
    const mainPage = renderToStaticMarkup(
      await WalletPage({ params: Promise.resolve({ id: String(main) }), searchParams: Promise.resolve({}) }),
    );
    const travelPage = renderToStaticMarkup(
      await WalletPage({ params: Promise.resolve({ id: String(travel) }), searchParams: Promise.resolve({}) }),
    );
    const overview = renderToStaticMarkup(await OverviewPage({ searchParams: Promise.resolve({ currency: "EUR" }) }));

    for (const html of [wallets, mainPage, overview]) expect(html).toContain(eur(103_500));
    for (const html of [wallets, travelPage, overview]) expect(html).toContain(usd(45_000));
    // The counts of every entry (the old card balance) appear nowhere as a balance.
    for (const html of [wallets, mainPage, overview]) expect(html).not.toMatch(new RegExp(`Balance </span>${eur(61_500)}`));

    // The projected hint: /wallets (each card) and the wallet page, not the Overview.
    expect(wallets).toContain(`${eur(61_500)} projected after later entries`);
    expect(wallets).toContain(`${usd(56_000)} projected after later entries`);
    expect(mainPage).toContain(`${eur(61_500)} projected after the entries dated later`);
    expect(travelPage).toContain(`${usd(56_000)} projected after the entries dated later`);
    expect(overview).not.toContain("projected after");

    // The currency totals on /wallets and the Overview's converted total are sums of today's balances.
    expect(wallets).toContain(`Total in EUR: </span>${eur(103_500)}`);
    expect(wallets).toContain(`Total in USD: </span>${usd(45_000)}`);
    expect(overview).toMatch(new RegExp(`Total in EUR</span>.*?${eur(103_500 + 22_500).replace(/[.$]/g, "\\$&")}`));
  });

  it("a past month on the Overview still shows the balances at that month's end", async () => {
    await seed();
    const html = renderToStaticMarkup(
      await OverviewPage({ searchParams: Promise.resolve({ currency: "EUR", month: "2026-10" }) }),
    );
    expect(html).toContain("Balances at the end of 31 Oct 2026");
    expect(html).toContain(`, balance </span>${eur(100_000)}`);
    expect(html).toContain(`, balance </span>${usd(50_000)}`);
  });
});
