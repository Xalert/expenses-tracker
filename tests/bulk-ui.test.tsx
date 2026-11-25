// Filters and bulk edit on /transactions, rendered to HTML or as pure helpers: the new URL parameters and their round
// trip, the multi-select Category / Tag chips and the Amount chip, the no-JS form's multiple selects and amount fields,
// selection mode (row checkboxes joined to the bar's form, the bar without JavaScript), the result line's wording, the
// shortcut guard for checkboxes, and "Duplicate" (`duplicateInitial`, `?from=`).
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, refresh: () => {} }) }));

import { duplicateInitial, toCategoryOptions, walletOptions } from "@/app/(app)/transactions/form-options";
import { BULK_FORM_ID, BulkEditProvider } from "@/components/transactions/bulk-edit";
import { DayList } from "@/components/transactions/day-list";
import { FilterChips } from "@/components/transactions/filter-chips";
import {
  amountRangeErrors,
  exportCsvHref,
  hasFilters,
  hasRepeatedParams,
  listFilters,
  listHref,
  monthHref,
  parseListParams,
  toggleIdHref,
} from "@/components/transactions/list-params";
import { NoScriptFilters } from "@/components/transactions/no-script-filters";
import { decodeOutcome, deleteConfirmText, describeOutcome, encodeOutcome } from "@/lib/bulk-result";
import { isNewEntryShortcut, monthStepShortcut } from "@/lib/shortcuts";
import { archiveCategory, listCategories, renameCategory } from "@/server/categories";
import { archiveWallet, createWallet } from "@/server/wallets";
import { createTransaction, type TransactionView } from "@/server/transactions";
import { createTransfer } from "@/server/transfers";
import { createRecurringEntry } from "@/server/recurring";
import { listTransactions } from "@/server/transactions";
import { makeUser, useFreshDb } from "./helpers";

const NOV = "2026-11";

describe("list parameters", () => {
  it("reads several categories and tags (comma list or repeated keys), sorted and deduped", () => {
    expect(parseListParams({ category: "3,1,3,x,-2" }).categories).toEqual([1, 3]);
    expect(parseListParams({ category: ["2", "1,5"] }).categories).toEqual([1, 2, 5]);
    expect(parseListParams({ tag: "7" }).tags).toEqual([7]);
    expect(parseListParams({ category: "," }).categories).toBeUndefined();
    expect(parseListParams({ category: Array.from({ length: 150 }, (_, i) => String(i + 1)).join(",") }).categories).toHaveLength(100);
    expect(hasRepeatedParams({ category: ["1", "2"] })).toBe(true);
    expect(hasRepeatedParams({ category: "1,2" })).toBe(false);
  });

  it("keeps the amount bounds as typed, reports the invalid ones and passes only the valid ones on", () => {
    const p = parseListParams({ min: " 12,5 ", max: "abc" });
    expect([p.min, p.max]).toEqual(["12,5", "abc"]);
    expect(amountRangeErrors(p)).toEqual({ max: "Enter the maximum as an amount, like 12.50." });
    expect(listFilters(p, NOV)).toMatchObject({ minAmount: "12,5", maxAmount: undefined });
    expect(hasFilters(parseListParams({ min: "1" }), NOV)).toBe(true);
    // The export link leaves an invalid bound out (the page says what is wrong).
    expect(exportCsvHref(p, NOV)).toBe("/api/export/transactions?month=2026-11&min=12,5");
  });

  it("round-trips through listHref with readable commas; selection mode is kept but not exported", () => {
    const p = parseListParams({ month: "2026-10", category: "2,1", tag: "9", min: "5", max: "50", select: "1" });
    const href = listHref(p);
    expect(href).toBe("/transactions?month=2026-10&category=1,2&tag=9&min=5&max=50&select=1");
    const back = parseListParams(Object.fromEntries(new URL(href, "http://x").searchParams));
    expect(back).toEqual(p);
    expect(monthHref(p, "2026-09", NOV)).toContain("category=1,2&tag=9&min=5&max=50&select=1");
    expect(exportCsvHref(p, NOV)).toBe("/api/export/transactions?month=2026-10&category=1,2&tag=9&min=5&max=50");
    expect(parseListParams({ select: "page" }).select).toBe("page");
    expect(parseListParams({ select: "yes" }).select).toBeUndefined();
  });

  it("toggles one id in or out of a multi-value filter, back to page 1", () => {
    const p = parseListParams({ category: "1,3", page: "2" });
    expect(toggleIdHref(p, "categories", 2)).toBe("/transactions?category=1,2,3");
    expect(toggleIdHref(p, "categories", 3)).toBe("/transactions?category=1");
    expect(toggleIdHref(parseListParams({ tag: "4" }), "tags", 4)).toBe("/transactions");
  });
});

