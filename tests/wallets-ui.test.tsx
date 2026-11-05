import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { parseCreateWallet, parseUpdateWallet, parseWalletId } from "@/app/(app)/wallets/form-input";
import { CategorySpending } from "@/components/dashboard/category-spending";
import { CurrencyTotals } from "@/components/dashboard/currency-totals";
import { MonthSwitcher } from "@/components/dashboard/month-switcher";
import { groupSpendingByCurrency } from "@/components/dashboard/spending";

function fd(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.append(k, v);
  return f;
}

function create(entries: Record<string, string>) {
  return parseCreateWallet(fd(entries), entries);
}

describe("parseCreateWallet", () => {
  it("parses amounts against the chosen currency's decimals", () => {
    expect(create({ name: " Trip ", currency: "jpy", initialBalance: "1 500" })).toEqual({
      ok: true,
      data: { name: "Trip", currency: "JPY", initialBalanceMinor: 1500 },
    });
    expect(create({ name: "K", currency: "KWD", initialBalance: "1.234" })).toMatchObject({
      ok: true,
      data: { initialBalanceMinor: 1234 },
    });
    expect(create({ name: "Card", currency: "EUR", initialBalance: "-1.234,56" })).toMatchObject({
      ok: true,
      data: { initialBalanceMinor: -123456 },
    });
    expect(create({ name: "Empty", currency: "EUR", initialBalance: "" })).toMatchObject({
      ok: true,
      data: { initialBalanceMinor: 0 },
    });
  });

  it("rejects too many decimals for the currency on the initialBalance field", () => {
    const jpy = create({ name: "Trip", currency: "JPY", initialBalance: "10.5" });
    expect(jpy.ok).toBe(false);
    if (!jpy.ok) expect(jpy.state.fieldErrors?.initialBalance).toMatch(/whole amount in JPY/);
    const kwd = create({ name: "K", currency: "KWD", initialBalance: "1.2345" });
    if (!kwd.ok) expect(kwd.state.fieldErrors?.initialBalance).toMatch(/up to 3 decimals/);
    else throw new Error("expected failure");
  });

  it("reports every field error at once and echoes values", () => {
    const r = create({ name: "  ", currency: "EUR", initialBalance: "abc" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.state.fieldErrors).toMatchObject({ name: "Enter a name.", initialBalance: expect.any(String) });
    expect(r.state.values).toMatchObject({ initialBalance: "abc" });

    const bad = create({ name: "X", currency: "XYZ1", initialBalance: "1" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.state.fieldErrors?.currency).toBe("Choose a currency.");
      expect(bad.state.fieldErrors?.initialBalance).toBeUndefined();
    }
    const missing = parseCreateWallet(fd({ name: "X" }), {});
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.state.fieldErrors?.currency).toBe("Choose a currency.");
  });
});

describe("parseUpdateWallet", () => {
  it("uses the wallet's currency", () => {
    expect(parseUpdateWallet(fd({ name: "A", initialBalance: "-7" }), {}, "JPY")).toEqual({
      ok: true,
      data: { name: "A", initialBalanceMinor: -7 },
    });
    const r = parseUpdateWallet(fd({ name: "", initialBalance: "1.5" }), {}, "JPY");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.state.fieldErrors ?? {}).sort()).toEqual(["initialBalance", "name"]);
  });
});

describe("parseWalletId", () => {
  it("accepts only positive integers", () => {
    expect(parseWalletId("12")).toBe(12);
    expect(parseWalletId(3)).toBe(3);
    for (const v of ["0", "-1", "1.5", "abc", "", 0, 1.5, undefined, "99999999999999999999"]) {
      expect(parseWalletId(v)).toBeNull();
    }
  });
});

describe("dashboard components", () => {
  const spend = [
    { currency: "USD", categoryId: 1, categoryName: "Food", amountMinor: 500 },
    { currency: "EUR", categoryId: 1, categoryName: "Food", amountMinor: 3000 },
    { currency: "EUR", categoryId: 2, categoryName: "Bills", amountMinor: 1000 },
  ];

  it("groups spending per currency without mixing totals", () => {
    const groups = groupSpendingByCurrency(spend);
    expect(groups.map((g) => [g.currency, g.totalMinor])).toEqual([
      ["EUR", 4000],
      ["USD", 500],
    ]);
    expect(groups[0].rows.map((r) => [r.categoryName, r.barPercent, r.sharePercent])).toEqual([
      ["Food", 100, 75],
      ["Bills", 33, 25],
    ]);
  });

  it("renders bars and per-currency totals", () => {
    const html = renderToStaticMarkup(<CategorySpending items={spend} emptyMessage="none" />);
    expect(html).toContain("€40.00");
    expect(html).toContain("$5.00");
    expect(html).toContain("width:33%");
    expect(renderToStaticMarkup(<CategorySpending items={[]} emptyMessage="Nothing here" />)).toContain("Nothing here");

    const totals = renderToStaticMarkup(
      <CurrencyTotals totals={[{ currency: "JPY", balanceMinor: 30000, incomeMinor: 0, expenseMinor: 4500 }]} />,
    );
    expect(totals).toContain("¥30,000");
    expect(totals).toContain("¥4,500");
    expect(totals).toContain("-¥4,500");
  });

  it("month switcher links to the previous month and stops at the max month", () => {
    const current = renderToStaticMarkup(<MonthSwitcher month="2026-11" maxMonth="2026-11" />);
    expect(current).toContain('href="/?month=2026-10"');
    expect(current).not.toContain("2026-12");
    const past = renderToStaticMarkup(<MonthSwitcher month="2026-01" maxMonth="2026-11" />);
    expect(past).toContain('href="/?month=2025-12"');
    expect(past).toContain('href="/?month=2026-02"');
    expect(renderToStaticMarkup(<MonthSwitcher month="2026-10" maxMonth="2026-11" />)).toContain('href="/"');
  });
});
