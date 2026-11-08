import { RAMP_BG, percentLabel, type SpendingSplit } from "@/lib/category-split";
import { cn } from "@/lib/cn";
import { formatMonth } from "@/lib/dates";
import { formatMoney } from "@/lib/money";
import { monthName } from "@/lib/overview";

/**
 * The /categories "Spending split" card: the month's expenses in one currency, one segmented bar (a ramp colour per
 * expense category, largest first; decorative, `aria-hidden`) and its legend (swatch, name, share), which carries the
 * same information as text. Categories with nothing this month are left out of both.
 */
export function SpendingSplitCard({ split, month, currency }: { split: SpendingSplit; month: string; currency: string }) {
  const { segments } = split;
  return (
    <section
      aria-labelledby="spending-split-heading"
      className="rounded-[20px] border border-border bg-surface p-4 sm:px-6 sm:py-5"
    >
      <h2 id="spending-split-heading" className="text-[13px] font-semibold text-muted-foreground">
        Spending split
      </h2>
      {segments.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">
          Nothing spent in {formatMonth(month)} in {currency}.
        </p>
      ) : (
        <>
          <p className="mt-1 text-[22px] leading-tight font-extrabold tracking-[-0.02em] text-foreground tabular-nums">
            {formatMoney(split.totalMinor, currency)}{" "}
            <span className="text-sm font-semibold tracking-normal text-muted-foreground">
              spent in {monthName(month)}
            </span>
          </p>
          <div aria-hidden="true" className="mt-3 flex h-3.5 gap-[3px]">
            {segments.map((s) => (
              <span
                key={s.id}
                className={cn("block min-w-1 rounded-[5px]", RAMP_BG[s.ramp])}
                style={{ flexGrow: s.amountMinor, flexBasis: 0 }}
              />
            ))}
          </div>
          <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-[13px]">
            {segments.map((s) => (
              <li key={s.id} className="flex max-w-full min-w-0 items-center gap-1.5">
                <span aria-hidden="true" className={cn("size-2.5 shrink-0 rounded-[3px]", RAMP_BG[s.ramp])} />
                <span className="truncate font-semibold text-foreground">{s.name}</span>
                <span className="shrink-0 text-muted-foreground tabular-nums">{percentLabel(s.percent, s.amountMinor)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
