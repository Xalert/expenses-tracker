// The /transactions page's no-JS paths, the day strip's phone picker and the row focus rules (rendered to HTML or
// tested as pure helpers: the test environment has no DOM).
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, refresh: () => {} }) }));

import { DayStrip } from "@/components/transactions/day-strip";
import { FilterChips } from "@/components/transactions/filter-chips";
import { hasEmptyParams, listHref, parseListParams } from "@/components/transactions/list-params";
import { NoScriptFilters, noScriptMonthOptions } from "@/components/transactions/no-script-filters";
import { ExpandableList, ExpandableRow, focusCandidates, pickFocusTarget } from "@/components/ui/expandable-row";
import type { MonthTimeline } from "@/server/insights";

const wallets = [
  { id: 2, name: "Cash", currency: "EUR", archived: false },
  { id: 3, name: "Old", currency: "USD", archived: true },
];
const categories = [
  { id: 10, name: "Food", kind: "expense" as const },
  { id: 11, name: "Salary", kind: "income" as const },
];

describe("empty query values (no-JS forms)", () => {
  it("are detected, and the clean URL keeps everything else", () => {
    expect(hasEmptyParams({ q: "" })).toBe(true);
    expect(hasEmptyParams({ q: "   " })).toBe(true);
    expect(hasEmptyParams({ month: "2026-10", wallet: "", kind: "expense" })).toBe(true);
    expect(hasEmptyParams({ q: ["", "x"] })).toBe(true);
    expect(hasEmptyParams({ q: "coffee", month: "2026-10" })).toBe(false);
    expect(hasEmptyParams({})).toBe(false);
    const sp = { month: "2026-10", q: "", wallet: "", kind: "expense", category: "" };
    expect(listHref(parseListParams(sp))).toBe("/transactions?month=2026-10&kind=expense");
    expect(listHref(parseListParams({ q: "" }))).toBe("/transactions");
  });
});

describe("NoScriptFilters", () => {
  const render = (sp: Record<string, string>) =>
    renderToStaticMarkup(
      <NoScriptFilters params={parseListParams(sp)} thisMonth="2026-11" wallets={wallets} categories={categories} />,
    );

  it("is a GET form to /transactions with a select per chip and hides the popover chips", () => {
    const html = render({});
    const form = html.match(/<form [^>]*>/)?.[0] ?? "";
    expect(form).toContain('action="/transactions"');
    expect(form).toContain('method="get"');
    expect(form).toContain('aria-label="Filters"');
    for (const name of ["month", "wallet", "kind", "category"]) expect(html).toContain(`name="${name}"`);
    expect(html).toContain("[data-needs-js]{display:none!important}");
    expect(html).toContain(">Apply<");
    expect(html).toContain("Old · USD (archived)");
    expect(html).toContain('<optgroup label="Income"><option value="11">Salary</option></optgroup>');
  });

  it("preselects the current filters and carries the search and currency along", () => {
    const html = render({ month: "2026-09", wallet: "2", kind: "income", category: "11", q: "rent", currency: "USD" });
    expect(html).toMatch(/<option value="2026-09" selected="">September 2026<\/option>/);
    expect(html).toMatch(/<option value="2" selected="">Cash · EUR<\/option>/);
    expect(html).toMatch(/<option value="income" selected="">Income<\/option>/);
    expect(html).toMatch(/<option value="11" selected="">Salary<\/option>/);
    expect(html).toContain('<input type="hidden" name="q" value="rent"/>');
    expect(html).toContain('<input type="hidden" name="currency" value="USD"/>');
  });

  it("offers next month, the current one as the empty default, 24 back, an older month in view and All time", () => {
    const opts = noScriptMonthOptions(parseListParams({}), "2026-11");
    expect(opts[0]).toEqual({ value: "2026-12", label: "December 2026" });
    expect(opts[1]).toEqual({ value: "", label: "November 2026" });
    expect(opts).toHaveLength(1 + 1 + 24 + 1);
    expect(opts.at(-1)).toEqual({ value: "all", label: "All time" });
    const older = noScriptMonthOptions(parseListParams({ month: "2020-01" }), "2026-11");
    expect(older.at(-2)).toEqual({ value: "2020-01", label: "January 2020" });
    // A selected day preselects its month.
    expect(render({ from: "2026-10-05", to: "2026-10-05" })).toMatch(/<option value="2026-10" selected="">/);
    expect(render({ month: "all" })).toMatch(/<option value="all" selected="">All time<\/option>/);
  });

  it("the JS chips mark every popover chip as needing JavaScript; the month chip's label falls back to a link", () => {
    const html = renderToStaticMarkup(
      <FilterChips
        params={parseListParams({ month: "2026-09" })}
        thisMonth="2026-11"
        wallets={wallets}
        categories={categories}
        exportHref={null}
        showClear={false}
      />,
    );
    // Month (its popover button only: the ‹ › links stay), Wallet, Type, Category.
    expect(html.match(/data-needs-js=""/g)).toHaveLength(4);
    // Without scripts the month label is a link to the <noscript> form's month select, with the same label.
    const fallback = /<noscript><a href="#no-script-month"[^>]*>(.*?)<\/a><\/noscript>/.exec(html);
    expect(fallback?.[1]).toContain('<span class="sr-only">Month: </span><span class="truncate">September 2026</span>');
    expect(html.match(/<noscript>/g)).toHaveLength(1);
    // The ‹ › step links are outside the hidden part.
    expect(html).toMatch(/aria-label="Previous month, August 2026 \(\[\)"/);
    expect(render({})).toContain('id="no-script-month"');
  });
});

