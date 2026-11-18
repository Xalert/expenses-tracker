import Link from "next/link";
import { cn } from "@/lib/cn";

export type DayBarTone = "accent" | "income" | "muted" | "future";
export type DayBar = {
  date: string;
  /** The bar's full height (with `base`, the total of both segments). */
  value: number;
  tone?: DayBarTone;
  /**
   * A lower segment of a stacked bar, drawn from the bottom in its own tone; the rest of the bar (`value − base`)
   * keeps `tone`. The wallet chart stacks money in (top, income) over money out (bottom, accent).
   */
  base?: { value: number; tone: DayBarTone };
};

/**
 * The capped day's label pill: `accent` (the default, spending) or a direction — `income` / `expense` (the wallet
 * chart's "In …" / "Out …"). With a selected day other than the capped one the pill is muted, like its bar.
 */
export type CapTone = "accent" | "income" | "expense";

export type DayBarsProps = {
  /** One entry per day, in order; `value` in minor units (or any non-negative number). */
  days: DayBar[];
  /** The value drawn at full height; defaults to the largest value. Bars above it are clipped to full height. */
  max?: number;
  /**
   * One day drawn at full height with a "broken" top and a pill label above it ("Rent €1,150.00") — use
   * `pickScale` (`lib/chart-scale.ts`) to decide it and the `max` for the other days. The bar row then leaves room
   * for the label at the top.
   */
  cap?: { date: string; label: string; tone?: CapTone };
  /** A selected day: it is drawn in the accent colour and every other bar in `--border-strong`. */
  selectedDate?: string;
  /** With it, every bar is a link (`aria-label` from `ariaLabelFor`); without it the bars are `aria-hidden`. */
  hrefFor?(date: string): string;
  ariaLabelFor(date: string, value: number): string;
  /** Height in px; without it the row fills its parent's height (size it with `className`). */
  height?: number;
  className?: string;
};

const toneClass: Record<DayBarTone, string> = {
  accent: "bg-accent",
  income: "bg-income",
  muted: "bg-border-strong",
  future: "bg-chart-future",
};

const capToneClass: Record<CapTone | "muted", string> = {
  accent: "bg-accent text-accent-foreground",
  income: "bg-income text-surface",
  expense: "bg-expense text-surface",
  muted: "bg-border-strong text-foreground",
};

/** The cap pill's tone: muted when another day is selected, else the cap's own tone (accent by default). */
export function capPillTone(cap: { date: string; tone?: CapTone }, selectedDate?: string): CapTone | "muted" {
  return selectedDate && cap.date !== selectedDate ? "muted" : (cap.tone ?? "accent");
}

/**
 * A row of per-day bars on a CSS grid (one column per day). Server-renderable: no client JS. Days with a value of 0
 * show a 2px stub so the month's shape stays readable. The parent supplies the text alternative unless `hrefFor`
 * makes the bars links. As links the columns touch (no grid gap): each link fills its whole column and the full
 * height of the bar row, so the hit areas tile the row without holes, and the visible gap between bars is an inset
 * of the bar inside its link.
 */
export function DayBars({ days, max, cap, selectedDate, hrefFor, ariaLabelFor, height, className }: DayBarsProps) {
  const scaleMax = max ?? days.reduce((m, d) => Math.max(m, d.value), 0);
  const n = Math.max(days.length, 1);
  const capIndex = cap ? days.findIndex((d) => d.date === cap.date) : -1;
  const interactive = typeof hrefFor === "function";

  return (
    <div
      className={cn("flex flex-col", height === undefined && "h-full", className)}
      style={height !== undefined ? { height } : undefined}
      aria-hidden={interactive ? undefined : true}
    >
      {capIndex >= 0 && cap && (
        <div className="relative h-6 shrink-0">
          <span
            data-cap-tone={capPillTone(cap, selectedDate)}
            className={cn(
              "absolute top-0 z-10 max-w-[60%] truncate rounded-full px-2 py-[3px] text-[11px] leading-none font-bold",
              capToneClass[capPillTone(cap, selectedDate)],
            )}
            style={
              capIndex < n / 2
                ? { left: `${(capIndex / n) * 100}%` }
                : { right: `${((n - 1 - capIndex) / n) * 100}%` }
            }
          >
            {cap.label}
          </span>
        </div>
      )}
      <div
        className={cn("grid min-h-0 flex-1", interactive ? "gap-0" : "gap-[2px] sm:gap-[5px]")}
        style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))`, gridTemplateRows: "minmax(0, 1fr)" }}
      >
        {days.map((d, i) => {
          const capped = i === capIndex;
          const tone: DayBarTone = selectedDate
            ? d.date === selectedDate
              ? "accent"
              : "muted"
            : (d.tone ?? "accent");
          const pct = capped ? 100 : scaleMax > 0 ? Math.min(100, (d.value / scaleMax) * 100) : 0;
          // The lower segment's share of the drawn bar; dropped when a day is selected (one colour per bar then).
          const basePct =
            d.base && d.base.value > 0 && d.value > 0 && !selectedDate ? Math.min(100, (d.base.value / d.value) * 100) : 0;
          const bar = (
            <span
              className={cn(
                "absolute bottom-0",
                // As links, the 2px / 5px gap between bars is drawn inside each link (1px / 2.5px a side).
                interactive ? "inset-x-px sm:inset-x-[2.5px]" : "inset-x-0",
                d.value > 0 ? toneClass[tone] : tone === "future" ? "bg-chart-future" : "bg-border",
                capped ? "rounded-none" : "rounded-t-[3px] sm:rounded-t-[4px]",
              )}
              style={{ height: d.value > 0 ? `max(${pct}%, 3px)` : "2px" }}
            >
              {basePct > 0 && d.base && (
                <span
                  className={cn("absolute inset-x-0 bottom-0", toneClass[d.base.tone], basePct >= 100 && "rounded-[inherit]")}
                  style={{ height: `${basePct}%` }}
                />
              )}
              {capped && (
                // The "broken axis" mark: a gap near the top says the bar is taller than drawn.
                <span className="absolute inset-x-0 top-[6px] h-[3px] bg-surface" />
              )}
            </span>
          );
          return interactive ? (
            <Link
              key={d.date}
              href={hrefFor(d.date)}
              scroll={false}
              aria-label={ariaLabelFor(d.date, d.value)}
              aria-current={d.date === selectedDate ? "date" : undefined}
              className="relative block h-full rounded-[4px] hover:opacity-80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              {bar}
            </Link>
          ) : (
            <span key={d.date} className="relative">
              {bar}
            </span>
          );
        })}
      </div>
    </div>
  );
}
