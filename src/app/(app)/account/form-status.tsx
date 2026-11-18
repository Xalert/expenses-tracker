import { FormError } from "@/components/ui";
import type { FormState } from "@/lib/form";

/** A form's outcome: the polite success notice when `ok`, else the usual form-level error. */
export function FormStatus({ state }: { state: FormState }) {
  if (state.ok) {
    return (
      <p role="status" className="rounded-xl border border-income/30 bg-income-soft px-3 py-2 text-sm text-income">
        {state.message}
      </p>
    );
  }
  return <FormError message={state.message} />;
}

/** A key that changes with every action result, so a form keyed on it remounts (fields refilled or cleared). */
export function resultKey(state: FormState): string {
  return String(state.ok ?? "") + (state.message ?? "") + JSON.stringify(state.fieldErrors ?? {}) + JSON.stringify(state.values ?? {});
}