const wallets = [{ id: 2, name: "Cash", currency: "EUR", archived: false }];
const categories = [
  { id: 10, name: "Food", kind: "expense" as const, color: "teal" },
  { id: 11, name: "Groceries", kind: "expense" as const },
  { id: 12, name: "Salary", kind: "income" as const },
];
const tags = [
  { id: 5, name: "holiday" },
  { id: 6, name: "work" },
];

describe("FilterChips", () => {
  const render = (sp: Record<string, string>, errors = {}) =>
    renderToStaticMarkup(
      <FilterChips
        params={parseListParams(sp)}
        thisMonth={NOV}
        wallets={wallets}
        categories={categories}
        tags={tags}
        exportHref={null}
        showClear={false}
        amountErrors={errors}
      />,
    );

  it("shows several categories as 'First +N', an unknown one as such, and an Amount chip with the range", () => {
    expect(render({ category: "10,11" })).toContain('<span class="sr-only">Category: </span><span class="truncate">Food +1</span>');
    expect(render({ category: "99" })).toContain('<span class="truncate">Unknown category</span>');
    expect(render({ tag: "5,6" })).toContain('<span class="truncate">holiday +1</span>');
    expect(render({})).toMatch(/aria-haspopup="dialog"[^>]*>Amount</);
    expect(render({ min: "5", max: "20" })).toContain('<span class="sr-only">Amount: </span><span class="truncate">5 – 20</span>');
    // The search form carries every filter along.
    const html = render({ category: "10,11", tag: "5", min: "5", select: "1" });
    for (const hidden of ['name="category" value="10,11"', 'name="tag" value="5"', 'name="min" value="5"', 'name="select" value="1"']) {
      expect(html).toContain(hidden);
    }
    expect(html).toContain("Search notes, categories and tags");
  });

  it("says when the amount range is not applied", () => {
    const html = render({ min: "-1" }, { min: "The minimum cannot be negative." });
    expect(html).toContain('role="alert"');
    expect(html).toContain("Amount filter not applied: The minimum cannot be negative.");
  });
});

describe("NoScriptFilters", () => {
  it("offers multiple selects for categories and tags and the two amount fields, with their errors", () => {
    const html = renderToStaticMarkup(
      <NoScriptFilters
        params={parseListParams({ category: "10,12", tag: "99", min: "x", select: "1" })}
        thisMonth={NOV}
        wallets={wallets}
        categories={categories}
        tags={tags}
        amountErrors={{ min: "Enter the minimum as an amount, like 12.50." }}
      />,
    );
    expect(html).toMatch(/<select name="category" multiple=""/);
    expect(html).toContain('<option value="10" selected="">Food</option>');
    expect(html).toContain('<option value="12" selected="">Salary</option>');
    expect(html).toContain('<option value="11">Groceries</option>');
    expect(html).toContain('<option value="99" selected="">Unknown tag</option>');
    expect(html).toMatch(/<input id="no-script-min"[^>]*aria-invalid="true"[^>]*name="min" value="x"/);
    expect(html).toContain("Enter the minimum as an amount, like 12.50.");
    expect(html).toContain('<input type="hidden" name="select" value="1"/>');
  });
});

const row = (over: Partial<TransactionView>): TransactionView => ({
  id: 1,
  kind: "expense",
  walletId: 2,
  walletName: "Cash",
  currency: "EUR",
  categoryId: 10,
  categoryName: "Food",
  categoryColor: null,
  amountMinor: 1200,
  signedAmountMinor: -1200,
  date: "2026-11-05",
  note: "Pizza",
  transferId: null,
  counterparty: null,
  recurringId: null,
  tags: [],
  ...over,
});

describe("DayList", () => {
  it("puts the category's colour dot before its name", () => {
    const html = renderToStaticMarkup(
      <DayList items={[row({ categoryColor: "teal" }), row({ id: 2, categoryColor: null })]} today="2026-11-20" returnTo="/transactions" />,
    );
    expect(html.match(/data-group-color="teal"/g)).toHaveLength(1);
  });

  it("in selection mode is a list of checkboxes joined to the bulk form, labelled by the row", () => {
    const html = renderToStaticMarkup(
      <DayList items={[row({}), row({ id: 2, note: "Tea" })]} today="2026-11-20" returnTo="/transactions" selectable />,
    );
    expect(html).not.toContain("aria-expanded");
    expect(html.match(new RegExp(`<input type="checkbox" form="${BULK_FORM_ID}"[^>]*name="ids"[^>]*value="\\d"`, "g"))).toHaveLength(2);
    // The label wraps the checkbox and the row's summary.
    expect(html).toMatch(/<label[^>]*><input type="checkbox"[^>]*value="1"\/><span[^>]*><\/span><span class="min-w-0 flex-1">.*Food/);
  });
});

