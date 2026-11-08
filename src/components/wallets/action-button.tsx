"use client";

import { useActionState, useEffect, useRef } from "react";
import { FormError, SubmitButton, type ButtonSize, type ButtonVariant } from "@/components/ui";
import { initialFormState, type FormState } from "@/lib/form";

/**
 * One-click action (archive, unarchive, delete) as a tiny form. Optional `confirm` message asks first;
 * a returned `message` is shown below the button. `onDone` runs once after each result with `ok` (the wallet page's
 * "⋯" menu closes itself); `role="menuitem"` puts the button in such a menu.
 */
export function ActionButton({
  action,
  label,
  pendingLabel,
  confirmMessage,
  variant = "secondary",
  size = "sm",
  className,
  buttonClassName,
  role,
  onDone,
}: {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  label: string;
  pendingLabel?: string;
  confirmMessage?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  buttonClassName?: string;
  role?: "menuitem";
  onDone?: () => void;
}) {
  const [state, formAction] = useActionState(action, initialFormState);
  const handled = useRef<FormState>(initialFormState);
  useEffect(() => {
    if (state === handled.current) return;
    handled.current = state;
    if (state.ok) onDone?.();
  }, [state, onDone]);

  return (
    <form
      action={formAction}
      className={className}
      onSubmit={(e) => {
        if (confirmMessage && !window.confirm(confirmMessage)) e.preventDefault();
      }}
    >
      <SubmitButton variant={variant} size={size} pendingLabel={pendingLabel} role={role} className={buttonClassName}>
        {label}
      </SubmitButton>
      {state.message && <FormError message={state.message} className="mt-2" />}
    </form>
  );
}
