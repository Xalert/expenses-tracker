"use client";

import { useActionState } from "react";
import { Field, Input, SubmitButton } from "@/components/ui";
import { MIN_PASSWORD_LENGTH } from "@/lib/constants";
import { initialFormState } from "@/lib/form";
import { changePasswordAction } from "./actions";
import { FormStatus, resultKey } from "./form-status";

/** The change-password form. `username` only feeds a hidden input so password managers pick the right account. */
export function ChangePasswordForm({ username }: { username: string }) {
  const [state, formAction] = useActionState(changePasswordAction, initialFormState);
  const err = state.fieldErrors ?? {};

  return (
    // Keyed on the action result: a new result remounts the form, so every field clears (after success, and
    // after an error too, since passwords are never echoed back).
    <form key={resultKey(state)} action={formAction} className="space-y-5" noValidate>
      <FormStatus state={state} />
      <input type="hidden" name="username" value={username} autoComplete="username" readOnly />
      <Field id="pw-currentPassword" label="Current password" error={err.currentPassword}>
        <Input
          id="pw-currentPassword"
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
