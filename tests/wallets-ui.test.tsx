import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { chosenCurrency, parseCreateWallet, parseUpdateWallet, parseWalletId } from "@/app/(app)/wallets/form-input";
import { linePoints } from "@/components/charts";
import { MonthSwitcher } from "@/components/dashboard/month-switcher";
import { DayList } from "@/components/transactions/day-list";
import { BalanceSparkline } from "@/components/wallets/wallet-cards";
import { WalletForm } from "@/components/wallets/wallet-form";
import { nextMenuIndex } from "@/components/wallets/wallet-menu";
import { balanceAfterLabel } from "@/lib/day-labels";
import { balanceRange, changeLabel, entryCountLabel, isFlat, sparklinePoints, walletBars } from "@/lib/wallet-chart";
import type { TransactionView } from "@/server/transactions";

vi.mock("next/navigation", () => ({ useRouter: () => ({ back() {}, refresh() {}, push() {} }) }));

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
  it("month switcher links to the previous month and stops at the max month", () => {
    const current = renderToStaticMarkup(<MonthSwitcher month="2026-11" maxMonth="2026-11" />);
    expect(current).toContain('href="/?month=2026-10"');
    expect(current).not.toContain("2026-12");
    const past = renderToStaticMarkup(<MonthSwitcher month="2026-01" maxMonth="2026-11" />);
    expect(past).toContain('href="/?month=2025-12"');
    expect(past).toContain('href="/?month=2026-02"');
    expect(renderToStaticMarkup(<MonthSwitcher month="2026-10" maxMonth="2026-11" />)).toContain('href="/"');
  });

  it("month switcher keeps extra parameters on every link", () => {
    const html = renderToStaticMarkup(
      <MonthSwitcher month="2026-10" maxMonth="2026-11" extraParams={{ currency: "RON" }} />,
    );
    expect(html).toContain('href="/?month=2026-09&amp;currency=RON"');
    expect(html).toContain('href="/?currency=RON"');
    expect(html).not.toContain('href="/"');
  });
});

describe("chosenCurrency (pills + typed code, both named currency)", () => {
  it("a filled typed code wins over the pill; an empty one falls back to the pill", () => {
    expect(chosenCurrency(["EUR", "chf"])).toBe("CHF");
    expect(chosenCurrency(["EUR", ""])).toBe("EUR");
    expect(chosenCurrency(["EUR", "   "])).toBe("EUR");
    expect(chosenCurrency([" gbp "])).toBe("GBP");
    expect(chosenCurrency([""])).toBe("");
    expect(chosenCurrency([])).toBe("");
  });

  it("parseCreateWallet validates and echoes the chosen value", () => {
    const f = new FormData();
    f.append("name", "Zurich");
    f.append("currency", "EUR");
    f.append("currency", "chf");
    f.append("initialBalance", "10");
    expect(parseCreateWallet(f, {})).toEqual({ ok: true, data: { name: "Zurich", currency: "CHF", initialBalanceMinor: 1000 } });
    const bad = new FormData();
    bad.append("name", "X");
    bad.append("currency", "EUR");
    bad.append("currency", "ZZ");
    const r = parseCreateWallet(bad, { name: "X", currency: "ZZ" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.state.fieldErrors?.currency).toBe("Choose a currency.");
      expect(r.state.values?.currency).toBe("ZZ");
    }
  });
});

