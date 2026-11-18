"use client";

import { useActionState } from "react";
import { SubmitButton } from "@/components/ui";
import { initialFormState } from "@/lib/form";
import { signOutOtherDevicesAction } from "./actions";
import { FormStatus } from "./form-status";

/** How many other sessions are active, and "Sign out other devices" (the current session stays). */
export function SessionsForm({ otherSessions }: { otherSessions: number }) {
  const [state, formAction] = useActionState(signOutOtherDevicesAction, initialFormState);
  return (
    <form action={formAction} className="space-y-4">
      <FormStatus state={state} />
      <p className="text-sm text-foreground">
        {otherSessions === 0
          ? "You are signed in on this device only."
          : `You are also signed in on ${otherSessions} other ${otherSessions === 1 ? "device or browser" : "devices or browsers"}.`}
      </p>
      <SubmitButton variant="secondary" pendingLabel="Signing out…">
        Sign out other devices
      </SubmitButton>
    </form>
  );
}
