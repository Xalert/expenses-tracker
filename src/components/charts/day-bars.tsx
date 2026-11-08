import Link from "next/link";
import { cn } from "@/lib/cn";

export type DayBarTone = "accent" | "income" | "muted" | "future";
export type DayBar = { date: string; value: number; tone?: DayBarTone };

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
  cap?: { date: string; label: string };
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

/**
 * A row of per-day bars on a CSS grid (one column per day). Server-renderable: no client JS. Days with a value of 0
 * show a 2px stub so the month's shape stays readable. The parent supplies the text alternative unless `hrefFor`
 * makes the bars links.
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
            className="absolute top-0 z-10 max-w-[60%] truncate rounded-full bg-accent px-2 py-[3px] text-[11px] leading-none font-bold text-accent-foreground"
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
        className="grid min-h-0 flex-1 gap-[2px] sm:gap-[5px]"
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
          const bar = (
            <span
              className={cn(
                "absolute inset-x-0 bottom-0",
                d.value > 0 ? toneClass[tone] : tone === "future" ? "bg-chart-future" : "bg-border",
                capped ? "rounded-none" : "rounded-t-[3px] sm:rounded-t-[4px]",
              )}
              style={{ height: d.value > 0 ? `max(${pct}%, 3px)` : "2px" }}
            >
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
              className="relative rounded-[4px] hover:opacity-80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
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
