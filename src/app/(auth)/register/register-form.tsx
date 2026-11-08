"use client";

import { useActionState } from "react";
import { Field, FormError, Input, SubmitButton } from "@/components/ui";
import { initialFormState } from "@/lib/form";
import { MIN_PASSWORD_LENGTH } from "@/lib/constants";
import { NAME_MAX, USER_ID_HINT, USER_ID_MAX } from "@/lib/user-id";
import { registerAction } from "./actions";

export function RegisterForm() {
  const [state, formAction] = useActionState(registerAction, initialFormState);
  const err = state.fieldErrors ?? {};
  const v = state.values ?? {};

  return (
    <form action={formAction} className="space-y-5" noValidate>
      <FormError message={state.message} />
      <Field id="username" label="User ID" hint={USER_ID_HINT} error={err.username}>
        <Input
          id="username"
          name="username"
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
          maxLength={USER_ID_MAX}
          defaultValue={v.username}
          aria-describedby={err.username ? undefined : "username-hint"}
          error={err.username}
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
          aria-describedby={err.password ? undefined : "password-hint"}
          error={err.password}
        />
      </Field>
      {/* Starts open; remounted open when one of its fields comes back with an error, so the error is never hidden. */}
      <details
        key={err.email || err.firstName || err.lastName ? "has-error" : "ok"}
        open
        className="group rounded-2xl border border-border bg-surface-open px-4 py-3 open:pb-4"
      >
        <summary className="flex cursor-pointer list-none items-center justify-between gap-2 rounded-lg text-sm font-semibold text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
          Optional: email and name
          <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" className="size-4 text-muted-foreground transition-transform group-open:rotate-180">
            <path fillRule="evenodd" clipRule="evenodd" d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z" />
          </svg>
        </summary>
        <div className="mt-4 space-y-4">
          <Field id="email" label="Email" hint="You can sign in with it as well as with your user ID." error={err.email}>
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              defaultValue={v.email}
              aria-describedby={err.email ? undefined : "email-hint"}
              error={err.email}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="firstName" label="First name" error={err.firstName}>
              <Input
                id="firstName"
                name="firstName"
                autoComplete="given-name"
                maxLength={NAME_MAX}
                defaultValue={v.firstName}
                error={err.firstName}
              />
            </Field>
            <Field id="lastName" label="Surname" error={err.lastName}>
              <Input
                id="lastName"
                name="lastName"
                autoComplete="family-name"
                maxLength={NAME_MAX}
                defaultValue={v.lastName}
                error={err.lastName}
              />
            </Field>
          </div>
        </div>
      </details>
      <SubmitButton className="w-full" pendingLabel="Creating account…">
        Create account
      </SubmitButton>
    </form>
  );
}
