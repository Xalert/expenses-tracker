// The Add / edit form (`EntryForm`) rendered to HTML: what each variant posts and shows. Clicking (the date pills,
// keep-open, closing the dialog) needs a browser and was checked with Playwright; see SPEC "/transactions/new".
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { EntryForm, type CategoryOption, type EntryInitialValues, type WalletOption } from "@/components/transactions/entry-form";

vi.mock("next/navigation", () => ({ useRouter: () => ({ back() {}, refresh() {}, push() {} }) }));

const WALLETS: WalletOption[] = [
  { id: 1, name: "Cash", currency: "EUR", archived: false },
  { id: 2, name: "Bank", currency: "EUR", archived: false },
  { id: 3, name: "Tokyo", currency: "JPY", archived: false },
];
const CATEGORIES: CategoryOption[] = [
  { id: 10, name: "Food", kind: "expense" },
  { id: 11, name: "Bills", kind: "expense" },
  { id: 20, name: "Salary", kind: "income" },
];
const TODAY = "2026-11-08";
const noopAction = async () => ({});

function render(opts: {
  initial?: Partial<EntryInitialValues>;
  variant?: "page" | "dialog";
  wallets?: WalletOption[];
  today?: string;
  edit?: "transaction" | "transfer";
}) {
  const initial: EntryInitialValues = { kind: "expense", date: opts.today ?? TODAY, ...opts.initial };
  return renderToStaticMarkup(
    <EntryForm
      variant={opts.variant}
      wallets={opts.wallets ?? WALLETS}
      categories={CATEGORIES}
      initial={initial}
      today={opts.today ?? TODAY}
      transactionAction={opts.edit === "transfer" ? undefined : noopAction}
      transferAction={opts.edit === "transaction" ? undefined : noopAction}
      returnTo="/wallets"
      submitLabel={opts.edit ? "Save changes" : undefined}
      canTransfer
    />,
  );
}

/** The radio inputs of a name, as `value` → checked. */
function radios(html: string, name: string): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const m of html.matchAll(/<input type="radio"[^>]*>/g)) {
    if (!m[0].includes(`name="${name}"`)) continue;
    const value = /value="([^"]*)"/.exec(m[0])![1];
    out[value] = m[0].includes('checked=""');
  }
  return out;
}

/** The first opening tag of `element` that has every one of `attrs` (in any order). */
function tag(html: string, element: string, ...attrs: string[]): string | undefined {
  return [...html.matchAll(new RegExp(`<${element}\\b[^>]*>`, "g"))].map((m) => m[0]).find((t) => attrs.every((a) => t.includes(a)));
}

function pressed(html: string, label: string): boolean | undefined {
  const m = new RegExp(`<button type="button" aria-pressed="(true|false)"[^>]*>${label}</button>`).exec(html);
  return m ? m[1] === "true" : undefined;
}

describe("EntryForm, dialog variant", () => {
  it("posts mode=dialog, draws no card, and has Keep open, a Cancel button and a submit tied to the form", () => {
    const html = render({ variant: "dialog" });
    expect(html).toContain('<input type="hidden" name="mode" value="dialog"/>');
    expect(html).not.toContain("rounded-[20px]");
    expect(html).toContain("Keep open for another");
    expect(html).toMatch(/<input type="checkbox"[^>]*>/);
    expect(html).toMatch(/<button type="button"[^>]*>Cancel<\/button>/);
    expect(html).not.toContain('href="/wallets"');
    const formId = /<form id="([^"]+)"/.exec(html)![1];
    expect(html).toMatch(new RegExp(`<button type="submit"[^>]*form="${formId}"[^>]*>Add expense</button>`));
    expect(html).toContain('role="status"');
  });

  it("labels the submit by type", () => {
    expect(render({ variant: "dialog", initial: { kind: "income" } })).toContain(">Add income</button>");
    expect(render({ variant: "dialog", initial: { kind: "transfer" } })).toContain(">Add transfer</button>");
  });
});

describe("EntryForm, page variant", () => {
  it("does not post mode, sits in a card and cancels with a link to returnTo", () => {
    const html = render({});
    expect(html).not.toContain('name="mode"');
    expect(html).toContain("rounded-[20px]");
    expect(html).toMatch(/<a [^>]*href="\/wallets"[^>]*>Cancel<\/a>/);
    expect(html).not.toContain("Keep open for another");
    expect(html).toMatch(/<button type="submit"[^>]*>Add expense<\/button>/);
  });

  it("the edit pages switch only between the kinds they can save, with their own submit label", () => {
    const html = render({ edit: "transaction", initial: { kind: "income", walletId: 3, categoryId: 20, amount: "1500" } });
    expect(radios(html, "kind")).toEqual({ expense: false, income: true });
    expect(html).toContain(">Save changes</button>");
    expect(tag(html, "input", 'id="amount"', 'value="1500"')).toBeDefined();

    const transfer = render({ edit: "transfer", initial: { kind: "transfer", fromWalletId: 1, toWalletId: 2 } });
    expect(transfer).not.toContain('name="kind"');
    expect(transfer).toContain(">Save changes</button>");
  });
});

