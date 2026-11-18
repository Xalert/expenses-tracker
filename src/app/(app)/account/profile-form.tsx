"use client";

import { useActionState } from "react";
import { Field, Input, Select, SubmitButton } from "@/components/ui";
import { initialFormState } from "@/lib/form";
import { NAME_MAX, USER_ID_HINT, USER_ID_MAX } from "@/lib/user-id";
import { updateProfileAction } from "./actions";
import { FormStatus, resultKey } from "./form-status";

export type ProfileFormProps = {
  username: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  /** The account's IANA time zone, or null when not set. */
  timeZone: string | null;
  /**
   * Every zone the select offers, grouped by region. Computed on the server and passed in, so the server HTML and
   * the browser render the same list (browsers' `Intl` zone lists differ).
   */
  timeZones: { group: string; zones: { value: string; label: string }[] }[];
};

/**
 * User ID, email, first name and surname, prefilled. The current password is asked for below them and is only
 * needed when the user ID or the email changes (the service decides; the hint says so). The time zone needs no
 * password; "Not set" (an empty value) lets each import use the browser's zone.
 */
export function ProfileForm({ timeZones, ...user }: ProfileFormProps) {
  const [state, formAction] = useActionState(updateProfileAction, initialFormState);
  const err = state.fieldErrors ?? {};
  const v = state.values ?? {
    username: user.username,
    email: user.email ?? "",
    firstName: user.firstName ?? "",
    lastName: user.lastName ?? "",
    timeZone: user.timeZone ?? "",
  };
  const zone = v.timeZone ?? "";
  // A stored zone missing from this list (spelt differently by another ICU version) is still shown as selected.
  const listed = zone === "" || timeZones.some((g) => g.zones.some((z) => z.value === zone));

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
        id="timeZone"
        label="Time zone"
        hint="Used to date imported Spendee entries, whose times are in UTC, so every browser dates them alike."
        error={err.timeZone}
      >
        <Select
          id="timeZone"
          name="timeZone"
          defaultValue={zone}
          aria-describedby={err.timeZone ? undefined : "timeZone-hint"}
          error={err.timeZone}
        >
          <option value="">Not set (use this browser&rsquo;s)</option>
          {!listed && <option value={zone}>{zone}</option>}
          {timeZones.map((g) => (
            <optgroup key={g.group} label={g.group}>
              {g.zones.map((z) => (
                <option key={z.value} value={z.value}>
                  {z.label}
                </option>
              ))}
            </optgroup>
          ))}
        </Select>
      </Field>
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
