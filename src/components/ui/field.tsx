import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Label } from "./label";

/** Inline error for a field; its id is `${id}-error`, which <Input>/<Select>/<Textarea> reference when given `error`. */
export function FieldError({ id, children }: { id: string; children?: ReactNode }) {
  if (!children) return null;
  return (
    <p id={`${id}-error`} className="text-sm text-danger">
      {children}
    </p>
  );
}

/**
 * Label + control + hint + inline error. Give the control the same `id` and `error`:
 *
 *   <Field id="amount" label="Amount" error={state.fieldErrors?.amount}>
 *     <Input id="amount" name="amount" error={state.fieldErrors?.amount} />
 *   </Field>
 */
export function Field({
  id,
  label,
  hint,
  error,
  className,
  children,
}: {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && !error && (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      <FieldError id={id}>{error}</FieldError>
    </div>
  );
}
