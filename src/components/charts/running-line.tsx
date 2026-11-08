import { cn } from "@/lib/cn";

export type RunningLineTone = "foreground" | "muted" | "accent";
export type RunningLineSeries = { values: number[]; tone: RunningLineTone; dashed?: boolean };

export type RunningLineProps = {
  /** Already cumulative (or any running value); index 0 = day 1. A series longer than `days` is cut. */
  series: RunningLineSeries[];
  /** The value at the top of the box. */
  max: number;
  /** Number of day columns the box is divided into (the month's length). */
  days: number;
  ariaLabel: string;
  className?: string;
};

const toneClass: Record<RunningLineTone, string> = {
  foreground: "text-foreground",
  muted: "text-border-strong",
  accent: "text-accent",
};

const COL = 20;
const H = 200;

/** The `points` of one series: a start at 0 on the left edge, then one point per day at the middle of its column. */
export function linePoints(values: number[], max: number, days: number): string {
  const y = (v: number) => (max > 0 ? H - (Math.max(0, v) / max) * H : H);
  const pts = [`0,${H}`];
  values.slice(0, days).forEach((v, i) => pts.push(`${i * COL + COL / 2},${+y(v).toFixed(2)}`));
  return pts.join(" ");
}

/**
 * Lines over a month chart: an absolutely positioned inline SVG filling its (relative) parent, stretched with
 * `preserveAspectRatio="none"`; strokes keep their width (`vector-effect: non-scaling-stroke`). x = day column (the
 * same columns as `DayBars` without its gaps), y scaled to `max`. Server-renderable. `role="img"` with `ariaLabel`.
 */
export function RunningLine({ series, max, days, ariaLabel, className }: RunningLineProps) {
  const width = Math.max(days, 1) * COL;
  return (
    <svg
      viewBox={`0 0 ${width} ${H}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={ariaLabel}
      className={cn("pointer-events-none absolute inset-0 h-full w-full overflow-visible", className)}
    >
      {series.map((s, i) => (
        <polyline
          key={i}
          points={linePoints(s.values, max, days)}
          fill="none"
          stroke="currentColor"
          strokeWidth={s.dashed ? 2 : 2.5}
          strokeDasharray={s.dashed ? "5 5" : undefined}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
          className={toneClass[s.tone]}
        />
      ))}
    </svg>
  );
}
