import Link from "next/link";
import { cn } from "@/lib/cn";
import { formatMonth, shiftMonth } from "@/lib/dates";

const arrow =
  "inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors " +
  "hover:bg-surface-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/** "‹ November 2026 ›" — the month lives in the URL (`?month=YYYY-MM`); no navigating past `maxMonth`. */
export function MonthSwitcher({ month, maxMonth, basePath = "/" }: { month: string; maxMonth: string; basePath?: string }) {
  const prev = shiftMonth(month, -1);
  const next = shiftMonth(month, 1);
  const href = (m: string) => (m === maxMonth ? basePath : `${basePath}?month=${m}`);
  const hasNext = next <= maxMonth;

  return (
    <div className="flex items-center gap-1 rounded-xl border border-border bg-surface p-1 shadow-xs">
      <Link href={href(prev)} className={arrow} aria-label={`Previous month, ${formatMonth(prev)}`} scroll={false}>
        <Chevron dir="left" />
      </Link>
      <p className="min-w-32 text-center text-sm font-medium text-foreground tabular-nums" aria-live="polite">
        {formatMonth(month)}
      </p>
      {hasNext ? (
        <Link href={href(next)} className={arrow} aria-label={`Next month, ${formatMonth(next)}`} scroll={false}>
          <Chevron dir="right" />
        </Link>
      ) : (
        <span className={cn(arrow, "pointer-events-none opacity-40")} aria-hidden="true">
          <Chevron dir="right" />
        </span>
      )}
    </div>
  );
}

function Chevron({ dir }: { dir: "left" | "right" }) {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className="size-4" aria-hidden="true">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d={
          dir === "left"
            ? "M11.78 5.22a.75.75 0 0 1 0 1.06L8.06 10l3.72 3.72a.75.75 0 1 1-1.06 1.06l-4.25-4.25a.75.75 0 0 1 0-1.06l4.25-4.25a.75.75 0 0 1 1.06 0Z"
            : "M8.22 5.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L11.94 10 8.22 6.28a.75.75 0 0 1 0-1.06Z"
        }
      />
    </svg>
  );
}
