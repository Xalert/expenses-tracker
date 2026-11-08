import { DayBars, RunningLine, type DayBar } from "@/components/charts";
import { axisTicks, cumulative, pickScale } from "@/lib/chart-scale";
import { formatMoney } from "@/lib/money";
import { monthName, monthShortName } from "@/lib/overview";
import type { MonthTimeline } from "@/server/insights";

/** Share of the bar area the tallest ordinary bar reaches. */
const BAR_SHARE = 0.6;

/**
 * The Overview month chart for one currency: a bar per day (that day's expenses; days after day N in
 * `--chart-future`), the running total of expenses through day N (solid) and the previous month's (dashed). The bars
 * and the lines share the box but not the scale: bars are per day, lines are cumulative. One very large day is capped
 * (`pickScale`). Text alternative: the lines' `aria-label` summary plus a visually hidden table of the days.
 */
export function MonthChart({
  month,
  previousMonth,
  currency,
  timeline,
  dayN,
  isCurrentMonth,
}: {
  month: string;
  previousMonth: string;
  currency: string;
  timeline: MonthTimeline;
  /** Today's day for the current month, the last day for a past month. */
  dayN: number;
  isCurrentMonth: boolean;
}) {
  const length = timeline.days.length;
  const money = (minor: number) => formatMoney(minor, currency);
  const short = monthShortName(month);
  const previousShort = monthShortName(previousMonth);

  const bars: DayBar[] = timeline.days.map((d, i) => ({
    date: d.date,
    value: d.expenseMinor,
    tone: i < dayN ? "accent" : "future",
  }));
  const scale = pickScale(bars);
  // The bars keep to the lower part of the box so the running-total lines above them stay readable; only a capped
  // day reaches the top (under its label).
  const barMax = scale.max / BAR_SHARE;
  const largest = timeline.largestDay;
  const cap =
    scale.cappedDate !== undefined
      ? {
          date: scale.cappedDate,
          label:
            largest && largest.date === scale.cappedDate && largest.label
              ? `${largest.label} ${money(largest.amountMinor)}`
              : money(bars.find((b) => b.date === scale.cappedDate)?.value ?? 0),
        }
      : undefined;

  const current = cumulative(timeline.days.slice(0, dayN).map((d) => d.expenseMinor));
  const previous = timeline.previousCumulativeMinor.slice(0, length);
  const lineMax = Math.max(current.at(-1) ?? 0, previous.at(-1) ?? 0);

  const spentThroughN = current.at(-1) ?? 0;
  const comparedDay = Math.min(dayN, timeline.previousCumulativeMinor.length);
  const previousThroughN = comparedDay > 0 ? timeline.previousCumulativeMinor[comparedDay - 1] : 0;
  const summary = [
    `Spending in ${currency}, ${monthName(month)} ${month.slice(0, 4)}: ${money(spentThroughN)} ${
      isCurrentMonth ? `by ${dayN} ${short}` : "over the month"
    }, against ${money(previousThroughN)} by ${comparedDay} ${previousShort}.`,
    largest ? `Largest day: ${Number(largest.date.slice(8))} ${short}, ${money(largest.amountMinor)}${largest.label ? ` (${largest.label})` : ""}.` : "No spending this month.",
    "Bars show each day; the lines show running totals on their own scale.",
  ].join(" ");

  const ticks = axisTicks(short, length, isCurrentMonth ? dayN : null);
  const tableDays = timeline.days.filter((d, i) => i < dayN || d.expenseMinor > 0 || d.incomeMinor > 0);

  return (
    <div className="flex flex-col gap-3">
      <ul
        className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground"
        aria-label="Legend"
        title="Bars and lines share the box but not the scale: bars are each day's spending, lines the running totals."
      >
        <li className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-[3px] bg-accent" aria-hidden="true" />
          Each day
        </li>
        <li className="flex items-center gap-1.5">
          <span className="h-0.5 w-4 rounded-full bg-foreground" aria-hidden="true" />
          Running total
        </li>
        <li className="flex items-center gap-1.5">
          <span className="w-4 border-t-2 border-dashed border-border-strong" aria-hidden="true" />
          {monthName(previousMonth)}
        </li>
      </ul>

      <div className="relative h-[160px] sm:h-[240px]">
        <div className="absolute inset-0">
          <DayBars
            days={bars}
            max={barMax}
            cap={cap}
            ariaLabelFor={(date, value) => `${Number(date.slice(8))} ${short}: ${money(value)} spent`}
          />
        </div>
        <RunningLine
          days={length}
          max={lineMax}
          ariaLabel={summary}
          series={[
            { values: previous, tone: "muted", dashed: true },
            { values: current, tone: "foreground" },
          ]}
        />
      </div>

      <div className="relative h-4 text-[11px] text-muted-foreground" aria-hidden="true">
        {ticks.map((t) => {
          const centre = ((t.day - 0.5) / length) * 100;
          const style =
            t.day === 1
              ? { left: 0 }
              : t.day === length
                ? { right: 0 }
                : { left: `${centre}%`, transform: "translateX(-50%)" };
          return (
            <span key={t.day} className="absolute top-0 whitespace-nowrap tabular-nums" style={style}>
              {t.label}
            </span>
          );
        })}
      </div>

      <table className="sr-only">
        <caption>
          Each day of {monthName(month)} {month.slice(0, 4)} in {currency}
        </caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            <th scope="col">Spent</th>
            <th scope="col">Income</th>
          </tr>
        </thead>
        <tbody>
          {tableDays.map((d) => (
            <tr key={d.date}>
              <th scope="row">
                {Number(d.date.slice(8))} {short}
              </th>
              <td>{money(d.expenseMinor)}</td>
              <td>{money(d.incomeMinor)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
