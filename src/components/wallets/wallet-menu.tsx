"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { archiveWalletAction, deleteWalletAction, unarchiveWalletAction } from "@/app/(app)/wallets/actions";
import { Popover } from "@/components/ui";
import { cn } from "@/lib/cn";
import { ActionButton } from "./action-button";

const itemClass = "flex! h-11! w-full justify-start! rounded-xl! px-3! text-sm font-semibold";
const plainItem = cn(itemClass, "text-foreground! hover:bg-surface-muted!");

/** Up / Down / Home / End between the menu's items (a `role="menu"` has its own arrow-key navigation). */
export function nextMenuIndex(key: string, current: number, count: number): number | null {
  if (count === 0) return null;
  switch (key) {
    case "ArrowDown":
      return current < 0 ? 0 : (current + 1) % count;
    case "ArrowUp":
      return current < 0 ? count - 1 : (current - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/**
 * The wallet page's "⋯" button and its menu: Edit (the edit dialog), Archive or Unarchive (with the confirm the
 * Archive button always had), and Delete while the wallet has no entries. Opening focuses the first item; arrows,
 * Home and End move; Escape closes and returns focus to the button; Tab leaves (and closes).
 */
export function WalletMenu({
  walletId,
  walletName,
  archived,
  canDelete,
}: {
  walletId: number;
  walletName: string;
  archived: boolean;
  canDelete: boolean;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const close = useCallback(() => setOpen(false), []);

  const items = () => [...(panel.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];

  useEffect(() => {
    if (open) items()[0]?.focus();
  }, [open]);

  function onKeyDown(e: KeyboardEvent) {
    const list = items();
    const next = nextMenuIndex(e.key, list.indexOf(document.activeElement as HTMLElement), list.length);
    if (next === null) return;
    e.preventDefault();
    list[next]?.focus();
  }

  return (
    <div ref={anchor} className="relative">
      <button
        ref={trigger}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`More actions for ${walletName}`}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "inline-flex size-11 items-center justify-center rounded-full border border-border text-lg font-bold text-foreground",
          "transition-colors hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:size-10",
        )}
      >
        <span aria-hidden="true">⋯</span>
      </button>
      <Popover
        open={open}
        onClose={close}
        anchor={anchor}
        trigger={trigger}
        align="end"
        id={menuId}
        role="menu"
        aria-label={`${walletName} actions`}
        className="w-56 p-1.5"
      >
        <div ref={panel} onKeyDown={onKeyDown} className="flex flex-col gap-0.5">
          <Link
            href={`/wallets/${walletId}/edit`}
            role="menuitem"
            onClick={close}
            className={cn(
              "flex h-11 items-center rounded-xl px-3 text-sm font-semibold text-foreground hover:bg-surface-muted",
              "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
            )}
          >
            Edit wallet
          </Link>
          {archived ? (
            <ActionButton
              action={unarchiveWalletAction.bind(null, walletId)}
              label="Unarchive"
              pendingLabel="Unarchiving…"
              variant="ghost"
              size="md"
              role="menuitem"
              buttonClassName={plainItem}
              onDone={close}
            />
          ) : (
            <ActionButton
              action={archiveWalletAction.bind(null, walletId)}
              label="Archive"
              pendingLabel="Archiving…"
              variant="ghost"
              size="md"
              role="menuitem"
              buttonClassName={plainItem}
              confirmMessage={`Archive “${walletName}”? It will be hidden from the Overview and pickers; its history stays.`}
              onDone={close}
            />
          )}
          {canDelete && (
            <ActionButton
              action={deleteWalletAction.bind(null, walletId)}
              label="Delete wallet"
              pendingLabel="Deleting…"
              variant="ghost"
              size="md"
              role="menuitem"
              buttonClassName={cn(itemClass, "text-danger! hover:bg-danger-soft!")}
              confirmMessage={`Delete “${walletName}”? This can't be undone.`}
            />
          )}
        </div>
      </Popover>
    </div>
  );
}
