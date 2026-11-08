"use client";

import { useEffect, useRef, useState } from "react";
import { WEEKDAY_LABELS, WEEKDAY_NAMES, calendarWeeks, clampTo, dateInMonth, dateLabel, monthOf, moveDate } from "@/lib/calendar";
import { cn } from "@/lib/cn";
import { formatDate, formatMonth, isValidDate, shiftMonth, todayISO } from "@/lib/dates";
import { controlClasses } from "./input";
import { MonthGrid, pickerNavButton } from "./month-grid";
import { CalendarIcon, ChevronIcon, XIcon } from "./picker-icons";
import { Popover } from "./popover";

const MIN_MONTH = "1900-01";
const MAX_MONTH = "2999-12";

export type DatePickerProps = {
  /** On the trigger button, so `<Label htmlFor>` / `<Field id>` point at it. */
  id: string;
  /** Name of the hidden input that carries the `YYYY-MM-DD` value. */
  name: string;
  /** `YYYY-MM-DD`, or "" for no date. Read once: remount (key) the form to reset it. */
  defaultValue?: string;
  required?: boolean;
  /** Marks the control invalid and points aria-describedby at `${id}-error` (rendered by <Field>). */
  error?: string;
  /** Optional dates (filters): show a clear button, and post nothing while empty. */
  allowEmpty?: boolean;
  /** Latest selectable date (`YYYY-MM-DD`), inclusive. */
  max?: string;
  /** Which edge of the control the calendar lines up with; use "end" at the right edge of a layout. */
  align?: "start" | "end";
  placeholder?: string;
  className?: string;
};

/**
 * A themed date picker: a button showing the date ("5 Nov 2026") that opens a calendar popover, plus a hidden
 * input posting `YYYY-MM-DD` under `name`, so forms submit exactly what an `<input type="date">` would.
 * Uncontrolled: it starts from `defaultValue`.
 */
export function DatePicker({
  id,
  name,
  defaultValue = "",
  required,
  error,
  allowEmpty = false,
  max,
  align = "start",
  placeholder = "Pick a date",
  className,
}: DatePickerProps) {
  const [value, setValue] = useState(() => (isValidDate(defaultValue) ? defaultValue : ""));
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const showClear = allowEmpty && value !== "";
  const dialogId = `${id}-dialog`;

  return (
    <div ref={anchor} className={cn("relative", className)}>
      <button
        ref={trigger}
        type="button"
        id={id}
        className={cn(controlClasses, "flex h-11 items-center gap-2 text-left")}
        // A select-only combobox: the label names it, its text is the value, and (unlike a plain button) the role
        // supports aria-invalid / aria-required, so <Field> errors still attach the way they do for <Input>.
        role="combobox"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? dialogId : undefined}
        aria-required={required || undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={cn("min-w-0 flex-1 truncate tabular-nums", !value && "text-muted-foreground")}>
          {value ? formatDate(value) : placeholder}
        </span>
        {/* Room for the clear button, which sits on top of the trigger (a button cannot contain a button). */}
        {showClear && <span className="size-6 shrink-0" aria-hidden="true" />}
        <CalendarIcon className="size-4 shrink-0 text-muted-foreground" />
      </button>
      {showClear && (
        <button
          type="button"
          aria-label="Clear date"
          className="absolute inset-y-0 right-8 my-auto inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          onClick={() => {
            setValue("");
            setOpen(false);
            trigger.current?.focus();
          }}
        >
          <XIcon className="size-4" />
        </button>
      )}
      {(value || !allowEmpty) && <input type="hidden" name={name} value={value} />}
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchor={anchor}
        trigger={trigger}
        align={align}
        id={dialogId}
        role="dialog"
        aria-label="Choose a date"
        className="w-72"
      >
        <CalendarPanel
          value={value}
          max={max}
          allowEmpty={allowEmpty}
          onPick={(date) => {
            setValue(date);
            setOpen(false);
          }}
        />
      </Popover>
    </div>
  );
}

const dayButton =
  "flex h-9 w-full items-center justify-center rounded-lg text-sm tabular-nums transition-colors " +
  "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring " +
  "disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent";

const footerButton =
  "rounded-md px-2 py-1 text-sm font-medium transition-colors hover:bg-surface-muted " +
  "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-40";

