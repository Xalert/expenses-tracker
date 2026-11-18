"use client";

import { useActionState } from "react";
import { Field, Input, SubmitButton } from "@/components/ui";
import { initialFormState } from "@/lib/form";
import { NAME_MAX, USER_ID_HINT, USER_ID_MAX } from "@/lib/user-id";
import { updateProfileAction } from "./actions";
import { FormStatus, resultKey } from "./form-status";

export type ProfileFormProps = {
  username: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
};

/**
 * User ID, email, first name and surname, prefilled. The current password is asked for below them and is only
 * needed when the user ID or the email changes (the service decides; the hint says so).
 */
export function ProfileForm(user: ProfileFormProps) {
  const [state, formAction] = useActionState(updateProfileAction, initialFormState);
  const err = state.fieldErrors ?? {};
  const v = state.values ?? {
    username: user.username,
    email: user.email ?? "",
    firstName: user.firstName ?? "",
    lastName: user.lastName ?? "",
  };

  return (
    // Keyed on the action result so the inputs take the echoed (or saved) values and the password clears.
    <form key={resultKey(state)} action={formAction} className="space-y-5" noValidate>
      <FormStatus state={state} />
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
      <Field id="email" label="Email (optional)" hint="You can sign in with it as well as with your user ID. Leave it empty to remove it." error={err.email}>
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
        <Field id="firstName" label="First name (optional)" error={err.firstName}>
          <Input
            id="firstName"
            name="firstName"
            autoComplete="given-name"
            maxLength={NAME_MAX}
            defaultValue={v.firstName}
            error={err.firstName}
          />
        </Field>
        <Field id="lastName" label="Surname (optional)" error={err.lastName}>
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
      <Field
        id="profile-currentPassword"
        label="Current password"
        hint="Needed only when you change your user ID or email."
        error={err.currentPassword}
      >
        <Input
          id="profile-currentPassword"
          name="currentPassword"
          type="password"
          autoComplete="current-password"
          aria-describedby={err.currentPassword ? undefined : "profile-currentPassword-hint"}
          error={err.currentPassword}
        />
      </Field>
      <SubmitButton pendingLabel="Saving…">Save profile</SubmitButton>
    </form>
  );
}
