import Link from "next/link";
import type { ReactNode } from "react";
import { DayBars, type DayBar } from "@/components/charts";
import { axisTicks, pickScale } from "@/lib/chart-scale";
import { dayMonthLabel } from "@/lib/day-labels";
import { formatMonth } from "@/lib/dates";
import { formatMoney } from "@/lib/money";
import { monthShortName } from "@/lib/overview";
import type { MonthTimeline } from "@/server/insights";

/**
 * The /transactions day strip: one bar per day of `month` (that day's expenses in `currency`, honouring the wallet
 * and category filters), each a link that narrows the list to that day; the selected day's bar is the accent and the
 * others muted, and its link goes back to the whole month. Days after today are drawn as `future`. One very large
 * day is capped (`pickScale`) like on the Overview. Text alternative: the bars' own `aria-label`s, in a labelled
 * `role="group"`.
 */
export function DayStrip({
  month,
  currency,
  timeline,
  today,
  selectedDate,
  hrefFor,
  monthHref,
  currencySwitch,
}: {
  month: string;
  currency: string;
  timeline: MonthTimeline;
  today: string;
  selectedDate?: string;
  /** The list narrowed to `date`. */
  hrefFor(date: string): string;
  /** The list for the whole month (the selected bar's link and "Show all of …"). */
  monthHref: string;
  currencySwitch?: ReactNode;
}) {
  const money = (minor: number) => formatMoney(minor, currency);
  const bars: DayBar[] = timeline.days.map((d) => ({
    date: d.date,
    value: d.expenseMinor,
    tone: d.date > today ? "future" : "accent",
  }));
  const scale = pickScale(bars);
  const largest = timeline.largestDay;
  const cap =
    scale.cappedDate !== undefined
      ? {
          date: scale.cappedDate,
          label: money(largest?.date === scale.cappedDate ? largest.amountMinor : (bars.find((b) => b.date === scale.cappedDate)?.value ?? 0)),
        }
      : undefined;
  const total = timeline.days.reduce((sum, d) => sum + d.expenseMinor, 0);
  const selected = selectedDate ? timeline.days.find((d) => d.date === selectedDate) : undefined;
  const monthLabel = formatMonth(month);
  const short = monthShortName(month);
  const length = timeline.days.length;
  const todayDay = today.slice(0, 7) === month ? Number(today.slice(8)) : null;
  const ticks = axisTicks(short, length, todayDay);

  return (
    <section aria-labelledby="day-strip-heading" className="mb-4 rounded-[18px] border border-border bg-surface px-4 py-3.5 sm:px-[18px]">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h2 id="day-strip-heading" className="text-[13px] font-semibold text-muted-foreground">
            Spent per day · {currency}
          </h2>
          <p className="text-[15px] font-bold text-foreground tabular-nums">
            {selected ? `${money(selected.expenseMinor)} on ${dayMonthLabel(selected.date)}` : `${money(total)} in ${monthLabel}`}
          </p>
          {selected && (
            <Link href={monthHref} scroll={false} className="text-[13px] font-semibold text-accent-hover hover:underline">
              Show all of {monthLabel}
            </Link>
          )}
        </div>
        {currencySwitch}
      </div>

      <div role="group" aria-label={`Each day of ${monthLabel}: select a day to list only that day`} className="mt-3">
        <DayBars
          days={bars}
          max={scale.max}
          cap={cap}
          height={cap ? 72 : 48}
          selectedDate={selectedDate}
          hrefFor={(date) => (date === selectedDate ? monthHref : hrefFor(date))}
          ariaLabelFor={(date, value) =>
            `${dayMonthLabel(date)}: ${money(value)} spent${date === selectedDate ? ". Shown; select to show the whole month" : ""}`
          }
        />
      </div>
      <div className="relative mt-1.5 h-4 text-[11px] text-muted-foreground" aria-hidden="true">
        {ticks.map((t) => {
          const centre = ((t.day - 0.5) / length) * 100;
          const style =
            t.day === 1 ? { left: 0 } : t.day === length ? { right: 0 } : { left: `${centre}%`, transform: "translateX(-50%)" };
          return (
            <span key={t.day} className="absolute top-0 whitespace-nowrap tabular-nums" style={style}>
              {t.label}
            </span>
          );
        })}
      </div>
    </section>
  );
}
