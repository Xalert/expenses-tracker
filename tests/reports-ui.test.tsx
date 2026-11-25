// The /reports page rendered to HTML on PGlite data: the empty year, the current year's future months, the currency
// and view switches, and the links out of the chart and the tables.
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ userId: 0, selected: null as null | { id: number; name: string } }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => ({ id: session.userId, timeZone: "Europe/Berlin" }) }));
vi.mock("@/lib/group-scope", () => ({
  getGroupScope: async () => ({ groups: [], archivedGroups: [], selected: session.selected }),
}));

import ReportsPage from "@/app/(app)/reports/page";
import { createTransaction } from "@/server/transactions";
import { createWalletGroup } from "@/server/wallet-groups";
import { createWallet } from "@/server/wallets";
import { makeUser, useFreshDb } from "./helpers";

type User = Awaited<ReturnType<typeof makeUser>>;
let alice: User;

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-25T12:00:00Z"));
  vi.stubEnv("EXCHANGE_RATES", "false");
});
afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
beforeEach(async () => {
  const db = await useFreshDb();
  alice = await makeUser(db, "alice@example.com");
  session.userId = alice.id;
  session.selected = null;
});

const wallet = async (currency = "EUR", groupId?: number) =>
  (await createWallet(alice.id, { name: `${currency} wallet`, currency, initialBalanceMinor: 0, groupId })).id;
const spend = (walletId: number, amountMinor: number, date: string, category = "Food") =>
  createTransaction(alice.id, { walletId, kind: "expense", categoryId: alice.cat(category), amountMinor, date });
const earn = (walletId: number, amountMinor: number, date: string) =>
  createTransaction(alice.id, { walletId, kind: "income", categoryId: alice.cat("Salary"), amountMinor, date });

async function render(params: Record<string, string> = {}): Promise<string> {
  return renderToStaticMarkup(await ReportsPage({ searchParams: Promise.resolve(params) }));
}

describe("/reports", () => {
  it("without wallets, offers to create one", async () => {
    const html = await render();
    expect(html).toContain("Create your first wallet");
    expect(html).not.toContain('role="img"');
  });

  it("shows an empty state for a year without entries, with the year stepper", async () => {
    const eur = await wallet();
    await spend(eur, 1000, "2026-03-01");
    const html = await render({ year: "2024" });
    expect(html).toContain("No entries in 2024");
    expect(html).not.toContain('role="img"');
    expect(html).not.toContain("Expenses by category");
    expect(html).toContain('href="/reports?year=2023"');
    expect(html).toContain('href="/reports?year=2025"');
    expect(html).toContain(">This year<");
  });

  it("the current year: same-period comparison, future months not yet happened and not linked, no next year", async () => {
    const eur = await wallet();
    await spend(eur, 1000, "2026-03-04");
    await earn(eur, 5000, "2026-03-31");
    await spend(eur, 400, "2025-03-10");
    const html = await render();
    expect(html).toContain("2026 so far, against the same period of 2025 (1 Jan – 25 Nov)");
    expect(html).toContain("vs €4.00 in 2025 · +150%");
    expect(html).toContain('role="img"');
    // January to November link to the Overview; December has not happened.
    expect(html).toContain('href="/?month=2026-03&amp;currency=EUR"');
    expect(html).toContain('href="/?currency=EUR"'); // November, the current month
    expect(html).not.toContain("month=2026-12");
    expect(html).toContain("December 2026: not yet");
    expect(html).toContain("December has not happened yet.");
    expect(html).not.toContain("Next year");
    expect(html).not.toContain(">This year<");
    // The tables: a cell, a row total and a month total link to the filtered list.
    expect(html).toContain(`href="/transactions?month=2026-03&amp;category=${alice.cat("Food")}&amp;currency=EUR"`);
    expect(html).toContain(`href="/transactions?category=${alice.cat("Food")}&amp;from=2026-01-01&amp;to=2026-12-31&amp;currency=EUR"`);
    expect(html).toContain('href="/transactions?month=2026-03&amp;kind=income&amp;currency=EUR"');
    expect(html).toContain('aria-label="Food, March 2026: €10.00"');
  });

  it("a past year compares with the whole previous year", async () => {
    const eur = await wallet();
    await spend(eur, 1000, "2025-03-04");
    const html = await render({ year: "2025" });
    expect(html).toContain("The whole of 2025, against 2024");
    expect(html).toContain("nothing in 2024");
    expect(html).toContain('href="/?month=2025-12&amp;currency=EUR"');
    expect(html).not.toContain("not yet");
    // A future year is clamped to the current one.
    expect(await render({ year: "2031" })).toContain("No entries in 2026");
  });

  it("one currency: no currency switch and no conversion switch", async () => {
    await spend(await wallet(), 1000, "2026-03-04");
    const html = await render();
    expect(html).not.toContain('aria-label="Currency"');
    expect(html).not.toContain("Currencies counted");
  });

  it("several currencies: both switches, All in by default, the conversion notes and the missing rate", async () => {
    await spend(await wallet(), 1000, "2026-03-04");
    await spend(await wallet("USD"), 2000, "2026-03-04");
    const html = await render({ currency: "EUR" });
    expect(html).toContain('aria-label="Currency"');
    expect(html).toContain("All in EUR");
    expect(html).toContain("Not included: wallets in USD");
    expect(html).toContain("Enter a rate for USD");
    // "EUR only" keeps view=only in the stepper and the links out.
    const only = await render({ currency: "EUR", view: "only" });
    expect(only).toContain('href="/reports?year=2025&amp;currency=EUR&amp;view=only"');
    expect(only).toContain("view=only");
    expect(only).not.toContain("Not included");
  });

  it("follows the selected wallet group", async () => {
    const work = await createWalletGroup(alice.id, { name: "Work" });
    await spend(await wallet(), 1000, "2026-03-04");
    await spend(await wallet("EUR", work.id), 300, "2026-04-04", "Transport");
    session.selected = { id: work.id, name: "Work" };
    const html = await render();
    expect(html).toContain("2026 · EUR · Work");
    expect(html).toContain("Transport");
    expect(html).not.toContain(">Food<");
  });
});
