import { cn } from "@/lib/cn";
import { FieldError } from "./field";
import type { ChoiceOption } from "./segmented";

export type PillPickerProps = {
  name: string;
  options: ChoiceOption[];
  defaultValue?: string;
  /** Inline error under the pills (`<id>-error`, referenced by the group); needs `id`. */
  error?: string;
  /** Id of the group; the error line is `<id>-error`. */
  id?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  required?: boolean;
  className?: string;
};

/**
 * A radio group drawn as wrapping pills (category and wallet in the Add form, currency in the wallet form). Real
 * `<input type="radio">`s, visually hidden, so the form posts `name=value`; arrow keys move the choice and the
 * focused pill shows the focus ring. Uncontrolled: a form that must reset it remounts it (`key`). Label it with
 * `aria-labelledby` (a visible heading) — a `<label for>` cannot name a group.
 */
export function PillPicker({
  name,
  options,
  defaultValue,
  error,
  id,
  required,
  className,
  "aria-label": ariaLabel,
  "aria-labelledby": labelledBy,
}: PillPickerProps) {
  return (
    <div className={className}>
      <div
        id={id}
        role="radiogroup"
        aria-label={ariaLabel}
        aria-labelledby={labelledBy}
        aria-required={required || undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={error && id ? `${id}-error` : undefined}
        className="flex flex-wrap gap-2"
      >
        {options.map((o) => (
          <label key={o.value} className="relative flex">
            <input
              type="radio"
              name={name}
              value={o.value}
              defaultChecked={defaultValue === o.value}
              required={required}
              className="peer sr-only"
            />
            <span
              className={cn(
                "inline-flex min-h-11 cursor-pointer items-center rounded-full border bg-field px-4 text-sm font-semibold",
                "text-foreground transition-colors hover:border-border-strong sm:min-h-10",
                "peer-checked:border-accent peer-checked:bg-accent-soft peer-checked:text-accent-soft-foreground",
                "peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring",
                "peer-disabled:cursor-not-allowed peer-disabled:opacity-60",
                error ? "border-danger" : "border-border",
              )}
            >
              {o.label}
            </span>
          </label>
        ))}
      </div>
      {id && error && (
        <div className="mt-1.5">
          <FieldError id={id}>{error}</FieldError>
        </div>
      )}
    </div>
  );
}
