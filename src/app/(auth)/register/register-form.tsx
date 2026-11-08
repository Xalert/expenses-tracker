"use client";

import { useActionState } from "react";
import { Field, FormError, Input, SubmitButton } from "@/components/ui";
import { initialFormState } from "@/lib/form";
import { MIN_PASSWORD_LENGTH } from "@/lib/constants";
import { NAME_MAX, USER_ID_HINT, USER_ID_MAX } from "@/lib/user-id";
import { registerAction } from "./actions";

function Optional({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children} <span className="font-normal text-muted-foreground">(optional)</span>
    </>
  );
}

export function RegisterForm() {
  const [state, formAction] = useActionState(registerAction, initialFormState);
  const err = state.fieldErrors ?? {};
  const v = state.values ?? {};

  return (
    <form action={formAction} className="space-y-4" noValidate>
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
      <Field
        id="email"
        label={<Optional>Email</Optional>}
        hint="You can sign in with it as well as with your user ID."
        error={err.email}
      >
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
        <Field id="firstName" label={<Optional>First name</Optional>} error={err.firstName}>
          <Input
            id="firstName"
            name="firstName"
            autoComplete="given-name"
            maxLength={NAME_MAX}
            defaultValue={v.firstName}
            error={err.firstName}
          />
        </Field>
        <Field id="lastName" label={<Optional>Surname</Optional>} error={err.lastName}>
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
      <SubmitButton className="w-full" pendingLabel="Creating account…">
        Create account
      </SubmitButton>
    </form>
  );
}
