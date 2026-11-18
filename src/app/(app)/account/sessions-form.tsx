"use client";

import { useActionState } from "react";
import { SubmitButton } from "@/components/ui";
import { initialFormState } from "@/lib/form";
import { signOutOtherDevicesAction, signOutSessionAction } from "./actions";
import { FormStatus } from "./form-status";

/** One active session as the Devices card shows it (labels and times formatted on the server). */
export type DeviceRow = {
  id: number;
  /** "Firefox on macOS" (`deviceLabel` in src/lib/user-agent.ts). */
  label: string;
  signedInAt: string;
  lastActiveAt: string;
  current: boolean;
};

/**
 * The user's active sessions, the current one first and marked "This device"; every other one has its own "Sign
 * out". Below them "Sign out other devices" (the current session stays).
 */
export function SessionsForm({ devices }: { devices: DeviceRow[] }) {
  const [rowState, rowAction] = useActionState(signOutSessionAction, initialFormState);
  const [allState, allAction] = useActionState(signOutOtherDevicesAction, initialFormState);
  const others = devices.filter((d) => !d.current).length;
  return (
    <div className="space-y-4">
      <FormStatus state={rowState} />
      <ul className="divide-y divide-border rounded-xl border border-border" aria-label="Signed-in devices">
        {devices.map((d) => (
          <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 px-3 py-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">
                {d.label}
                {d.current && (
                  <span className="ml-2 rounded-full bg-surface-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                    This device
                  </span>
                )}
              </p>
              <p className="text-xs text-muted-foreground">
                Signed in {d.signedInAt} · Last active {d.lastActiveAt}
              </p>
            </div>
            {!d.current && (
              <form action={rowAction}>
                <input type="hidden" name="sessionId" value={d.id} />
                <SubmitButton variant="ghost" size="sm" pendingLabel="Signing out…" aria-label={`Sign out ${d.label}, signed in ${d.signedInAt}`}>
                  Sign out
                </SubmitButton>
              </form>
            )}
          </li>
        ))}
      </ul>
      <form action={allAction} className="space-y-4">
        <FormStatus state={allState} />
        <p className="text-sm text-foreground">
          {others === 0
            ? "You are signed in on this device only."
            : `You are also signed in on ${others} other ${others === 1 ? "device or browser" : "devices or browsers"}.`}
        </p>
        <SubmitButton variant="secondary" pendingLabel="Signing out…">
          Sign out other devices
        </SubmitButton>
      </form>
    </div>
  );
}
