import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { currencyDecimals } from "@/lib/money";
import { FieldError } from "./field";

/** "0.00" for EUR, "0" for JPY; "0.00" while the currency is unknown or not a real code yet (typed half-way). */
export function amountPlaceholder(currency: string | undefined): string {
  let d = 2;
  if (currency && /^[A-Za-z]{3}$/.test(currency)) {
    try {
      d = currencyDecimals(currency);
    } catch {
      // not a currency Intl knows: keep the default
    }
  }
  return d === 0 ? "0" : `0.${"0".repeat(d)}`;
}

export type BigAmountProps = {
  id: string;
  /** The posted field name (`amount`, `receivedAmount`, `initialBalance`); the id may carry a prefix. */
  name: string;
  label: string;
  currency: string | undefined;
  /** Shown beside the number, e.g. "EUR · from Cash". */
  currencyText: ReactNode;
  defaultValue?: string;
  error?: string;
  /** A hint under the box (`<id>-hint`, added to the input's `aria-describedby`). */
  hint?: ReactNode;
  /** Marks the input for `Dialog` to focus when it opens (`data-autofocus`). */
  autoFocus?: boolean;
  /** The in-place edit form: a 56px box with a 32px number. */
  compact?: boolean;
  /** Default true (an entry's amount); a wallet's starting balance may be left empty. */
  required?: boolean;
};

/**
 * A large amount input (`tabular-nums`, decimal keyboard) with a label above and the currency beside it
 * (`<id>-currency`, in the input's `aria-describedby`). Used by the Add / edit entry form and the wallet form.
 */
export function BigAmount({
  id,
  name,
  label,
  currency,
  currencyText,
  defaultValue,
  error,
  hint,
  autoFocus,
  compact,
  required = true,
}: BigAmountProps) {
  return (
    <div className="min-w-0 space-y-1.5">
      <label htmlFor={id} className="text-[13px] font-semibold text-muted-foreground">
        {label}
      </label>
      <div
        className={cn(
          "flex items-center gap-3 rounded-2xl border bg-field px-4",
          "focus-within:border-accent focus-within:outline-2 focus-within:outline-ring/40",
          error ? "border-danger focus-within:outline-danger/30" : "border-border",
        )}
      >
        <input
          id={id}
          name={name}
          inputMode="decimal"
          autoComplete="off"
          required={required}
          placeholder={amountPlaceholder(currency)}
          defaultValue={defaultValue}
          data-autofocus={autoFocus ? "" : undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={cn(`${id}-currency`, Boolean(hint) && `${id}-hint`, error && `${id}-error`)}
          className={cn(
            compact ? "h-14 text-[32px]" : "h-[72px] text-[44px] sm:text-[48px]",
            "w-full min-w-0 flex-1 bg-transparent leading-none font-extrabold tracking-[-0.03em]",
            "text-foreground tabular-nums outline-none placeholder:text-muted-foreground/45",
          )}
        />
        <span
          id={`${id}-currency`}
          className="max-w-[45%] shrink-0 truncate text-sm font-semibold text-muted-foreground"
        >
          {currencyText}
        </span>
      </div>
      {hint && (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      <FieldError id={id}>{error}</FieldError>
    </div>
  );
}