describe("wallet chart helpers", () => {
  it("balanceRange pads the month's range, and centres a flat month", () => {
    expect(balanceRange(1000, [1200, 800, 900])).toEqual({ min: 740, max: 1260 });
    expect(balanceRange(-500, [-700])).toEqual({ min: -730, max: -470 });
    expect(balanceRange(5000, [5000, 5000])).toEqual({ min: 4500, max: 5500 });
    expect(balanceRange(0, [])).toEqual({ min: -100, max: 100 });
  });

  it("isFlat is true only when no day moved the balance", () => {
    expect(isFlat(100, [100, 100])).toBe(true);
    expect(isFlat(100, [])).toBe(true);
    expect(isFlat(100, [100, 90, 100])).toBe(false);
  });

  it("sparklinePoints starts at the opening balance and spreads the days over the width", () => {
    expect(sparklinePoints(100, [200, 0, 100], { width: 120, height: 40, pad: 0 })).toBe("0,20 40,0 80,40 120,20");
    // flat: a straight line through the middle
    expect(sparklinePoints(50, [50, 50])).toBe("0,20 60,20 120,20");
    // no days yet (the 1st before any entry): a single point
    expect(sparklinePoints(50, [])).toBe("0,20");
  });

  it("linePoints takes a minimum and a start value (the balance line)", () => {
    expect(linePoints([100, 300], 300, 2, 100, 200)).toBe("0,100 10,200 30,0");
    // the Overview's defaults are unchanged
    expect(linePoints([0, 100, 200], 200, 3)).toBe("0,200 10,200 30,100 50,0");
    // clamped to the box
    expect(linePoints([-50, 500], 300, 2, 0, 0)).toBe("0,200 10,200 30,0");
  });

  it("walletBars stacks out under in, leaves days after N as future stubs and caps one huge day", () => {
    const days = [
      { date: "2026-11-01", inMinor: 0, outMinor: 1000, closingMinor: 9000 },
      { date: "2026-11-02", inMinor: 500, outMinor: 1000, closingMinor: 8500 },
      { date: "2026-11-03", inMinor: 0, outMinor: 0, closingMinor: 8500 },
      { date: "2026-11-04", inMinor: 300000, outMinor: 0, closingMinor: 308500 },
      { date: "2026-11-05", inMinor: 0, outMinor: 1200, closingMinor: 307300 },
    ];
    const { bars, max, cap } = walletBars("2026-11", days, "EUR");
    expect(bars).toHaveLength(30);
    expect(bars[0]).toEqual({ date: "2026-11-01", value: 1000, tone: "accent", base: undefined });
    expect(bars[1]).toEqual({ date: "2026-11-02", value: 1500, tone: "income", base: { value: 1000, tone: "accent" } });
    expect(bars[2]).toMatchObject({ value: 0 });
    expect(bars[3]).toMatchObject({ value: 300000, tone: "income" });
    expect(bars[5]).toEqual({ date: "2026-11-06", value: 0, tone: "future" });
    expect(cap).toEqual({ date: "2026-11-04", label: "In €3,000.00" });
    expect(max).toBeCloseTo((1500 * 1.2) / 0.6);
  });

  it("labels: the month change, entry counts and the day header's balance after", () => {
    expect(changeLabel(289090, "EUR")).toBe("+€2,890.90 this month");
    expect(changeLabel(-1200, "EUR")).toBe("-€12.00 this month");
    expect(changeLabel(0, "EUR")).toBe("No change this month");
    expect(entryCountLabel(0)).toBe("No entries yet");
    expect(entryCountLabel(1)).toBe("1 entry");
    expect(entryCountLabel(27)).toBe("27 entries");
    expect(balanceAfterLabel(123456, "EUR")).toBe("Balance after €1,234.56");
    expect(balanceAfterLabel(-1500, "JPY")).toBe("Balance after -¥1,500");
  });

  it("the card sparkline is muted when nothing changed and coloured by the change otherwise", () => {
    const flat = renderToStaticMarkup(<BalanceSparkline month={{ openingMinor: 100, changeMinor: 0, closings: [100, 100] }} />);
    expect(flat).toContain("text-border-strong");
    expect(flat).toContain('aria-hidden="true"');
    const up = renderToStaticMarkup(<BalanceSparkline month={{ openingMinor: 100, changeMinor: 50, closings: [150] }} />);
    expect(up).toContain("text-income");
    const down = renderToStaticMarkup(<BalanceSparkline month={{ openingMinor: 100, changeMinor: -50, closings: [50] }} />);
    expect(down).toContain("text-expense");
  });

  it("the ⋯ menu's arrow keys wrap around; Home / End jump", () => {
    expect(nextMenuIndex("ArrowDown", -1, 3)).toBe(0);
    expect(nextMenuIndex("ArrowDown", 2, 3)).toBe(0);
    expect(nextMenuIndex("ArrowUp", 0, 3)).toBe(2);
    expect(nextMenuIndex("Home", 2, 3)).toBe(0);
    expect(nextMenuIndex("End", 0, 3)).toBe(2);
    expect(nextMenuIndex("a", 0, 3)).toBeNull();
    expect(nextMenuIndex("ArrowDown", 0, 0)).toBeNull();
  });
});

