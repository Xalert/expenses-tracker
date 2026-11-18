"use client";

import { useActionState } from "react";
import { Field, Input, SubmitButton } from "@/components/ui";
import { initialFormState } from "@/lib/form";
import { deleteAccountAction } from "./actions";
import { FormStatus, resultKey } from "./form-status";

/** Delete the account: the current password plus the user ID typed out. Success redirects to /login. */
export function DeleteAccountForm({ username }: { username: string }) {
  const [state, formAction] = useActionState(deleteAccountAction, initialFormState);
  const err = state.fieldErrors ?? {};

  return (
    <form key={resultKey(state)} action={formAction} className="space-y-5" noValidate>
      <FormStatus state={state} />
      <p className="text-sm text-foreground">
        This deletes your account and all of its wallets, entries, transfers, categories and groups, and signs you out
        everywhere. It cannot be undone.{" "}
        <a href="/api/export/backup" className="font-medium text-accent hover:underline">
          Download a backup
        </a>{" "}
        first if you may want the data later.
      </p>
      <Field id="confirmUsername" label={<>Type your user ID, <strong>{username}</strong>, to confirm</>} error={err.confirmUsername}>
        <Input
          id="confirmUsername"
          name="confirmUsername"
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
          defaultValue={state.values?.confirmUsername}
          error={err.confirmUsername}
        />
      </Field>
      <Field id="delete-currentPassword" label="Current password" error={err.currentPassword}>
        <Input
          id="delete-currentPassword"
          name="currentPassword"
          type="password"
          autoComplete="current-password"
          required
          error={err.currentPassword}
        />
      </Field>
      <SubmitButton variant="danger" pendingLabel="Deleting…">
        Delete account
      </SubmitButton>
    </form>
  );
}
