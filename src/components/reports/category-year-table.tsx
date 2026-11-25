import Link from "next/link";
import { cn } from "@/lib/cn";
import { MONTH_LABELS } from "@/lib/calendar";
import { formatMonth } from "@/lib/dates";
import { formatMoney } from "@/lib/money";
import { wholeUnits } from "@/lib/reports";
import type { ReportCategoryRow } from "@/server/reports";

/** Where a cell leads: /transactions filtered to the category (or kind) and the month (or the whole year). */
export type CellHrefs = {
  cell(categoryId: number, month: string): string;
  rowTotal(categoryId: number): string;
  monthTotal(month: string): string;
};

const cellLink =
  "flex min-h-11 items-center justify-end px-2.5 hover:bg-surface-muted hover:underline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring";
const stickyCol = "sticky left-0 z-10 bg-surface";

/**
 * One kind's categories by month: a row per category (largest first), a column per month, row and column totals.
 * Amounts are whole units of `currency` (`wholeUnits`); each link's accessible name and `title` carry the exact
 * amount. Non-zero cells link to /transactions for that category and month; a zero cell is a muted dash. On a narrow
 * screen the table scrolls sideways inside its card, the category column stays put (`sticky`), and the page itself
 * never scrolls sideways.
 */
export function CategoryYearTable({
  kind,
  year,
  currency,
  rows,
  monthTotals,
  total,
  elapsed,
  hrefs,
}: {
  kind: "expense" | "income";
  year: string;
  currency: string;
  rows: ReportCategoryRow[];
  /** Twelve column totals, January first. */
  monthTotals: number[];
  total: number;
  /** Months that have begun (later columns are shown muted). */
  elapsed: number;
  hrefs: CellHrefs;
}) {
  const title = kind === "expense" ? "Expenses by category" : "Income by category";
  const headingId = `${kind}-by-category`;
  const money = (minor: number) => formatMoney(minor, currency);
  const months = MONTH_LABELS.map((_, i) => `${year}-${String(i + 1).padStart(2, "0")}`);
  const amountTone = kind === "income" ? "text-income" : "text-foreground";

  const amount = (minor: number, href: string, label: string, strong = false) =>
    minor === 0 ? (
      <span className="flex min-h-11 items-center justify-end px-2.5 text-muted-foreground">
        <span aria-hidden="true">–</span>
        <span className="sr-only">nothing</span>
      </span>
    ) : (
      <Link href={href} className={cn(cellLink, strong ? "font-bold" : "font-medium", amountTone)} aria-label={`${label}: ${money(minor)}`} title={money(minor)}>
        {wholeUnits(minor, currency)}
      </Link>
    );

  return (
    <section aria-labelledby={headingId} className="min-w-0 overflow-hidden rounded-[20px] border border-border bg-surface">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 pt-4 pb-3 sm:px-5">
        <h2 id={headingId} className="text-base font-semibold text-foreground">
          {title}
        </h2>
        <p className="text-xs text-muted-foreground">
          {currency}, whole units · <span className="md:hidden">scroll sideways for every month · </span>each amount opens its entries
        </p>
      </div>
      {rows.length === 0 ? (
        <p className="px-4 pb-5 text-sm text-muted-foreground sm:px-5">
          {kind === "expense" ? `Nothing spent in ${year}.` : `No income in ${year}.`}
        </p>
      ) : (
        // `relative`: the sr-only caption is absolutely positioned and would otherwise escape the scroller and widen
        // the page by the table's width.
        <div className="relative overflow-x-auto overscroll-x-contain pb-2">
          <table className="w-full border-separate border-spacing-0 text-[13px] tabular-nums">
            <caption className="sr-only">
              {title}, {year}, in {currency}
            </caption>
            <thead>
              <tr className="text-xs text-muted-foreground">
                <th scope="col" className={cn(stickyCol, "border-b border-border px-4 py-2 text-left font-semibold sm:px-5")}>
                  Category
                </th>
                {months.map((m, i) => (
                  <th
                    key={m}
                    scope="col"
                    className={cn("border-b border-border px-2.5 py-2 text-right font-semibold", i >= elapsed && "text-muted-foreground/60")}
                  >
                    <abbr title={formatMonth(m)} className="no-underline">
                      {MONTH_LABELS[i]}
                    </abbr>
                  </th>
                ))}
                <th scope="col" className="border-b border-border px-2.5 py-2 pr-4 text-right font-semibold sm:pr-5">
                  Total
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.categoryId}>
                  <th
                    scope="row"
                    className={cn(stickyCol, "max-w-[8.5rem] border-b border-surface-muted px-4 text-left font-semibold text-foreground sm:max-w-[14rem] sm:px-5")}
                  >
                    <span className="block truncate" title={r.name}>
                      {r.name}
                    </span>
                    {r.archived && <span className="block text-[11px] font-normal text-muted-foreground">archived</span>}
                  </th>
                  {r.months.map((v, i) => (
                    <td key={months[i]} className="border-b border-surface-muted p-0">
                      {amount(v, hrefs.cell(r.categoryId, months[i]), `${r.name}, ${formatMonth(months[i])}`)}
                    </td>
                  ))}
                  <td className="border-b border-surface-muted bg-surface-muted/40 p-0 pr-2 sm:pr-3">
                    {amount(r.totalMinor, hrefs.rowTotal(r.categoryId), `${r.name}, all of ${year}`, true)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row" className={cn(stickyCol, "px-4 text-left font-bold text-foreground sm:px-5")}>
                  Total
                </th>
                {monthTotals.map((v, i) => (
                  <td key={months[i]} className="p-0">
                    {amount(v, hrefs.monthTotal(months[i]), `${title}, ${formatMonth(months[i])}`, true)}
                  </td>
                ))}
                <td className="bg-surface-muted/40 p-0 pr-2 sm:pr-3">
                  <span className={cn("flex min-h-11 items-center justify-end px-2.5 font-extrabold", amountTone)} title={money(total)}>
                    <span aria-hidden="true">{wholeUnits(total, currency)}</span>
                    <span className="sr-only">{money(total)}</span>
                  </span>
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </section>
  );
}
