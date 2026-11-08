"use client";

import { cn } from "@/lib/cn";

export type ChoiceOption = { value: string; label: React.ReactNode };

export type SegmentedProps = {
  name: string;
  options: ChoiceOption[];
  /** Controlled: the selected value (pair with `onChange`). */
  value?: string;
  /** Uncontrolled: the initially selected value. */
  defaultValue?: string;
  onChange?: (value: string) => void;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  /** Stretch to the container, options sharing the width equally. */
  fullWidth?: boolean;
  className?: string;
};

/**
 * A radio group drawn as a pill track (type switches, currency switch). Real `<input type="radio">`s, visually
 * hidden: the form posts `name=value` like any radio group, arrow keys move the choice, and the focused option shows
 * the focus ring.
 */
export function Segmented({
  name,
  options,
  value,
  defaultValue,
  onChange,
  fullWidth,
  className,
  "aria-label": ariaLabel,
  "aria-labelledby": labelledBy,
}: SegmentedProps) {
  const controlled = value !== undefined;
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      aria-labelledby={labelledBy}
      className={cn(
        "gap-1 rounded-full bg-surface-muted p-1",
        fullWidth ? "grid auto-cols-fr grid-flow-col" : "inline-flex",
        className,
      )}
    >
      {options.map((o) => (
        <label key={o.value} className="relative flex min-w-0">
          <input
            type="radio"
            name={name}
            value={o.value}
            className="peer sr-only"
            {...(controlled
              ? { checked: value === o.value, onChange: () => onChange?.(o.value) }
              : { defaultChecked: defaultValue === o.value, onChange: () => onChange?.(o.value) })}
          />
          <span
            className={cn(
              "flex h-9 w-full cursor-pointer items-center justify-center rounded-full px-4 text-sm font-semibold whitespace-nowrap",
              "text-muted-foreground transition-colors hover:text-foreground",
              "peer-checked:bg-surface peer-checked:text-foreground peer-checked:shadow-sm",
              "peer-focus-visible:outline-2 peer-focus-visible:outline-offset-1 peer-focus-visible:outline-ring",
              "peer-disabled:cursor-not-allowed peer-disabled:opacity-60",
            )}
          >
            {o.label}
          </span>
        </label>
      ))}
    </div>
  );
}
