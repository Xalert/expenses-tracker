"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { XIcon } from "./picker-icons";

export type DialogProps = {
  title: ReactNode;
  /** A line under the title (e.g. the wallet being edited). */
  description?: ReactNode;
  /** Escape, the ✕ and a click on the scrim call this. Default: `router.back()` (the intercepted-route pattern). */
  onClose?: () => void;
  /** Panel width from `sm` up (a bottom sheet is always full width). Default `max-w-xl`. */
  className?: string;
  children: ReactNode;
};

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

/**
 * A modal dialog: `role="dialog"`, `aria-modal`, labelled by its title. Focus moves into it and is trapped there;
 * Escape, the ✕ and the scrim close it; the page behind cannot scroll. A bottom sheet below `sm`, a centred panel
 * above. No portal: it is `fixed`, and the `@modal` slot renders it outside the page's own markup.
 *
 * Used by the intercepted routes in `(app)/@modal`. It hides itself as soon as the URL leaves the path it was
 * opened at, so a form inside that redirects on success (or a link inside it) never leaves a stale dialog over the
 * next page. The slot's null pages do the same job at the routing level (see `@modal/default.tsx`); this is the
 * second guard.
 */
export function Dialog(props: DialogProps) {
  const pathname = usePathname();
  const [openedAt] = useState(pathname);
  if (pathname !== openedAt) return null;
  return <DialogPanel {...props} />;
}

function DialogPanel({ title, description, onClose, className, children }: DialogProps) {
  const router = useRouter();
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const onCloseRef = useRef<() => void>(() => {});

  useEffect(() => {
    onCloseRef.current = onClose ?? (() => router.back());
  });

  // Focus in on open, back to where it was on close; lock the page's scroll meanwhile.
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // From `sm` up a control marked `data-autofocus` (the Add form's amount) takes focus; on phones the panel does,
    // so the keyboard does not open over half the bottom sheet before the person has seen it.
    const wide = window.matchMedia("(min-width: 640px)").matches;
    const first = wide ? panelRef.current?.querySelector<HTMLElement>("[data-autofocus]") : null;
    (first ?? panelRef.current)?.focus({ preventScroll: true });

    const root = document.documentElement;
    const scrollbar = window.innerWidth - root.clientWidth;
    const saved = { overflow: root.style.overflow, paddingRight: root.style.paddingRight };
    root.style.overflow = "hidden";
    if (scrollbar > 0) root.style.paddingRight = `${scrollbar}px`;

    return () => {
      root.style.overflow = saved.overflow;
      root.style.paddingRight = saved.paddingRight;
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    // On window, so it runs after document-level handlers: an open popover inside (the date picker) closes on
    // Escape first and marks the event handled, and the dialog stays open.
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && !e.defaultPrevented) {
        e.preventDefault();
        onCloseRef.current();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Keep Tab inside the panel.
  function onPanelKeyDown(e: React.KeyboardEvent) {
    if (e.key !== "Tab" || !panelRef.current) return;
    const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (el) => el.getClientRects().length > 0,
    );
    if (focusable.length === 0) {
      e.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === panelRef.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-6">
      {/* The scrim: a click outside the panel closes, like Escape. Not focusable; the ✕ is the keyboard path. */}
      <div aria-hidden="true" className="absolute inset-0 bg-scrim" onClick={() => onCloseRef.current()} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        onKeyDown={onPanelKeyDown}
        className={cn(
          "relative flex max-h-[92dvh] w-full flex-col overflow-hidden bg-surface text-foreground outline-none",
          "rounded-t-3xl shadow-[0_-8px_40px_rgba(0,0,0,0.18)]",
          "sm:max-h-[min(88dvh,900px)] sm:rounded-3xl sm:shadow-[0_24px_80px_rgba(0,0,0,0.28)]",
          className ?? "sm:max-w-xl",
        )}
      >
        {/* Drag handle: decorative, the sheet is closed with ✕, Escape or the scrim. */}
        <div aria-hidden="true" className="mx-auto mt-2.5 h-1.5 w-10 shrink-0 rounded-full bg-border-strong sm:hidden" />
        <div className="flex shrink-0 items-start justify-between gap-3 px-5 pt-3 pb-2 sm:px-7 sm:pt-6">
          <div className="min-w-0">
            <h2 id={titleId} className="text-xl font-extrabold tracking-tight text-foreground">
              {title}
            </h2>
            {description && (
              <p id={descriptionId} className="mt-0.5 truncate text-sm text-muted-foreground">
                {description}
              </p>
            )}
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={() => onCloseRef.current()}
            className="-mr-1.5 inline-flex size-10 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-surface-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <XIcon className="size-5" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pt-2 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:px-7 sm:pb-7">
          {children}
        </div>
      </div>
    </div>
  );
}
