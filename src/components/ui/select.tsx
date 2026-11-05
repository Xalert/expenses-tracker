import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";
import { controlClasses } from "./input";

export type SelectProps = ComponentProps<"select"> & {
  /** Marks the select invalid and points aria-describedby at `${id}-error` (rendered by <Field>). */
  error?: string;
};

/** Native <select> styled like <Input>. Pass <option>s as children. */
export function Select({ className, error, id, children, "aria-describedby": describedBy, ...props }: SelectProps) {
  return (
    <div className="relative">
      <select
        id={id}
        className={cn(controlClasses, "h-10 appearance-none pr-9", className)}
        aria-invalid={error ? true : undefined}
        aria-describedby={cn(describedBy, error && id && `${id}-error`) || undefined}
        {...props}
      >
        {children}
      </select>
      <svg
        className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted-foreground"
        viewBox="0 0 20 20"
        fill="currentColor"
        aria-hidden="true"
      >
        <path
          fillRule="evenodd"
          d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z"
          clipRule="evenodd"
        />
      </svg>
    </div>
  );
}
