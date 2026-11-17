"use client";

import { useActionState } from "react";
import { Field, FormError, Input, SubmitButton } from "@/components/ui";
import { MIN_PASSWORD_LENGTH } from "@/lib/constants";
import { initialFormState } from "@/lib/form";
import { changePasswordAction } from "./actions";

/** The change-password form. `username` only feeds a hidden input so password managers pick the right account. */
export function ChangePasswordForm({ username }: { username: string }) {
  const [state, formAction] = useActionState(changePasswordAction, initialFormState);
  const err = state.fieldErrors ?? {};

  return (
    // Keyed on the action result: a new result remounts the form, so every field clears (after success, and
    // after an error too, since passwords are never echoed back).
    <form key={String(state.ok ?? "") + (state.message ?? "") + JSON.stringify(err)} action={formAction} className="space-y-5" noValidate>
      {state.ok ? (
        <p role="status" className="rounded-xl border border-income/30 bg-income-soft px-3 py-2 text-sm text-income">
          {state.message}
        </p>
      ) : (
        <FormError message={state.message} />
      )}
      <input type="hidden" name="username" value={username} autoComplete="username" readOnly />
      <Field id="currentPassword" label="Current password" error={err.currentPassword}>
        <Input
          id="currentPassword"
          name="currentPassword"
          type="password"
          autoComplete="current-password"
          required
          error={err.currentPassword}
        />
      </Field>
      <Field
        id="newPassword"
        label="New password"
        hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}
        error={err.newPassword}
      >
        <Input
          id="newPassword"
          name="newPassword"
          type="password"
          autoComplete="new-password"
          required
          minLength={MIN_PASSWORD_LENGTH}
          aria-describedby={err.newPassword ? undefined : "newPassword-hint"}
          error={err.newPassword}
        />
      </Field>
      <Field id="confirmPassword" label="Confirm new password" error={err.confirmPassword}>
        <Input
          id="confirmPassword"
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          required
          minLength={MIN_PASSWORD_LENGTH}
          error={err.confirmPassword}
        />
      </Field>
      <SubmitButton pendingLabel="Changing…">Change password</SubmitButton>
    </form>
  );
}
