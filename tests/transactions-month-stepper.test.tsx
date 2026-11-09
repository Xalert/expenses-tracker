import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }) }));

import { FilterChips } from "@/components/transactions/filter-chips";
import { MonthLinks } from "@/components/transactions/month-links";
import { parseListParams } from "@/components/transactions/list-params";

function render(sp: Record<string, string | undefined>, thisMonth = "2026-11") {
  return renderToStaticMarkup(
    <FilterChips
      params={parseListParams(sp)}
      thisMonth={thisMonth}
      wallets={[{ id: 2, name: "Cash", currency: "EUR", archived: false }]}
      categories={[]}
      exportHref={null}
      showClear={false}
    />,
  );
}

function hrefOf(html: string, label: string) {
  const tag = [...html.matchAll(/<a [^>]*>/g)].map((m) => m[0]).find((t) => t.includes(`aria-label="${label}"`));
  return tag?.match(/href="([^"]*)"/)?.[1]?.replaceAll("&amp;", "&");
}

describe("Month chip stepper", () => {
  it("shows both arrows in a single month, keeping filters and dropping the page", () => {
    const html = render({ month: "2026-10", wallet: "2", kind: "expense", q: "x", page: "3" });
    expect(html).toContain("Previous month, September 2026 ([)");
    const next = hrefOf(html, "Next month, November 2026 (])");
    expect(next).toBeDefined();
    expect(next).toContain("wallet=2");
    expect(next).toContain("kind=expense");
    expect(next).not.toContain("page=");
    expect(next).not.toContain("month="); // the current month is left out
    const prev = hrefOf(html, "Previous month, September 2026 ([)");
    expect(prev).toContain("month=2026-09");
  });

  it("does not cap next at the current month", () => {
    expect(render({}, "2026-11")).toContain("Next month, December 2026");
  });

  it("has no arrows for all time, a range or a single day", () => {
    for (const sp of [{ month: "all" }, { from: "2026-10-01", to: "2026-10-09" }, { from: "2026-10-05", to: "2026-10-05" }]) {
      expect(render(sp)).not.toContain("Previous month");
      expect(render(sp)).not.toContain("Next month");
    }
  });
});

describe("This month link", () => {
  const thisMonthHref = (html: string) =>
    [...html.matchAll(/<a [^>]*>This month<\/a>/g)].map((m) => m[0].match(/href="([^"]*)"/)?.[1]?.replaceAll("&amp;", "&"));

  it("is absent on the current month", () => {
    expect(thisMonthHref(render({}))).toEqual([]);
    expect(thisMonthHref(render({ month: "2026-11" }))).toEqual([]);
  });

  it("goes back to this month from another month, all time, a range or a day, keeping the other filters", () => {
    for (const sp of [
      { month: "2026-03", wallet: "2", page: "2" },
      { month: "all", wallet: "2" },
      { from: "2026-10-01", to: "2026-10-09", wallet: "2" },
      { from: "2026-10-05", to: "2026-10-05", wallet: "2" },
    ]) {
      const [href] = thisMonthHref(render(sp));
      expect(href).toBe("/transactions?wallet=2");
    }
  });
});

describe("MonthLinks (end of the list)", () => {
  const months = {
    prev: { label: "October 2026", href: "/transactions?month=2026-10" },
    next: { label: "December 2026", href: "/transactions?month=2026-12" },
  };
  const html = (page: number, lastPage: number, total = 120, m: typeof months | null = months) =>
    renderToStaticMarkup(<MonthLinks months={m} page={page} lastPage={lastPage} total={total} />);

  it("shows both links on the last page and on a single page", () => {
    for (const h of [html(3, 3), html(1, 1, 5)]) {
      expect(h).toContain('aria-label="Months"');
      expect(h).toContain("‹ October 2026");
      expect(h).toContain("December 2026 ›");
      expect(h).toContain('href="/transactions?month=2026-12"');
    }
  });

  it("adds This month in the middle only when given", () => {
    expect(html(3, 3)).not.toContain("This month");
    const h = renderToStaticMarkup(
      <MonthLinks months={months} page={1} lastPage={1} total={5} currentHref="/transactions" />,
    );
    expect(h).toMatch(/October 2026.*href="\/transactions"[^>]*>This month<.*December 2026/);
  });

  it("is absent before the last page, in other views and for an empty list", () => {
    expect(html(1, 3)).toBe("");
    expect(html(2, 3)).toBe("");
    expect(html(1, 1, 5, null)).toBe("");
    expect(html(1, 1, 0)).toBe("");
  });
});
