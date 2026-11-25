// Repeating entries in the interface, rendered to HTML: the Add form's Repeat control, the marker on rule-made rows,
// the /recurring list and its edit form. Opening the control, the dialog and the buttons need a browser: see
// e2e/recurring.spec.ts.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { RecurringForm } from "@/components/recurring/recurring-form";
import { DayList } from "@/components/transactions/day-list";
import { EntryForm, type CategoryOption, type WalletOption } from "@/components/transactions/entry-form";
import { InlineEditProvider } from "@/components/transactions/inline-edit";
import type { TransactionView } from "@/server/transactions";

vi.mock("next/navigation", () => ({ useRouter: () => ({ back() {}, refresh() {}, push() {} }) }));

const WALLETS: WalletOption[] = [
  { id: 1, name: "Cash", currency: "EUR", archived: false },
  { id: 2, name: "Bank", currency: "EUR", archived: false },
];
const CATEGORIES: CategoryOption[] = [
  { id: 10, name: "Housing", kind: "expense" },
  { id: 20, name: "Salary", kind: "income" },
];
const TODAY = "2026-11-25";
const noop = async () => ({});

function addForm(opts: { repeat?: boolean; frequency?: "monthly"; date?: string; kind?: "expense" | "transfer" } = {}) {
  return renderToStaticMarkup(
    <EntryForm
      variant="dialog"
      wallets={WALLETS}
      categories={CATEGORIES}
      initial={{ kind: opts.kind ?? "expense", date: opts.date ?? TODAY }}
      today={TODAY}
      transactionAction={noop}
      transferAction={noop}
      returnTo="/transactions"
      canTransfer
      repeat={opts.repeat === false ? undefined : { frequency: opts.frequency ?? "never" }}
    />,
  );
}

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

describe("the Add form's Repeat control", () => {
  it("is one labelled select, Never by default, posting `frequency`", () => {
    const html = addForm();
    expect(html).toMatch(/<label for="frequency"[^>]*>Repeat<\/label>/);
    expect(html).toMatch(/<select id="frequency"[^>]*name="frequency"/);
    expect(html).toMatch(/<option value="never" selected="">Never<\/option>/);
    for (const label of ["Daily", "Weekly", "Monthly", "Yearly"]) expect(html).toContain(`>${label}</option>`);
    // Collapsed: no interval or end date yet.
    expect(html).not.toContain('name="interval"');
    expect(html).not.toContain("No end date");
  });

  it("preselected (from /recurring) shows Every N and the optional end date", () => {
    const html = addForm({ frequency: "monthly" });
    expect(html).toMatch(/<option value="monthly" selected="">Monthly<\/option>/);
    expect(html).toMatch(/<input[^>]*name="interval"[^>]*value="1"/);
    expect(text(html)).toContain("Every month until No end date");
    expect(html).toContain("No end date");
    expect(html).toContain('aria-label="End date (optional)"');
  });

  it("says how many more entries a past date adds", () => {
    expect(text(addForm({ frequency: "monthly", date: "2026-09-25" }))).toContain(
      "The date is in the past: saving also adds 2 more entries for the dates up to today.",
    );
    expect(text(addForm({ frequency: "monthly", date: "2026-11-01" }))).not.toContain("saving also adds");
  });

  it("is not offered for a transfer, nor where the form was not given `repeat` (edit pages)", () => {
    expect(addForm({ kind: "transfer" })).not.toContain('name="frequency"');
    expect(addForm({ repeat: false })).not.toContain('name="frequency"');
  });
});

const row = (over: Partial<TransactionView>): TransactionView => ({
  id: 1,
  kind: "expense",
  walletId: 2,
  walletName: "Bank",
  currency: "EUR",
  categoryId: 10,
  categoryName: "Housing",
  amountMinor: 95_000,
  signedAmountMinor: -95_000,
  date: "2026-11-01",
  note: "rent",
  transferId: null,
  counterparty: null,
  recurringId: null,
  ...over,
});

describe("the repeats marker", () => {
  it("shows on rows a rule made, with a text for screen readers", () => {
    const html = renderToStaticMarkup(
      <InlineEditProvider wallets={WALLETS} categories={CATEGORIES} today={TODAY} returnTo="/transactions">
        <DayList items={[row({ id: 1, recurringId: 7 }), row({ id: 2, note: "deposit" })]} today={TODAY} returnTo="/transactions" />
      </InlineEditProvider>,
    );
    expect(html.match(/\(repeats\)/g)).toHaveLength(1);
    expect(text(html)).toContain("Housing (repeats) rent · Bank");
    expect(text(html)).toContain("Housing deposit · Bank");
  });
});

describe("RecurringForm", () => {
  it("starts from the rule and posts the service's field names", () => {
    const html = renderToStaticMarkup(
      <RecurringForm
        action={noop}
        kind="expense"
        today={TODAY}
        wallets={WALLETS}
        categories={CATEGORIES.filter((c) => c.kind === "expense")}
        defaults={{
          walletId: 2,
          categoryId: 10,
          amount: "950.00",
          note: "rent",
          frequency: "monthly",
          interval: 1,
          nextDate: "2026-12-01",
          endDate: "",
        }}
      />,
    );
    expect(html).toMatch(/<input[^>]*name="amount"[^>]*value="950.00"/);
    const checked = (name: string) =>
      [...html.matchAll(/<input type="radio"[^>]*>/g)]
        .map((m) => m[0])
        .filter((t) => t.includes(`name="${name}"`) && t.includes('checked=""'))
        .map((t) => /value="([^"]*)"/.exec(t)![1]);
    expect(checked("categoryId")).toEqual(["10"]);
    expect(checked("walletId")).toEqual(["2"]);
    expect(html).toMatch(/<option value="monthly" selected="">Monthly<\/option>/);
    expect(html).not.toContain('value="never"');
    expect(html).toContain('name="nextDate" value="2026-12-01"');
    expect(html).toContain("No end date");
    expect(text(html)).toContain("Changes apply to the entries still to come");
    expect(text(html)).toContain("EUR · from Bank");
  });
});