describe("EntryForm fields", () => {
  it("has a type switch, a large decimal amount input with the wallet's currency beside it", () => {
    const html = render({ initial: { walletId: 3 } });
    expect(radios(html, "kind")).toEqual({ expense: true, income: false, transfer: false });
    const amount = tag(html, "input", 'id="amount"', 'name="amount"', 'inputMode="decimal"', 'aria-describedby="amount-currency"')!;
    expect(amount).toMatch(/class="[^"]*text-\[44px\][^"]*tabular-nums/);
    expect(html).toContain('<span id="amount-currency"');
    expect(html).toContain("JPY · from Tokyo");
    expect(html).toContain('placeholder="0"');
  });

  it("offers the kind's categories and the wallets as pill radios posting categoryId and walletId", () => {
    const html = render({ initial: { walletId: 2, categoryId: 11 } });
    expect(radios(html, "categoryId")).toEqual({ "10": false, "11": true });
    expect(radios(html, "walletId")).toEqual({ "1": false, "2": true, "3": false });
    expect(html).toContain('aria-labelledby="categoryId-label"');
    expect(html).toContain('aria-labelledby="walletId-label"');
    expect(html).toContain('href="/categories"');

    const income = render({ initial: { kind: "income" } });
    expect(radios(income, "categoryId")).toEqual({ "20": false });
    // No wallet preselected: the first active one.
    expect(radios(income, "walletId")).toEqual({ "1": true, "2": false, "3": false });
  });

  it("keeps an archived wallet an existing entry uses, marked as such", () => {
    const wallets = [...WALLETS, { id: 4, name: "Old card", currency: "USD", archived: true }];
    const html = render({ wallets, edit: "transaction", initial: { walletId: 4, categoryId: 10 } });
    expect(radios(html, "walletId")["4"]).toBe(true);
    expect(html).toContain("Old card (archived)");
    expect(html).toContain("USD · from Old card");
  });

  it("shows the empty state instead of pills when the kind has no categories", () => {
    const none = renderToStaticMarkup(
      <EntryForm
        wallets={WALLETS}
        categories={[]}
        initial={{ kind: "expense", date: TODAY }}
        today={TODAY}
        transactionAction={noopAction}
        returnTo="/transactions"
        canTransfer={false}
        variant="dialog"
      />,
    );
    expect(none).toContain("You have no expense categories.");
    expect(none).not.toContain('name="categoryId"');
    expect(none).not.toContain('type="submit"');
  });

  it("transfers: From → To selects, Sent, and Received with the no-rate line only across currencies", () => {
    const same = render({ initial: { kind: "transfer", fromWalletId: 1, toWalletId: 2 } });
    expect(tag(same, "select", 'id="fromWalletId"', 'name="fromWalletId"')).toBeDefined();
    expect(tag(same, "select", 'id="toWalletId"', 'name="toWalletId"')).toBeDefined();
    expect(same).toContain(">Sent</label>");
    expect(same).not.toContain('name="receivedAmount"');
    expect(same).not.toContain("No rate is applied for you.");

    const cross = render({ initial: { kind: "transfer", fromWalletId: 1, toWalletId: 3 } });
    expect(cross).toContain(">Received</label>");
    expect(tag(cross, "input", 'id="receivedAmount"', 'name="receivedAmount"', 'inputMode="decimal"')).toBeDefined();
    expect(cross).toContain("Different currencies, so enter what actually arrived. No rate is applied for you.");
  });
});

describe("EntryForm date pills", () => {
  it("today selects Today and posts today", () => {
    const html = render({});
    expect(pressed(html, "Today")).toBe(true);
    expect(pressed(html, "Yesterday")).toBe(false);
    expect(html).toContain(`<input type="hidden" name="date" value="${TODAY}"/>`);
    expect(html).toContain("Other date");
  });

  it("yesterday selects Yesterday, also across a year boundary", () => {
    const html = render({ today: "2026-01-01", initial: { date: "2025-12-31" } });
    expect(pressed(html, "Today")).toBe(false);
    expect(pressed(html, "Yesterday")).toBe(true);
    expect(html).toContain('<input type="hidden" name="date" value="2025-12-31"/>');
  });

  it("another date selects neither pill and shows the date on the calendar button", () => {
    const html = render({ edit: "transaction", initial: { date: "2026-10-03", walletId: 1, categoryId: 10 } });
    expect(pressed(html, "Today")).toBe(false);
    expect(pressed(html, "Yesterday")).toBe(false);
    expect(html).toContain('<input type="hidden" name="date" value="2026-10-03"/>');
    expect(html).toContain("3 Oct 2026");
    expect(html).toContain('aria-label="Date: 3 Oct 2026. Choose another date"');
    expect(html).not.toContain("Other date");
  });

  it("has one note input with a placeholder", () => {
    const html = render({ initial: { note: "lunch" } });
    expect(tag(html, "input", 'id="note"', 'name="note"', 'maxLength="500"', 'placeholder="Note (optional)"', 'value="lunch"')).toBeDefined();
    expect(html).not.toContain("<textarea");
  });
});
