// The "All in <currency>" controls rendered to static markup: the switch with its Rates link, the notes with the
// "Enter a rate" link, the past-month Wallets card, the day strip's notes slot, the /rates form, and `?view=only`
// on /transactions.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, refresh: () => {} }) }));

import { DeleteRateButton, RateForm } from "@/app/(app)/rates/rate-forms";
import { ConversionNotes, ConvertSwitch } from "@/components/dashboard/conversion";
import { WalletsCard } from "@/components/dashboard/overview-lists";
import { DayStrip } from "@/components/transactions/day-strip";
import { exportCsvHref, listHref, parseListParams } from "@/components/transactions/list-params";
import type { MonthTimeline } from "@/server/insights";
import type { WalletView } from "@/server/wallets";

describe("ConvertSwitch", () => {
  it("links both views, marks the current one and links the rates page", () => {
    const html = renderToStaticMarkup(
      <ConvertSwitch
        currency="EUR"
        view="only"
        allHref="/categories?currency=EUR"
        onlyHref="/categories?currency=EUR&amp;view=only"
        ratesHref="/rates?returnTo=%2Fcategories"
      />,
    );
    expect(html).toContain('aria-label="Currencies counted"');
    expect(html).toContain(">All in EUR<");
    expect(html).toMatch(/aria-current="true"[^>]*>EUR only</);
    expect(html).toContain('href="/rates?returnTo=%2Fcategories"');
    expect(html).toContain(">Rates<");
  });
});

describe("ConversionNotes", () => {
  it("renders each note and offers a rate for what was left out", () => {
    const html = renderToStaticMarkup(
      <ConversionNotes notes={["Rates of 6 Nov 2026 · ECB", "No exchange rate for KWD. Not included: wallets in KWD."]} need={["KWD"]} ratesHref="/rates" />,
    );
    expect(html).toContain("Rates of 6 Nov 2026 · ECB");
    expect(html).toMatch(/<a [^>]*href="\/rates"[^>]*>Enter a rate for KWD<\/a>/);
  });
  it("renders nothing when there is nothing to say", () => {
    expect(renderToStaticMarkup(<ConversionNotes notes={[]} need={[]} ratesHref="/rates" />)).toBe("");
    expect(renderToStaticMarkup(<ConversionNotes notes={["x"]} need={[]} ratesHref="/rates" />)).not.toContain("Enter a rate");
  });
});

const walletView = (over: Partial<WalletView>): WalletView =>
  ({ id: 1, name: "Cash", currency: "EUR", balanceMinor: 1000, initialBalanceMinor: 0, archivedAt: null, ...over }) as WalletView;

describe("WalletsCard", () => {
  it("for a past month says the balances are of that month's end, and links a missing rate", () => {
    const html = renderToStaticMarkup(
      <WalletsCard
        wallets={[walletView({ id: 1 }), walletView({ id: 2, name: "Kuwait", currency: "KWD", balanceMinor: 5000 })]}
        changes={new Map()}
        hrefFor={(id) => `/wallets/${id}`}
        changeLabel="in October"
        asOf="2026-10-31"
        total={{
          currency: "EUR",
          totalMinor: 1000,
          approximate: false,
          notes: ["No exchange rate for KWD. Not included: wallets in KWD."],
          need: ["KWD"],
          ratesHref: "/rates?returnTo=%2F%3Fmonth%3D2026-10",
        }}
      />,
    );
    expect(html).toContain("Balances at the end of 31 Oct 2026");
    expect(html).toContain("Not included: wallets in KWD.");
    expect(html).toContain('href="/rates?returnTo=%2F%3Fmonth%3D2026-10"');
    expect(html).toContain("Enter a rate for KWD");
  });
  it("for the current month says nothing about the date", () => {
    const html = renderToStaticMarkup(
      <WalletsCard wallets={[walletView({})]} changes={new Map()} hrefFor={() => "/"} changeLabel="this month" />,
    );
    expect(html).not.toContain("Balances at the end of");
  });
});

describe("DayStrip", () => {
  const timeline: MonthTimeline = {
    days: Array.from({ length: 30 }, (_, i) => ({
      date: `2026-11-${String(i + 1).padStart(2, "0")}`,
      expenseMinor: i === 2 ? 1500 : 0,
      incomeMinor: 0,
    })),
    previousCumulativeMinor: [],
    largestDay: null,
  };
  it("shows the conversion notes under its heading", () => {
    const html = renderToStaticMarkup(
      <DayStrip
        month="2026-11"
        currency="EUR"
        timeline={timeline}
        today="2026-11-18"
        hrefFor={(d) => `/transactions?from=${d}&to=${d}`}
        monthHref="/transactions"
        notes={<ConversionNotes notes={["All wallets, converted at each day's rate · ECB"]} need={[]} ratesHref="/rates" />}
      />,
    );
    expect(html).toContain("All wallets, converted at each day&#x27;s rate · ECB");
    expect(html).toContain("€15.00 in November 2026");
  });
});

describe("/transactions ?view=only", () => {
  it("is read, kept in the list links, and left out of the CSV export", () => {
    const p = parseListParams({ currency: "USD", view: "only", month: "2026-10" });
    expect(p.view).toBe("only");
    expect(parseListParams({ view: "all" }).view).toBeUndefined();
    expect(listHref(p)).toBe("/transactions?month=2026-10&currency=USD&view=only");
    expect(listHref(p, { view: undefined })).toBe("/transactions?month=2026-10&currency=USD");
    expect(exportCsvHref(p, "2026-11")).toBe("/api/export/transactions?month=2026-10");
  });
});

describe("/rates forms", () => {
  it("asks for 1 <currency> = rate <base> from a date, with the service's field names", () => {
    const html = renderToStaticMarkup(<RateForm currency="KWD" bases={["EUR", "USD"]} today="2026-11-18" />);
    expect(html).toContain('aria-label="New rate for KWD"');
    expect(html).toContain('<input type="hidden" name="currency" value="KWD"/>');
    expect(html).toContain(">1 KWD =<");
    expect(html).toMatch(/name="rate"[^>]*inputMode="decimal"|inputMode="decimal"[^>]*name="rate"/);
    expect(html).toMatch(/<select[^>]*name="base"/);
    expect(html).toContain('<option value="EUR" selected="">EUR</option>');
    expect(html).toContain('name="effectiveDate"');
    expect(html).toContain('value="2026-11-18"');
    // Ids are per currency, so several forms on one page do not collide.
    expect(html).toContain('id="rate-KWD"');
  });
  it("removes one rate with a labelled button", () => {
    const html = renderToStaticMarkup(<DeleteRateButton id={7} label="from 1 Nov 2026, 1 KWD = 3.25 EUR" />);
    expect(html).toContain('<input type="hidden" name="id" value="7"/>');
    expect(html).toContain('aria-label="Remove from 1 Nov 2026, 1 KWD = 3.25 EUR"');
  });
});
