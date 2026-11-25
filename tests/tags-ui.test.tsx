// Tags in the interface, rendered to HTML (no DOM here): the entry form's Tags field (its no-JS base and the pure
// suggestion helpers), the pills on day-list rows, the Tag filter chip and no-JS select, the list URL and the Tags card
// of /categories. Typing, picking a suggestion and the card's rename / delete were checked in browsers (e2e/tags.spec.ts).
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ back() {}, refresh() {}, push() {} }) }));
vi.mock("@/app/(app)/categories/actions", () => ({ renameTagAction: async () => ({}), deleteTagAction: async () => ({}) }));

import { TagSection, tagEntriesHref } from "@/components/categories/tag-section";
import { DayList } from "@/components/transactions/day-list";
import { EntryForm, type EntryInitialValues } from "@/components/transactions/entry-form";
import { FilterChips } from "@/components/transactions/filter-chips";
import { InlineEditProvider } from "@/components/transactions/inline-edit";
import { exportCsvHref, hasFilters, listFilters, listHref, monthHref, parseListParams } from "@/components/transactions/list-params";
import { NoScriptFilters } from "@/components/transactions/no-script-filters";
import { TagsField, tagSuggestions, toggleTag, type TagOption } from "@/components/transactions/tags-field";
import type { TransactionView } from "@/server/transactions";

const TODAY = "2026-11-08";
const OPTIONS: TagOption[] = [
  { name: "holiday 2026", count: 9 },
  { name: "reimbursable", count: 4 },
  { name: "Work", count: 12 },
];

describe("tag suggestions (pure)", () => {
  it("offers every tag, most used first, then narrows to the piece being typed", () => {
    expect(tagSuggestions("", OPTIONS).map((o) => o.name)).toEqual(["Work", "holiday 2026", "reimbursable"]);
    expect(tagSuggestions("hol", OPTIONS).map((o) => o.name)).toEqual(["holiday 2026"]);
    expect(tagSuggestions("work, re", OPTIONS).map((o) => o.name)).toEqual(["Work", "reimbursable"]);
    // A finished tag stops the narrowing; the chosen ones come first.
    expect(tagSuggestions("reimbursable", OPTIONS).map((o) => o.name)).toEqual(["reimbursable", "Work", "holiday 2026"]);
    expect(tagSuggestions("", OPTIONS, 2)).toHaveLength(2);
  });

  it("toggles a tag: adds it (replacing a half-typed piece), removes it ignoring case", () => {
    expect(toggleTag("", "Work", OPTIONS)).toBe("Work");
    expect(toggleTag("Work, hol", "holiday 2026", OPTIONS)).toBe("Work, holiday 2026");
    // A new name typed before is not a search for the picked tag: it stays.
    expect(toggleTag("Work, my own", "reimbursable", OPTIONS)).toBe("Work, my own, reimbursable");
    expect(toggleTag("work, reimbursable", "Work", OPTIONS)).toBe("reimbursable");
    expect(toggleTag("Work,", "reimbursable", OPTIONS)).toBe("Work, reimbursable");
  });
});

describe("TagsField", () => {
  it("is one plain text input named tags without JavaScript (no suggestion buttons rendered on the server)", () => {
    const html = renderToStaticMarkup(<TagsField id="tags" defaultValue="Work, trip" options={OPTIONS} />);
    expect(html).toContain('<label for="tags" class="sr-only">Tags</label>');
    expect(html).toMatch(/<input[^>]*id="tags"[^>]*name="tags"[^>]*value="Work, trip"/);
    expect(html).toContain('placeholder="Tags, separated by commas (optional)"');
    expect(html).not.toContain("aria-pressed");
  });

  it("shows its error on the field", () => {
    const html = renderToStaticMarkup(<TagsField id="tags" options={[]} error="An entry can have at most 10 tags." />);
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('id="tags-error"');
  });

  const form = (kind: EntryInitialValues["kind"]) =>
    renderToStaticMarkup(
      <EntryForm
        variant="dialog"
        wallets={[
          { id: 1, name: "Cash", currency: "EUR", archived: false },
          { id: 2, name: "Bank", currency: "EUR", archived: false },
        ]}
        categories={[{ id: 10, name: "Food", kind: "expense" }]}
        initial={{ kind, date: TODAY, tags: "Work" }}
        today={TODAY}
        transactionAction={async () => ({})}
        transferAction={async () => ({})}
        returnTo="/transactions"
        canTransfer
        tags={OPTIONS}
      />,
    );

  it("is in the entry form for expenses and income, after the note, and not for transfers", () => {
    const html = form("expense");
    expect(html).toMatch(/name="tags"[^>]*value="Work"/);
    expect(html.indexOf('name="note"')).toBeLessThan(html.indexOf('name="tags"'));
    expect(form("transfer")).not.toContain('name="tags"');
  });
});