describe("the bulk bar", () => {
  const action = async () => ({});
  const render = (props: Partial<Parameters<typeof BulkEditProvider>[0]> = {}) =>
    renderToStaticMarkup(
      <BulkEditProvider
        action={action}
        list="month=2026-11"
        shown={50}
        total={120}
        categories={[{ id: 11, name: "Groceries", kind: "expense" }]}
        tags={tags}
        selectAllHref="/transactions?select=page"
        clearHref="/transactions?select=1"
        {...props}
      >
        <DayList items={[row({})]} today="2026-11-20" returnTo="/transactions" selectable />
      </BulkEditProvider>,
    );

  it("is one form with the action, every field (before scripts run) and 'Select all N matching'", () => {
    const html = render();
    expect(html).toContain(`<form id="${BULK_FORM_ID}"`);
    expect(html).toContain('<input type="hidden" name="list" value="month=2026-11"/>');
    expect(html).toMatch(/<select[^>]*id="bulk-op"[^>]*name="op"/);
    for (const name of ["categoryId", "tagName", "tagId"]) expect(html).toContain(`name="${name}"`);
    expect(html).toContain("Select all 120 matching entries");
    expect(html).toContain('name="scope" value="all"');
    // Without scripts "Select all shown" / "Clear" are links.
    expect(html).toContain('href="/transactions?select=page"');
    expect(html).toContain('<label class="flex min-h-11');
  });

  it("leaves out 'all matching' when everything is shown; ticks every row with ?select=page", () => {
    const html = render({ total: 50, preselectAll: true });
    expect(html).not.toContain("matching entries");
    expect(html).toMatch(/form="bulk-edit"[^>]*name="ids" checked="" value="1"/);
  });
});

describe("result line and confirmation wording", () => {
  it("encodes the outcome as numbers only and decodes it back", () => {
    const o = { op: "category" as const, categoryId: 4, changed: 42, unchanged: 0, otherKind: 0, transfers: 3 };
    expect(encodeOutcome(o)).toBe("c.4.42.0.0.3");
    expect(decodeOutcome("c.4.42.0.0.3")).toEqual(o);
    expect(decodeOutcome("c.4.x")).toBeNull();
    expect(decodeOutcome("d.1")).toBeNull();
    expect(decodeOutcome(undefined)).toBeNull();
  });

  it("reads as a sentence", () => {
    expect(
      describeOutcome(
        { op: "category", categoryId: 4, changed: 42, unchanged: 0, otherKind: 0, transfers: 3 },
        { category: { name: "Groceries", kind: "expense" } },
      ),
    ).toBe("Moved 42 entries to Groceries; 3 transfers skipped.");
    expect(
      describeOutcome(
        { op: "category", categoryId: 4, changed: 1, unchanged: 2, otherKind: 1, transfers: 0 },
        { category: { name: "Groceries", kind: "expense" } },
      ),
    ).toBe("Moved 1 entry to Groceries; 2 were already in it; 1 income entry skipped.");
    expect(describeOutcome({ op: "delete", entries: 2, transfers: 1 })).toBe("Deleted 2 entries and 1 transfer (both sides of each transfer).");
    expect(describeOutcome({ op: "addTag", tagId: 1, added: 3, already: 1, atLimit: 2, transfers: 0 }, { tag: "trip" })).toBe(
      "Added “trip” to 3 entries; 1 already had it; 2 entries skipped (already at 10 tags).",
    );
    expect(describeOutcome({ op: "removeTag", tagId: 1, removed: 0, notTagged: 4, transfers: 1 })).toBe(
      "Removed the tag from 0 entries; 4 did not have it; 1 transfer skipped.",
    );
  });

  it("the delete confirmation states the counts, both sides of transfers, no undo and the backup", () => {
    const text = deleteConfirmText({ entries: 120, transfers: 4 });
    expect(text).toContain("Delete 120 entries and 4 transfers?");
    expect(text).toContain("both of its sides (8 rows)");
    expect(text).toContain("There is no undo");
    expect(text).toContain("backup");
  });
});

