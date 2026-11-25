import Link from "next/link";
import { ChevronIcon } from "@/components/ui/picker-icons";
import { cn } from "@/lib/cn";

const arrow =
  "inline-flex size-11 items-center justify-center rounded-[11px] text-muted-foreground transition-colors " +
  "hover:bg-surface-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/**
 * "‹ 2026 ›" — the year lives in the URL (`?year=YYYY`, left out for the current year); no stepping past `maxYear`
 * (the user's current year). Plain links, so it works without JavaScript; 44px arrows. "This year" goes back.
 * `hrefFor(year)` builds each link (`reportsHref`, which keeps the currency and the view).
 */
export function YearStepper({
  year,
  maxYear,
  hrefFor,
}: {
  year: string;
  maxYear: string;
  hrefFor(year: string): string;
}) {
  const prev = String(Number(year) - 1);
  const next = String(Number(year) + 1);
  const hasPrev = Number(prev) >= 1900;
  const hasNext = next <= maxYear;
  return (
    <nav aria-label="Year" className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
      {year !== maxYear && (
        <Link href={hrefFor(maxYear)} scroll={false} className="text-xs font-medium text-accent hover:underline">
          This year
        </Link>
      )}
      <div className="flex items-center rounded-xl border border-border bg-surface shadow-xs">
        {hasPrev ? (
          <Link href={hrefFor(prev)} className={arrow} aria-label={`Previous year, ${prev}`} scroll={false}>
            <ChevronIcon dir="left" />
          </Link>
        ) : (
          <span className={cn(arrow, "pointer-events-none opacity-40")} aria-hidden="true">
            <ChevronIcon dir="left" />
          </span>
        )}
        <span className="min-w-14 px-1 text-center text-sm font-semibold text-foreground tabular-nums">
          {year}
        </span>
        {hasNext ? (
          <Link href={hrefFor(next)} className={arrow} aria-label={`Next year, ${next}`} scroll={false}>
            <ChevronIcon dir="right" />
          </Link>
        ) : (
          <span className={cn(arrow, "pointer-events-none opacity-40")} aria-hidden="true">
            <ChevronIcon dir="right" />
          </span>
        )}
      </div>
    </nav>
  );
}