const row = (over: Partial<TransactionView>): TransactionView => ({
  id: 1,
  kind: "expense",
  walletId: 2,
  walletName: "Bank",
  currency: "EUR",
  categoryId: 10,
  categoryName: "Food",
  categoryColor: null,
  amountMinor: 1200,
  signedAmountMinor: -1200,
  date: TODAY,
  note: "Pizza",
  transferId: null,
  counterparty: null,
  recurringId: null,
  tags: [],
  ...over,
});

describe("tag pills on day-list rows", () => {
  const render = (items: TransactionView[]) =>
    renderToStaticMarkup(
      <InlineEditProvider wallets={[]} categories={[]} today={TODAY} returnTo="/transactions">
        <DayList items={items} today={TODAY} returnTo="/transactions" />
      </InlineEditProvider>,
    );

  it("shows the first tag (two from sm) after the note and the rest as +N, with the whole list for screen readers", () => {
    const html = render([row({ tags: ["a", "b", "c", "d"] })]);
    expect(html).toContain('<span class="sr-only">Tags: a, b, c, d</span>');
    expect(html).toMatch(/>a<\/span>/);
    expect(html).toMatch(/hidden sm:inline-block[^"]*">b<\/span>/);
    expect(html).toContain(">+3</span>");
    expect(html).toContain(">+2</span>");
    expect(html).not.toContain(">c</span>");
    // The note comes first.
    expect(html.indexOf("Pizza")).toBeLessThan(html.indexOf("Tags: "));
  });

  it("adds nothing to a row without tags", () => {
    expect(render([row({})])).not.toContain("Tags:");
  });

  it("hands the editor the entry's tags", async () => {
    const { inlineEntryOf } = await import("@/components/transactions/day-list");
    expect(inlineEntryOf(row({ tags: ["a", "b c"] }))).toMatchObject({ type: "transaction", tags: "a, b c" });
  });
});

describe("the tag filter", () => {
  const TAGS = [
    { id: 5, name: "holiday 2026" },
    { id: 6, name: "Work" },
  ];

  it("lives in the URL as ?tag=<id>, counts as a filter and reaches the service, the month links and the export", () => {
    const p = parseListParams({ tag: "5", month: "2026-10" });
    expect(p.tags).toEqual([5]);
    expect(parseListParams({ tag: "x" }).tags).toBeUndefined();
    expect(hasFilters(parseListParams({ tag: "5" }), "2026-11")).toBe(true);
    expect(listFilters(p, "2026-11")).toMatchObject({ tagIds: [5], month: "2026-10" });
    expect(listHref(p)).toBe("/transactions?month=2026-10&tag=5");
    expect(monthHref(p, "2026-09", "2026-11")).toBe("/transactions?month=2026-09&tag=5");
    expect(exportCsvHref(p, "2026-11")).toBe("/api/export/transactions?month=2026-10&tag=5");
  });

  it("is a Tag chip next to the others, showing the chosen tag", () => {
    const render = (sp: Record<string, string>) =>
      renderToStaticMarkup(
        <FilterChips params={parseListParams(sp)} thisMonth="2026-11" wallets={[]} categories={[]} tags={TAGS} exportHref={null} showClear={false} />,
      );
    expect(render({})).toMatch(/aria-haspopup="listbox"[^>]*>Tag</);
    expect(render({ tag: "6" })).toContain('<span class="sr-only">Tag: </span><span class="truncate">Work</span>');
    // The search form keeps the tag.
    expect(render({ tag: "6" })).toContain('<input type="hidden" name="tag" value="6"/>');
    // No tags and none chosen: no chip.
    expect(
      renderToStaticMarkup(
        <FilterChips params={parseListParams({})} thisMonth="2026-11" wallets={[]} categories={[]} exportHref={null} showClear={false} />,
      ),
    ).not.toMatch(/>Tag</);
  });

  it("is a select in the no-JS filter form", () => {
    const html = renderToStaticMarkup(
      <NoScriptFilters params={parseListParams({ tag: "6" })} thisMonth="2026-11" wallets={[]} categories={[]} tags={TAGS} />,
    );
    // A multiple select since tags can be combined (none chosen = all tags).
    expect(html).toMatch(/<select name="tag" multiple=""/);
    expect(html).toContain('<option value="6" selected="">Work</option>');
  });
});

describe("the Tags card on /categories", () => {
  it("lists each tag with its entry count, as rows that open in place", () => {
    const html = renderToStaticMarkup(
      <TagSection
        tags={[
          { id: 5, name: "holiday 2026", transactionCount: 9 },
          { id: 6, name: "spare", transactionCount: 0 },
          { id: 7, name: "once", transactionCount: 1 },
        ]}
      />,
    );
    expect(html).toContain('id="tags-heading"');
    expect(html).toMatch(/Tags.*· 3 tags/);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("holiday 2026");
    expect(html).toContain(">9 entries<");
    expect(html).toContain(">1 entry<");
    expect(html).toContain(">0 entries<");
    expect(tagEntriesHref(5)).toBe("/transactions?month=all&tag=5");
  });

  it("explains where tags come from when there are none", () => {
    const html = renderToStaticMarkup(<TagSection tags={[]} />);
    expect(html).toContain("No tags yet.");
    expect(html).not.toContain("<ul");
  });
});