describe("shortcuts on a row checkbox", () => {
  const ev = (target: object, key = "]") => ({ key, altKey: false, ctrlKey: false, metaKey: false, target: target as unknown as EventTarget });
  const checkbox = { tagName: "INPUT", type: "checkbox", closest: () => null };
  it("keep working (a checkbox takes no typing), but not in text inputs or inside a modal", () => {
    expect(monthStepShortcut(ev(checkbox))).toBe("next");
    expect(isNewEntryShortcut(ev(checkbox, "n"))).toBe(true);
    expect(monthStepShortcut(ev({ tagName: "INPUT", type: "text", closest: () => null }))).toBeNull();
    expect(monthStepShortcut(ev({ tagName: "INPUT", type: "checkbox", closest: () => ({}) }))).toBeNull();
  });
});

describe("Duplicate (?from=)", () => {
  let user: Awaited<ReturnType<typeof makeUser>>;
  let other: Awaited<ReturnType<typeof makeUser>>;
  beforeEach(async () => {
    const db = await useFreshDb();
    user = await makeUser(db, "alice@example.com");
    other = await makeUser(db, "bob@example.com");
  });

  const offered = async (userId: number) => ({
    wallets: await walletOptions(userId),
    categories: toCategoryOptions(await listCategories(userId)),
  });

  it("copies kind, wallet, category, amount, note and tags with today's date, never the repeating rule", async () => {
    const cash = (await createWallet(user.id, { name: "Cash", currency: "EUR", initialBalanceMinor: 0 })).id;
    await renameCategory(user.id, user.cat("Food"), { name: "Food" });
    const { transaction } = await createRecurringEntry(
      user.id,
      { walletId: cash, kind: "expense", categoryId: user.cat("Food"), amountMinor: 1250, date: "2026-11-01", note: "lunch", tags: ["work", "Trip"] },
      { frequency: "monthly" },
      "2026-11-01",
    );
    const init = await duplicateInitial(user.id, transaction.id, "2026-11-20", await offered(user.id));
    expect(init).toEqual({
      kind: "expense",
      walletId: cash,
      categoryId: user.cat("Food"),
      amount: "12.50",
      date: "2026-11-20",
      note: "lunch",
      tags: "Trip, work",
    });
    expect(init).not.toHaveProperty("repeat");
  });

  it("a transfer leg copies both wallets and amounts", async () => {
    const eur = (await createWallet(user.id, { name: "EUR", currency: "EUR", initialBalanceMinor: 0 })).id;
    const jpy = (await createWallet(user.id, { name: "JPY", currency: "JPY", initialBalanceMinor: 0 })).id;
    await createTransfer(user.id, { fromWalletId: eur, toWalletId: jpy, amountMinor: 1000, receivedAmountMinor: 1600, date: "2026-11-02", note: "fx" });
    const legIn = (await listTransactions(user.id, { kind: "transfer" })).items.find((t) => t.kind === "transfer_in")!;
    expect(await duplicateInitial(user.id, legIn.id, "2026-11-20", await offered(user.id))).toEqual({
      kind: "transfer",
      fromWalletId: eur,
      toWalletId: jpy,
      amount: "10.00",
      receivedAmount: "1600",
      date: "2026-11-20",
      note: "fx",
    });
  });

  it("leaves an archived wallet or category unselected; another user's or a missing id gives null", async () => {
    const old = (await createWallet(user.id, { name: "Old", currency: "EUR", initialBalanceMinor: 0 })).id;
    await createWallet(user.id, { name: "New", currency: "EUR", initialBalanceMinor: 0 });
    const t = await createTransaction(user.id, { walletId: old, kind: "income", categoryId: user.cat("Refund"), amountMinor: 300, date: "2026-11-02" });
    await archiveWallet(user.id, old);
    await archiveCategory(user.id, user.cat("Refund"));
    const init = await duplicateInitial(user.id, t.id, "2026-11-20", await offered(user.id));
    expect(init).toMatchObject({ kind: "income", walletId: undefined, categoryId: undefined, amount: "3.00", note: "" });
    expect(await duplicateInitial(other.id, t.id, "2026-11-20", await offered(other.id))).toBeNull();
    expect(await duplicateInitial(user.id, 99999, "2026-11-20", await offered(user.id))).toBeNull();
    expect(await duplicateInitial(user.id, null, "2026-11-20", await offered(user.id))).toBeNull();
  });
});