function timeline(month: string, length: number, spent: Record<number, number>): MonthTimeline {
  return {
    days: Array.from({ length }, (_, i) => ({
      date: `${month}-${String(i + 1).padStart(2, "0")}`,
      expenseMinor: spent[i + 1] ?? 0,
      incomeMinor: 0,
    })),
    previousCumulativeMinor: [],
    largestDay: null,
  };
}

describe("DayStrip on phones", () => {
  const render = (selectedDate?: string) =>
    renderToStaticMarkup(
      <DayStrip
        month="2026-11"
        currency="EUR"
        timeline={timeline("2026-11", 30, { 3: 6420 })}
        today="2026-11-18"
        selectedDate={selectedDate}
        hrefFor={(d) => `/transactions?from=${d}&to=${d}`}
        monthHref="/transactions"
      />,
    );

  it("has a 'Pick a day' disclosure below sm with a 44px link per day, Monday first", () => {
    const html = render();
    expect(html).toContain('<details class="group mt-2 sm:hidden">');
    expect(html).toContain("Pick a day");
    const days = [...html.matchAll(/<a [^>]*class="relative mx-auto flex h-11 w-full max-w-11[^"]*"[^>]*>/g)];
    expect(days).toHaveLength(30);
    expect(html).toContain('aria-label="3 November: €64.20 spent"');
    // 1 November 2026 is a Sunday: six empty cells lead the first week.
    expect(html).toMatch(/<tr>(<td><\/td>){6}<td class="p-0"><a [^>]*aria-label="1 November/);
  });

  it("marks the selected day, whose link goes back to the whole month", () => {
    const html = render("2026-11-03");
    const tag = [...html.matchAll(/<a [^>]*>/g)]
      .map((m) => m[0])
      .filter((t) => t.includes("3 November: €64.20 spent. Shown"));
    // One in the bars, one in the picker; both link back to the month.
    expect(tag).toHaveLength(2);
    for (const t of tag) {
      expect(t).toContain('href="/transactions"');
      expect(t).toContain('aria-current="date"');
    }
  });
});

describe("row focus after a removal", () => {
  it("prefers the same row (moved within the list), then the next rows, then the previous ones", () => {
    expect(focusCandidates(["1", "2", "3", "4"], "2")).toEqual(["2", "3", "4", "1"]);
    expect(focusCandidates(["1", "2"], "2")).toEqual(["2", "1"]);
    expect(focusCandidates([], "9")).toEqual(["9"]);
  });

  it("picks the first candidate still present, or null for the list heading", () => {
    const present = new Set(["1", "4"]);
    expect(pickFocusTarget(focusCandidates(["1", "2", "3", "4"], "2"), (id) => present.has(id))).toBe("4");
    expect(pickFocusTarget(focusCandidates(["1", "2"], "2"), (id) => present.has(id))).toBe("1");
    expect(pickFocusTarget(focusCandidates(["2"], "2"), () => false)).toBeNull();
    // A save that moved the row to another day: it is back, so it keeps the focus.
    expect(pickFocusTarget(focusCandidates(["1", "2"], "2"), () => true)).toBe("2");
  });

  it("each row button carries its id for the focus lookup", () => {
    const html = renderToStaticMarkup(
      <ExpandableList>
        <ul>
          <ExpandableRow id="7" summary="Row" panelLabel="Edit" panel={<p>Panel</p>} />
        </ul>
      </ExpandableList>,
    );
    expect(html).toContain('data-expandable-row="7"');
  });
});
