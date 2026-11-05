"use client";

import { useActionState } from "react";
import { FormError, SubmitButton, type ButtonVariant } from "@/components/ui";
import { initialFormState, type FormState } from "@/lib/form";

/**
 * One-click action (archive, unarchive, delete) as a tiny form. Optional `confirm` message asks first;
 * a returned `message` is shown below the button.
 */
export function ActionButton({
  action,
  label,
  pendingLabel,
  confirmMessage,
  variant = "secondary",
  className,
}: {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  label: string;
  pendingLabel?: string;
  confirmMessage?: string;
  variant?: ButtonVariant;
  className?: string;
}) {
  const [state, formAction] = useActionState(action, initialFormState);
  return (
    <form
      action={formAction}
      className={className}
      onSubmit={(e) => {
        if (confirmMessage && !window.confirm(confirmMessage)) e.preventDefault();
      }}
    >
      <SubmitButton variant={variant} size="sm" pendingLabel={pendingLabel}>
        {label}
      </SubmitButton>
      {state.message && <FormError message={state.message} className="mt-2" />}
    </form>
  );
}
