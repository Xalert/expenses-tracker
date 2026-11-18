"use client";

import { useEffect, useState } from "react";
import { isNegativeText, toggleSign } from "@/lib/amount-sign";
import { cn } from "@/lib/cn";

/**
 * A "±" toggle button for an amount input whose keyboard has no minus key (iOS's decimal pad): it adds or removes
 * the leading "-" of the input `inputId`, and shows the sign as `aria-pressed`. It does not take focus from the
 * input on a tap (so the phone keyboard stays open); from the keyboard it is an ordinary toggle button.
 */
export function SignToggle({ inputId, defaultNegative = false }: { inputId: string; defaultNegative?: boolean }) {
  const [negative, setNegative] = useState(defaultNegative);

  // Follow what is typed (a pasted "-", a deleted one); a form reset remounts the input, which runs this again.
  useEffect(() => {
    const input = document.getElementById(inputId);
    if (!(input instanceof HTMLInputElement)) return;
    const sync = () => setNegative(isNegativeText(input.value));
    sync();
    input.addEventListener("input", sync);
    return () => input.removeEventListener("input", sync);
  }, [inputId]);

  return (
    <button
      type="button"
      aria-label="Minus sign"
      aria-pressed={negative}
      aria-controls={inputId}
      title="Make the amount negative or positive"
      // Keep focus (and the phone keyboard) in the amount on a tap.
      onPointerDown={(e) => e.preventDefault()}
      onClick={() => {
        const input = document.getElementById(inputId);
        if (!(input instanceof HTMLInputElement)) return;
        input.value = toggleSign(input.value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }}
      className={cn(
        "inline-flex size-11 shrink-0 items-center justify-center rounded-full border text-xl font-bold transition-colors",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        negative
          ? "border-accent bg-accent-soft text-accent-soft-foreground"
          : "border-border bg-surface text-muted-foreground hover:text-foreground",
      )}
    >
      <span aria-hidden="true">±</span>
    </button>
  );
}
