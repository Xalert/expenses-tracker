"use client";

import { useId, useRef, useState } from "react";
import { signOutAction } from "@/app/(app)/actions";
import { Popover, SubmitButton } from "@/components/ui";
import { initials } from "@/lib/user-id";
import { LogOutIcon } from "./icons";

export type AccountMenuProps = {
  displayName: string;
  /** The user ID (what they sign in with); shown when it differs from the display name. */
  username: string;
  email: string | null;
};

/** The top bar's account button (initials in a circle) and its popover: who is signed in, and Sign out. */
export function AccountMenu({ displayName, username, email }: AccountMenuProps) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  return (
    <div ref={anchor} className="relative shrink-0">
      <button
        ref={trigger}
        type="button"
        aria-label={`Account: ${displayName}`}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex size-10 items-center justify-center rounded-full bg-accent-soft text-[13px] font-bold text-accent-soft-foreground transition-colors hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <span aria-hidden="true">{initials(displayName)}</span>
      </button>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchor={anchor}
        trigger={trigger}
        align="end"
        id={panelId}
        className="w-64 p-2"
      >
        <div className="px-2.5 pt-1.5 pb-2.5">
          <p className="truncate text-sm font-semibold text-foreground" title={displayName}>
            {displayName}
          </p>
          {displayName !== username && (
            <p className="truncate text-xs text-muted-foreground" title={username}>
              <span className="sr-only">User ID: </span>
              {username}
            </p>
          )}
          {email && (
            <p className="truncate text-xs text-muted-foreground" title={email}>
              <span className="sr-only">Email: </span>
              {email}
            </p>
          )}
        </div>
        <form action={signOutAction} className="border-t border-surface-muted pt-2">
          <SubmitButton variant="ghost" size="sm" className="w-full justify-start" pendingLabel="Signing out…">
            <LogOutIcon className="size-4" />
            Sign out
          </SubmitButton>
        </form>
      </Popover>
    </div>
  );
}