describe("DayList on a wallet page", () => {
  const t = (id: number, date: string, note: string | null): TransactionView => ({
    id,
    kind: "expense",
    walletId: 1,
    walletName: "ING",
    currency: "EUR",
    categoryId: 10,
    categoryName: "Food",
    amountMinor: 480,
    signedAmountMinor: -480,
    date,
    note,
    transferId: null,
    counterparty: null,
  });

  it("shows the aside (Balance after) instead of the net and leaves the wallet name out", () => {
    const html = renderToStaticMarkup(
      <DayList
        items={[t(1, "2026-11-08", "Coffee"), t(2, "2026-11-07", null)]}
        totals={[{ date: "2026-11-08", currency: "EUR", netMinor: -480 }]}
        today="2026-11-08"
        returnTo="/wallets/1"
        showWallet={false}
        aside={(date) => (date === "2026-11-08" ? balanceAfterLabel(120000, "EUR") : null)}
      />,
    );
    expect(html).toContain("Balance after €1,200.00");
    expect(html).not.toContain("Net for the day");
    expect(html).not.toContain("ING");
    expect(html).toContain(">Coffee<");
    // one aside only: the 7th has none
    expect(html.match(/Balance after/g)).toHaveLength(1);
  });

  it("keeps the /transactions behaviour by default (net + wallet name)", () => {
    const html = renderToStaticMarkup(
      <DayList
        items={[t(1, "2026-11-08", "Coffee")]}
        totals={[{ date: "2026-11-08", currency: "EUR", netMinor: -480 }]}
        today="2026-11-08"
        returnTo="/transactions"
      />,
    );
    expect(html).toContain("Net for the day");
    expect(html).toContain("-€4.80");
    expect(html).toContain("Coffee · ING");
  });
});

describe("WalletForm", () => {
  const pinned = [
    { code: "EUR", name: "Euro" },
    { code: "USD", name: "US Dollar" },
  ];
  const all = [...pinned, { code: "CHF", name: "Swiss Franc" }];
  const noop = async () => ({});

  it("create in a dialog: posts mode=dialog, currency pills plus a typed code with suggestions, Cancel is a button", () => {
    const html = renderToStaticMarkup(
      <WalletForm mode="create" variant="dialog" action={noop} pinned={pinned} all={all} cancelHref="/wallets" submitLabel="Create wallet" pendingLabel="Creating…" />,
    );
    expect(html).toContain('name="mode" value="dialog"');
    expect(html.match(/<input type="radio"[^>]*name="currency"/g)).toHaveLength(2);
    const code = html.match(/<input id="currency-code"[^>]*>/)?.[0] ?? "";
    expect(code).toContain('name="currency"');
    expect(code).toContain('list="currency-suggestions"');
    // after the pills, so a filled code is the last value posted
    expect(html.indexOf('id="currency-code"')).toBeGreaterThan(html.lastIndexOf('type="radio"'));
    expect(html).toContain('<option value="CHF">Swiss Franc</option>');
    expect(html).toContain("This can&#x27;t be changed once the wallet exists.");
    expect(html).toContain('name="initialBalance"');
    expect(html).not.toContain('href="/wallets"');
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*form="/);
  });

  it("create as a page: no mode, Cancel links back", () => {
    const html = renderToStaticMarkup(
      <WalletForm mode="create" action={noop} pinned={pinned} all={all} cancelHref="/wallets" submitLabel="Create wallet" pendingLabel="Creating…" />,
    );
    expect(html).not.toContain('name="mode"');
    expect(html).toContain('href="/wallets"');
  });

  it("edit: the currency is fixed text (nothing posts it) and the manage section sits outside the form", () => {
    const html = renderToStaticMarkup(
      <WalletForm
        mode="edit"
        variant="dialog"
        action={noop}
        currency="JPY"
        currencyLabel="JPY · Japanese Yen"
        defaults={{ name: "Tokyo", initialBalance: "1500" }}
        cancelHref="/wallets/3"
        submitLabel="Save changes"
        pendingLabel="Saving…"
        manage={<section id="manage">Archive</section>}
      />,
    );
    expect(html).toContain("JPY · Japanese Yen");
    expect(html).not.toContain('name="currency"');
    expect(html).toContain('value="Tokyo"');
    expect(html).toContain('placeholder="0"');
    expect(html.indexOf('id="manage"')).toBeGreaterThan(html.indexOf("</form>"));
  });
});
