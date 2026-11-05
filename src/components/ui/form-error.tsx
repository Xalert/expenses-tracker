import { cn } from "@/lib/cn";

/** Form-level error banner (e.g. `state.message` from a Server Action). Announced to screen readers. */
export function FormError({ message, className }: { message?: string; className?: string }) {
  if (!message) return null;
  return (
    <div
      role="alert"
      className={cn("rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger", className)}
    >
      {message}
    </div>
  );
}
