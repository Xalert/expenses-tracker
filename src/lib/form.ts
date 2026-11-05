import type { z } from "zod";
import { isServiceError } from "./errors";

/**
 * The state every Server Action used with `useActionState` returns.
 *
 * - `message`: form-level error (or success notice when `ok`), render with <FormError>.
 * - `fieldErrors`: per-field messages keyed by the input `name`, render with the `error` prop of <Field>.
 * - `values`: the submitted raw values, so inputs can be re-filled via `defaultValue` after an error
 *   (React resets uncontrolled forms after an action completes).
 */
export type FormState = {
  ok?: boolean;
  message?: string;
  fieldErrors?: Partial<Record<string, string>>;
  values?: Record<string, string>;
};

export const initialFormState: FormState = {};

/** Plain string values of a FormData (files ignored). Pass `omit` to drop secrets such as passwords. */
export function formValues(formData: FormData, omit: string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (typeof value === "string" && !key.startsWith("$ACTION") && !omit.includes(key)) out[key] = value;
  }
  return out;
}

/** First zod issue per field → FormState. */
export function zodErrorState(error: z.ZodError, values?: Record<string, string>): FormState {
  const fieldErrors: Record<string, string> = {};
  let message: string | undefined;
  for (const issue of error.issues) {
    const key = issue.path.length ? String(issue.path[0]) : undefined;
    if (key) fieldErrors[key] ??= issue.message;
    else message ??= issue.message;
  }
  return { message: message ?? "Please fix the highlighted fields.", fieldErrors, values };
}

/**
 * Map a ServiceError to FormState (field error when the service named a field). Any other error is
 * re-thrown, so unexpected failures surface in the error boundary and `redirect()` keeps working.
 */
export function serviceErrorState(err: unknown, values?: Record<string, string>): FormState {
  if (!isServiceError(err)) throw err;
  if (err.field) return { fieldErrors: { [err.field]: err.message }, values };
  return { message: err.message, values };
}
