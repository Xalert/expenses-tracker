"use client";

import { useActionState } from "react";
import { Field, FormError, Input, SubmitButton } from "@/components/ui";
import { initialFormState } from "@/lib/form";
import { MIN_PASSWORD_LENGTH } from "@/lib/constants";
import { registerAction } from "./actions";

export function RegisterForm() {
  const [state, formAction] = useActionState(registerAction, initialFormState);
  const err = state.fieldErrors ?? {};

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <FormError message={state.message} />
      <Field id="name" label="Name" error={err.name}>
        <Input id="name" name="name" autoComplete="name" required defaultValue={state.values?.name} error={err.name} />
      </Field>
      <Field id="email" label="Email" error={err.email}>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          defaultValue={state.values?.email}
          error={err.email}
        />
      </Field>
      <Field id="password" label="Password" hint={`At least ${MIN_PASSWORD_LENGTH} characters.`} error={err.password}>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={MIN_PASSWORD_LENGTH}
          aria-describedby="password-hint"
          error={err.password}
        />
      </Field>
      <SubmitButton className="w-full" pendingLabel="Creating account…">
        Create account
      </SubmitButton>
    </form>
  );
}
