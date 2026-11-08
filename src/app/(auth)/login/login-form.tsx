"use client";

import { useActionState } from "react";
import { Field, FormError, Input, SubmitButton } from "@/components/ui";
import { initialFormState } from "@/lib/form";
import { loginAction } from "./actions";

export function LoginForm() {
  const [state, formAction] = useActionState(loginAction, initialFormState);
  const err = state.fieldErrors ?? {};

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <FormError message={state.message} />
      <Field id="identifier" label="User ID or email" error={err.identifier}>
        <Input
          id="identifier"
          name="identifier"
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
          defaultValue={state.values?.identifier}
          error={err.identifier}
        />
      </Field>
      <Field id="password" label="Password" error={err.password}>
        <Input id="password" name="password" type="password" autoComplete="current-password" required error={err.password} />
      </Field>
      <SubmitButton className="w-full" pendingLabel="Signing in…">
        Sign in
      </SubmitButton>
    </form>
  );
}
