"use client";

import { useEffect, useRef, useState } from "react";
import { MONTH_LABELS, clampTo, moveMonth } from "@/lib/calendar";
import { cn } from "@/lib/cn";
import { currentMonth, formatMonth } from "@/lib/dates";
import { ChevronIcon } from "./picker-icons";

const MIN_MONTH = "1900-01";
const MAX_MONTH = "2999-12";

export const pickerNavButton =
  "inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors " +
  "hover:bg-surface-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring " +
  "disabled:pointer-events-none disabled:opacity-40";

/**
 * A year stepper (‹ 2026 ›) over a 3 × 4 grid of months. Used by the dashboard month switcher and the date
 * picker's month view. Keyboard: arrows move between months (wrapping into the neighbouring years), Home / End
 * jump to Jan / Dec, PageUp / PageDown change the year, Enter / Space select; only one month is in the Tab order.
 */
export function MonthGrid({
  value,
  onSelect,
  minMonth = MIN_MONTH,
  maxMonth = MAX_MONTH,
  focusMonth,
  autoFocus = false,
  className,
}: {
  /** The selected `YYYY-MM`, if any. */
  value: string | null;
  onSelect: (month: string) => void;
  /** Inclusive bounds (`YYYY-MM`); months outside them are shown disabled. */
  minMonth?: string;
  maxMonth?: string;
  /** The month that starts out focusable (and decides the year shown); defaults to `value`, then this month. */
  focusMonth?: string;
  /** Move focus into the grid on mount (when it opens in a popover). */
  autoFocus?: boolean;
  className?: string;
}) {
  const [focus, setFocus] = useState(() => clampTo(focusMonth ?? value ?? currentMonth(), minMonth, maxMonth));
  const shouldFocus = useRef(autoFocus);
  const buttons = useRef(new Map<string, HTMLButtonElement>());

  useEffect(() => {
    if (!shouldFocus.current) return;
    shouldFocus.current = false;
    buttons.current.get(focus)?.focus();
  }, [focus]);

  const year = Number(focus.slice(0, 4));
  const today = currentMonth();
  const months = MONTH_LABELS.map((label, i) => ({ label, month: `${year}-${String(i + 1).padStart(2, "0")}` }));
  const canPrev = `${year - 1}-12` >= minMonth;
  const canNext = `${year + 1}-01` <= maxMonth;

  function stepYear(delta: number) {
    const next = `${String(year + delta).padStart(4, "0")}-${focus.slice(5)}`;
    setFocus(clampTo(next, minMonth, maxMonth));
  }

  return (
    <div className={cn("w-full", className)}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <button
          type="button"
          className={pickerNavButton}
          onClick={() => stepYear(-1)}
          disabled={!canPrev}
          aria-label={`Previous year, ${year - 1}`}
        >
          <ChevronIcon dir="left" />
        </button>
        <p className="text-sm font-semibold text-foreground tabular-nums" aria-live="polite">
          {year}
        </p>
        <button
          type="button"
          className={pickerNavButton}
          onClick={() => stepYear(1)}
          disabled={!canNext}
          aria-label={`Next year, ${year + 1}`}
        >
          <ChevronIcon dir="right" />
        </button>
      </div>
      <div
        role="group"
        aria-label={`Months of ${year}`}
        className="grid grid-cols-3 gap-1"
        onKeyDown={(e) => {
          const next = moveMonth(focus, e.key);
          if (!next) return;
          e.preventDefault();
          shouldFocus.current = true;
          setFocus(clampTo(next, minMonth, maxMonth));
        }}
      >
        {months.map(({ label, month }) => {
          const selected = month === value;
          const current = month === today;
          const disabled = month < minMonth || month > maxMonth;
          return (
            <button
              key={month}
              ref={(el) => {
                if (el) buttons.current.set(month, el);
                else buttons.current.delete(month);
              }}
              type="button"
              tabIndex={month === focus ? 0 : -1}
              disabled={disabled}
              aria-pressed={selected}
              aria-current={current ? "date" : undefined}
              aria-label={formatMonth(month)}
              onClick={() => onSelect(month)}
              onFocus={() => setFocus(month)}
              className={cn(
                "h-10 rounded-lg text-sm font-medium transition-colors",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                "disabled:cursor-not-allowed disabled:opacity-40",
                selected
                  ? "bg-accent text-accent-foreground hover:bg-accent-hover"
                  : cn("text-foreground hover:bg-surface-muted disabled:hover:bg-transparent", current && "text-accent ring-1 ring-accent/40 ring-inset"),
              )}
            >
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
