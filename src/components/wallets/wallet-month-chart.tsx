import { DayBars, RunningLine } from "@/components/charts";
import { axisTicks } from "@/lib/chart-scale";
import { formatMoney } from "@/lib/money";
import { monthLength, monthName, monthShortName } from "@/lib/overview";
import { balanceRange, walletBars } from "@/lib/wallet-chart";
import type { WalletMonth } from "@/server/insights";

/**
 * A wallet's month chart: one stacked bar per day (money out at the bottom in the accent colour, money in on top in
 * `--income`, transfers included; one very large day capped and labelled) under the balance line (each day's closing
 * balance, starting from the opening balance on the left edge). The bars and the line share the box, not the scale:
 * the line is scaled to the month's lowest and highest balance with some headroom (`balanceRange`), the bars to the
 * largest ordinary day. Text alternative: the line's `aria-label` summary plus a visually hidden table of the days.
 */
export function WalletMonthChart({
  walletName,
  month,
  currency,
  data,
  isCurrentMonth,
}: {
  walletName: string;
  month: string;
  currency: string;
  data: WalletMonth;
  isCurrentMonth: boolean;
}) {
  const length = monthLength(month);
  const short = monthShortName(month);
  const money = (minor: number) => formatMoney(minor, currency);
  const closings = data.days.map((d) => d.closingMinor);
  const range = balanceRange(data.openingMinor, closings);
  const { bars, max, cap } = walletBars(month, data.days, currency);
  const dayN = data.days.length;
  const last = data.days.at(-1);

  const monthTitle = `${monthName(month)} ${month.slice(0, 4)}`;
  const summary =
    dayN === 0
      ? `Balance of ${walletName} in ${monthTitle}: no days to show yet.`
      : [
          `Balance of ${walletName} in ${monthTitle}: ${money(data.openingMinor)} at the start, ${money(last!.closingMinor)} ${
            isCurrentMonth ? `on ${dayN} ${short}` : "at the end"
          }; lowest ${money(Math.min(data.openingMinor, ...closings))}, highest ${money(
            Math.max(data.openingMinor, ...closings),
          )}.`,
          `${money(data.outMinor)} out and ${money(data.inMinor)} in over the month.`,
          "Bars show money out and in each day; the line shows the balance on its own scale.",
        ].join(" ");

  const ticks = axisTicks(short, length, isCurrentMonth ? dayN : null);

  return (
    <div className="flex flex-col gap-3">
      <ul
        className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground"
        aria-label="Legend"
        title="Bars and the line share the box but not the scale: bars are each day's money out and in, the line the balance."
      >
        <li className="flex items-center gap-1.5">
          <span className="h-0.5 w-4 rounded-full bg-foreground" aria-hidden="true" />
          Balance
        </li>
        <li className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-[3px] bg-accent" aria-hidden="true" />
          Out
        </li>
        <li className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-[3px] bg-income" aria-hidden="true" />
          In
        </li>
      </ul>

      <div className="relative h-[160px] sm:h-[220px]">
        <div className="absolute inset-0">
          <DayBars
            days={bars}
            max={max}
            cap={cap}
            ariaLabelFor={(date, value) => `${Number(date.slice(8))} ${short}: ${money(value)}`}
          />
        </div>
        <RunningLine
          days={length}
          min={range.min}
          max={range.max}
          ariaLabel={summary}
          series={[{ values: closings, tone: "foreground", start: data.openingMinor }]}
        />
      </div>

      <div className="relative h-4 text-[11px] text-muted-foreground" aria-hidden="true">
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

      <table className="sr-only">
        <caption>
          Each day of {monthTitle} in {walletName}
        </caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            <th scope="col">Out</th>
            <th scope="col">In</th>
            <th scope="col">Balance after</th>
          </tr>
        </thead>
        <tbody>
          {data.days.map((d) => (
            <tr key={d.date}>
              <th scope="row">
                {Number(d.date.slice(8))} {short}
              </th>
              <td>{money(d.outMinor)}</td>
              <td>{money(d.inMinor)}</td>
              <td>{money(d.closingMinor)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