/** The popover's content; mounted on open, so its view state starts fresh from the current value each time. */
function CalendarPanel({
  value,
  max,
  allowEmpty,
  onPick,
}: {
  value: string;
  max?: string;
  allowEmpty: boolean;
  onPick: (date: string) => void;
}) {
  const today = todayISO();
  const [view, setView] = useState<"days" | "months">("days");
  const [focusDate, setFocusDate] = useState(() => clampTo(value || today, undefined, max));
  const [viewMonth, setViewMonth] = useState(() => monthOf(clampTo(value || today, undefined, max)));
  const shouldFocus = useRef(true);
  const cells = useRef(new Map<string, HTMLButtonElement>());

  // Roving focus: after a key press (and on open) move DOM focus to the focusable day.
  useEffect(() => {
    if (view !== "days" || !shouldFocus.current) return;
    shouldFocus.current = false;
    cells.current.get(focusDate)?.focus();
  }, [focusDate, view]);

  const maxMonth = max ? monthOf(max) : MAX_MONTH;
  const canPrev = viewMonth > MIN_MONTH;
  const canNext = viewMonth < maxMonth;
  const prevMonth = shiftMonth(viewMonth, -1);
  const nextMonth = shiftMonth(viewMonth, 1);

  function showMonth(month: string, moveFocus: boolean) {
    setViewMonth(month);
    setFocusDate(clampTo(dateInMonth(focusDate, month), undefined, max));
    shouldFocus.current = moveFocus;
  }

  const outOfRange = (date: string) => !isValidDate(date) || (max !== undefined && date > max);

  return (
    <div
      onKeyDown={(e) => {
        // Escape in the month view steps back to the days instead of closing (the Popover skips handled keys).
        if (e.key === "Escape" && view === "months") {
          e.preventDefault();
          shouldFocus.current = true;
          setView("days");
        }
      }}
    >
      {view === "months" ? (
        <MonthGrid
          value={value ? monthOf(value) : null}
          focusMonth={viewMonth}
          maxMonth={maxMonth}
          autoFocus
          onSelect={(month) => {
            showMonth(month, true);
            setView("days");
          }}
        />
      ) : (
        <>
          <div className="mb-2 flex items-center justify-between gap-2">
            <button
              type="button"
              className={pickerNavButton}
              onClick={() => showMonth(prevMonth, false)}
              disabled={!canPrev}
              aria-label={`Previous month, ${formatMonth(prevMonth)}`}
            >
              <ChevronIcon dir="left" />
            </button>
            <button
              type="button"
              className="inline-flex h-8 items-center gap-1 rounded-lg px-2 text-sm font-semibold text-foreground transition-colors hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              onClick={() => setView("months")}
            >
              <span aria-live="polite">{formatMonth(viewMonth)}</span>
              <span className="sr-only">, choose a month</span>
              <ChevronIcon dir="right" className="size-3.5 rotate-90 text-muted-foreground" />
            </button>
            <button
              type="button"
              className={pickerNavButton}
              onClick={() => showMonth(nextMonth, false)}
              disabled={!canNext}
              aria-label={`Next month, ${formatMonth(nextMonth)}`}
            >
              <ChevronIcon dir="right" />
            </button>
          </div>

          <div
            role="grid"
            aria-label={formatMonth(viewMonth)}
            onKeyDown={(e) => {
              const next = moveDate(focusDate, e.key, e.shiftKey);
              if (!next) return;
              e.preventDefault();
              const target = clampTo(next, undefined, max);
              shouldFocus.current = true;
              setFocusDate(target);
              if (monthOf(target) !== viewMonth) setViewMonth(monthOf(target));
            }}
          >
            <div role="row" className="grid grid-cols-7">
              {WEEKDAY_LABELS.map((label, i) => (
                <div
                  key={label}
                  role="columnheader"
                  aria-label={WEEKDAY_NAMES[i]}
                  className="flex h-8 items-center justify-center text-xs font-medium text-muted-foreground"
                >
                  {label}
                </div>
              ))}
            </div>
            {calendarWeeks(viewMonth).map((week) => (
              <div key={week[0]} role="row" className="grid grid-cols-7 gap-0.5 py-px">
                {week.map((date) => {
                  const selected = date === value;
                  const isToday = date === today;
                  const inMonth = monthOf(date) === viewMonth;
                  return (
                    <button
                      key={date}
                      ref={(el) => {
                        if (el) cells.current.set(date, el);
                        else cells.current.delete(date);
                      }}
                      type="button"
                      role="gridcell"
                      tabIndex={date === focusDate ? 0 : -1}
                      aria-selected={selected}
                      aria-current={isToday ? "date" : undefined}
                      aria-label={dateLabel(date)}
                      disabled={outOfRange(date)}
                      onFocus={() => setFocusDate(date)}
                      onClick={() => onPick(date)}
                      className={cn(
                        dayButton,
                        selected
                          ? "bg-accent font-semibold text-accent-foreground hover:bg-accent-hover"
                          : cn(
                              "hover:bg-surface-muted",
                              inMonth ? "text-foreground" : "text-muted-foreground/60",
                              isToday && "font-semibold text-accent ring-1 ring-accent/50 ring-inset",
                            ),
                      )}
                    >
                      {Number(date.slice(8))}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </>
      )}

      <div className="mt-2 flex items-center justify-between gap-2 border-t border-border pt-2">
        <button
          type="button"
          className={cn(footerButton, "text-accent")}
          disabled={outOfRange(today)}
          onClick={() => onPick(today)}
        >
          Today
        </button>
        {allowEmpty && (
          <button type="button" className={cn(footerButton, "text-muted-foreground hover:text-foreground")} onClick={() => onPick("")}>
            Clear
          </button>
        )}
      </div>
    </div>
  );
}
