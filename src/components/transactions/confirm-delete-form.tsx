"use client";

import type { ReactNode } from "react";
import { SubmitButton, type ButtonProps } from "@/components/ui";

/**
 * A one-button form that posts `id` + `returnTo` to a delete Server Action after a `confirm()` prompt.
 */
export function ConfirmDeleteForm({
  action,
  id,
  returnTo,
  confirmMessage,
  children,
  pendingLabel,
  variant = "danger",
  size,
  className,
  "aria-label": ariaLabel,
  title,
}: {
  action: (formData: FormData) => Promise<void>;
  id: number;
  returnTo: string;
  confirmMessage: string;
  children: ReactNode;
  pendingLabel?: ReactNode;
  variant?: ButtonProps["variant"];
  size?: ButtonProps["size"];
  className?: string;
  "aria-label"?: string;
  title?: string;
}) {
  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (!window.confirm(confirmMessage)) e.preventDefault();
      }}
    >
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="returnTo" value={returnTo} />
      <SubmitButton
        variant={variant}
        size={size}
        className={className}
        pendingLabel={pendingLabel}
        aria-label={ariaLabel}
        title={title}
      >
        {children}
      </SubmitButton>
    </form>
  );
}
