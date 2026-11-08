import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

export const controlClasses =
  "block w-full rounded-xl border border-border bg-field px-3.5 text-sm text-foreground " +
  "placeholder:text-muted-foreground/70 " +
  "focus:border-accent focus:outline-2 focus:outline-offset-0 focus:outline-ring/40 " +
  "disabled:cursor-not-allowed disabled:opacity-60 " +
  "aria-[invalid=true]:border-danger aria-[invalid=true]:focus:outline-danger/30";

export type InputProps = ComponentProps<"input"> & {
  /** Marks the input invalid and points aria-describedby at `${id}-error` (rendered by <Field>). */
  error?: string;
};

export function Input({ className, error, id, "aria-describedby": describedBy, ...props }: InputProps) {
  return (
    <input
      id={id}
      className={cn(controlClasses, "h-11", className)}
      aria-invalid={error ? true : undefined}
      aria-describedby={cn(describedBy, error && id && `${id}-error`) || undefined}
      {...props}
    />
  );
}

export type TextareaProps = ComponentProps<"textarea"> & { error?: string };

export function Textarea({ className, error, id, "aria-describedby": describedBy, ...props }: TextareaProps) {
  return (
    <textarea
      id={id}
      className={cn(controlClasses, "min-h-20 py-2", className)}
      aria-invalid={error ? true : undefined}
      aria-describedby={cn(describedBy, error && id && `${id}-error`) || undefined}
      {...props}
    />
  );
}
