import Link from "next/link";
import { cn } from "@/lib/cn";
import { MONTH_LABELS } from "@/lib/calendar";
import { formatMonth } from "@/lib/dates";
import { formatMoney } from "@/lib/money";
import { compactMoney } from "@/lib/reports";
import type { ReportMonth } from "@/server/reports";

/**
 * The /reports month chart: twelve pairs of bars (income in `--income`, expenses in `--accent`, one scale: the
 * largest month), and under the month labels a row of net bars (up in `--income`, down in `--expense`, on their own
 * scale) with the net written under each month from `sm` up. Months after the current one are drawn as not yet
 * happened (`--chart-future`) and are not links; every other month links to that month on the Overview (`hrefFor`).
 *
 * Text alternative: the bars are a `role="img"` with a summary `aria-label`; each month's link names its figures;
 * a visually hidden table lists every month. The links sit under the drawing (the bars are `pointer-events-none`),
 * so hovering a month shades its whole column.
 */
export function YearChart({
  year,
  currency,
  months,
  elapsed,
  hrefFor,
}: {
  year: string;
  currency: string;
  months: ReportMonth[];
  /** Months that have begun: 12 for a past year, the current month's number for the current year. */
  elapsed: number;
  hrefFor(month: string): string;
}) {
  const money = (minor: number, signed = false) => formatMoney(minor, currency, { signed });
  const max = months.reduce((m, x) => Math.max(m, x.incomeMinor, x.expenseMinor), 0);
  const netMax = months.reduce((m, x) => Math.max(m, Math.abs(x.netMinor)), 0);
  const pct = (v: number, of: number) => (of > 0 && v > 0 ? `max(${Math.min(100, (v / of) * 100)}%, 3px)` : "2px");

  const happened = months.slice(0, elapsed);
  const top = (key: "incomeMinor" | "expenseMinor") =>
    happened.reduce<ReportMonth | null>((best, m) => (m[key] > 0 && (!best || m[key] > best[key]) ? m : best), null);
  const topSpend = top("expenseMinor");
  const topIncome = top("incomeMinor");
  const name = (m: ReportMonth) => MONTH_LABELS[Number(m.month.slice(5)) - 1];
  const summary = [
    `Income and expenses per month in ${currency}, ${year}.`,
    topSpend ? `Most spent: ${name(topSpend)}, ${money(topSpend.expenseMinor)}.` : "Nothing spent.",
    topIncome ? `Most income: ${name(topIncome)}, ${money(topIncome.incomeMinor)}.` : "No income.",
    elapsed === 11 ? "December has not happened yet." : elapsed < 11 ? `${MONTH_LABELS[elapsed]} to Dec have not happened yet.` : "",
  ]
    .filter(Boolean)
    .join(" ");

  const cols = { gridTemplateColumns: "repeat(12, minmax(0, 1fr))" };

  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label="Legend">
        <li className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-[3px] bg-income" aria-hidden="true" />
          Income
        </li>
        <li className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-[3px] bg-accent" aria-hidden="true" />
          Expenses
        </li>
        <li className="flex items-center gap-1.5">
          <span className="flex h-2.5 items-end gap-px" aria-hidden="true">
            <span className="h-2.5 w-1 rounded-[1px] bg-income" />
            <span className="h-1.5 w-1 translate-y-1 rounded-[1px] bg-expense" />
          </span>
          Net (own scale)
        </li>
      </ul>

      <div className="relative">
        {/* Hit areas: one link per month that has begun, the full height of the chart, under the drawing. */}
        <ol className="absolute inset-0 grid" style={cols}>
          {months.map((m, i) => (
            <li key={m.month} className="flex">
              {i < elapsed ? (
                <Link
                  href={hrefFor(m.month)}
                  aria-label={`${formatMonth(m.month)}: income ${money(m.incomeMinor)}, expenses ${money(m.expenseMinor)}, net ${money(m.netMinor, true)}. Open on the Overview`}
                  title={`${formatMonth(m.month)} · in ${money(m.incomeMinor)} · out ${money(m.expenseMinor)} · net ${money(m.netMinor, true)}`}
                  className="block w-full rounded-[8px] hover:bg-surface-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                />
              ) : (
                <span className="sr-only">{formatMonth(m.month)}: not yet</span>
              )}
            </li>
          ))}
        </ol>

        <div className="pointer-events-none relative">
          <div className="relative h-[150px] border-b border-border sm:h-[220px]">
            {max > 0 && (
              <span className="absolute top-0 left-0 text-[11px] leading-none text-muted-foreground tabular-nums" aria-hidden="true">
                {compactMoney(max, currency)}
              </span>
            )}
            <div role="img" aria-label={summary} className="absolute inset-x-0 top-4 bottom-0 grid" style={cols}>
              {months.map((m, i) => {
                const future = i >= elapsed;
                return (
                  <span key={m.month} className="flex items-end justify-center gap-[2px] px-[3px] sm:gap-1 sm:px-2" data-future={future || undefined}>
                    <span
                      className={cn("w-1/2 max-w-5 rounded-t-[3px] sm:rounded-t-[4px]", future ? "bg-chart-future" : m.incomeMinor > 0 ? "bg-income" : "bg-border")}
                      style={{ height: pct(m.incomeMinor, max) }}
                    />
                    <span
                      className={cn("w-1/2 max-w-5 rounded-t-[3px] sm:rounded-t-[4px]", future ? "bg-chart-future" : m.expenseMinor > 0 ? "bg-accent" : "bg-border")}
                      style={{ height: pct(m.expenseMinor, max) }}
                    />
                  </span>
                );
              })}
            </div>
          </div>

          <div className="grid pt-1.5 text-center text-[11px] leading-4" style={cols} aria-hidden="true">
            {months.map((m, i) => (
              <span
                key={m.month}
                className={cn(
                  "truncate",
                  i === elapsed - 1 && elapsed < 12 ? "font-bold text-foreground" : i >= elapsed ? "text-muted-foreground/60" : "text-muted-foreground",
                )}
              >
                {MONTH_LABELS[i]}
              </span>
            ))}
          </div>

          <div className="mt-2 grid h-10 border-y border-dashed border-border" style={cols} aria-hidden="true">
            {months.map((m, i) => {
              const h = netMax > 0 && m.netMinor !== 0 ? `max(${(Math.abs(m.netMinor) / netMax) * 50}%, 2px)` : "0px";
              return (
                <span key={m.month} className="relative">
                  {i < elapsed && m.netMinor !== 0 && (
                    <span
                      className={cn(
                        "absolute left-1/2 w-2.5 -translate-x-1/2 sm:w-4",
                        m.netMinor > 0 ? "bottom-1/2 rounded-t-[2px] bg-income" : "top-1/2 rounded-b-[2px] bg-expense",
                      )}
                      style={{ height: h }}
                    />
                  )}
                </span>
              );
            })}
          </div>
          <div className="hidden pt-1 text-center text-[11px] leading-4 font-semibold tabular-nums sm:grid" style={cols} aria-hidden="true">
            {months.map((m, i) => (
              <span
                key={m.month}
                className={cn(
                  "truncate",
                  i >= elapsed || m.netMinor === 0 ? "text-muted-foreground" : m.netMinor > 0 ? "text-income" : "text-expense",
                )}
              >
                {i < elapsed ? compactMoney(m.netMinor, currency, { signed: true }) : "·"}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* sr-only on a wrapper, not on the <table> (see MonthChart). */}
      <div className="sr-only">
        <table>
          <caption>
            Each month of {year} in {currency}
          </caption>
          <thead>
            <tr>
              <th scope="col">Month</th>
              <th scope="col">Income</th>
              <th scope="col">Expenses</th>
              <th scope="col">Net</th>
            </tr>
          </thead>
          <tbody>
            {months.map((m, i) => (
              <tr key={m.month}>
                <th scope="row">{formatMonth(m.month)}</th>
                {i < elapsed || m.incomeMinor || m.expenseMinor ? (
                  <>
                    <td>{money(m.incomeMinor)}</td>
                    <td>{money(m.expenseMinor)}</td>
                    <td>{money(m.netMinor, true)}</td>
                  </>
                ) : (
                  <td colSpan={3}>Not yet</td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
