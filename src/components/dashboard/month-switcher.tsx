"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { MonthGrid } from "@/components/ui/month-grid";
import { ChevronIcon } from "@/components/ui/picker-icons";
import { Popover } from "@/components/ui/popover";
import { cn } from "@/lib/cn";
import { formatMonth, shiftMonth } from "@/lib/dates";

const arrow =
  "inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors " +
  "hover:bg-surface-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/**
 * "‹ November 2026 ›" — the month lives in the URL (`?month=YYYY-MM`); no navigating past `maxMonth`. The arrows are
 * plain links (they work without JS); the label opens a month picker to jump anywhere, and "This month" goes back.
 * `extraParams` are kept on every link (e.g. `{ currency: "EUR" }` → `/?month=2026-10&currency=EUR`).
 */
export function MonthSwitcher({
  month,
  maxMonth,
  basePath = "/",
  extraParams,
}: {
  month: string;
  maxMonth: string;
  basePath?: string;
  extraParams?: Record<string, string>;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const prev = shiftMonth(month, -1);
  const next = shiftMonth(month, 1);
  const href = (m: string) => {
    const params = new URLSearchParams(m === maxMonth ? {} : { month: m });
    for (const [k, v] of Object.entries(extraParams ?? {})) params.set(k, v);
    const qs = params.toString();
    return qs ? `${basePath}?${qs}` : basePath;
  };
  const hasNext = next <= maxMonth;

  return (
    <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
      {month !== maxMonth && (
        <Link href={href(maxMonth)} scroll={false} className="text-xs font-medium text-accent hover:underline">
          This month
        </Link>
      )}
      <div ref={anchor} className="relative">
        <div className="flex items-center gap-1 rounded-xl border border-border bg-surface p-1 shadow-xs">
          <Link href={href(prev)} className={arrow} aria-label={`Previous month, ${formatMonth(prev)}`} scroll={false}>
            <ChevronIcon dir="left" />
          </Link>
          <button
            ref={trigger}
            type="button"
            className="h-8 min-w-32 rounded-lg px-2 text-center text-sm font-medium text-foreground tabular-nums transition-colors hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            aria-haspopup="dialog"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
          >
            <span aria-live="polite">{formatMonth(month)}</span>
            <span className="sr-only">, choose a month</span>
          </button>
          {hasNext ? (
            <Link href={href(next)} className={arrow} aria-label={`Next month, ${formatMonth(next)}`} scroll={false}>
              <ChevronIcon dir="right" />
            </Link>
          ) : (
            <span className={cn(arrow, "pointer-events-none opacity-40")} aria-hidden="true">
              <ChevronIcon dir="right" />
            </span>
          )}
        </div>
        <Popover
          open={open}
          onClose={() => setOpen(false)}
          anchor={anchor}
          trigger={trigger}
          align="end"
          role="dialog"
          aria-label="Choose a month"
          className="w-64"
        >
          <MonthPicker month={month} maxMonth={maxMonth} href={href} onDone={() => setOpen(false)} />
        </Popover>
      </div>
    </div>
  );
}

/** Mounted only while the popover is open, so the closed switcher renders without an app router (static tests). */
function MonthPicker({
  month,
  maxMonth,
  href,
  onDone,
}: {
  month: string;
  maxMonth: string;
  href: (m: string) => string;
  onDone: () => void;
}) {
  const router = useRouter();
  return (
    <MonthGrid
      value={month}
      maxMonth={maxMonth}
      autoFocus
      onSelect={(m) => {
        onDone();
        if (m !== month) router.push(href(m), { scroll: false });
      }}
    />
  );
}
