import { cn } from "@/lib/cn";

export type RunningLineTone = "foreground" | "muted" | "accent";
export type RunningLineSeries = {
  values: number[];
  tone: RunningLineTone;
  dashed?: boolean;
  /** The value at the left edge, before day 1 (default 0; a balance line starts at the opening balance). */
  start?: number;
};

export type RunningLineProps = {
  /** Already cumulative (or any running value); index 0 = day 1. A series longer than `days` is cut. */
  series: RunningLineSeries[];
  /** The value at the top of the box. */
  max: number;
  /** The value at the bottom of the box (default 0). A balance line passes its own range, which may be negative. */
  min?: number;
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

/**
 * The `points` of one series: a start on the left edge (`start`, default 0), then one point per day at the middle of
 * its column. y runs from `min` (bottom, default 0) to `max` (top); values outside are clamped to the box.
 */
export function linePoints(values: number[], max: number, days: number, min = 0, start = 0): string {
  const span = max - min;
  const y = (v: number) => (span > 0 ? H - (Math.min(span, Math.max(0, v - min)) / span) * H : H);
  const pts = [`0,${+y(start).toFixed(2)}`];
  values.slice(0, days).forEach((v, i) => pts.push(`${i * COL + COL / 2},${+y(v).toFixed(2)}`));
  return pts.join(" ");
}

/**
 * Lines over a month chart: an absolutely positioned inline SVG filling its (relative) parent, stretched with
 * `preserveAspectRatio="none"`; strokes keep their width (`vector-effect: non-scaling-stroke`). x = day column (the
 * same columns as `DayBars` without its gaps), y scaled to `max`. Server-renderable. `role="img"` with `ariaLabel`.
 */
export function RunningLine({ series, max, min = 0, days, ariaLabel, className }: RunningLineProps) {
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
          points={linePoints(s.values, max, days, min, s.start ?? min)}
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
