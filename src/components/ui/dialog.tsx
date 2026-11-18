"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type PointerEvent, type ReactNode, type RefObject } from "react";
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

/** A release faster than this (px per ms, downwards) closes the sheet even when it moved less than a third. */
const FLICK_VELOCITY = 0.5;
/** …provided it moved at least this far, so a tap with a twitch does not close it. */
const FLICK_MIN_DISTANCE = 24;
const SHEET_TRANSITION_MS = 200;

/**
 * What a released drag of the bottom sheet does: close when it was pulled down more than a third of the sheet's
 * height, or flicked down fast; otherwise snap back. `dy` is the downward distance (px), `velocity` the downward
 * speed at release (px/ms).
 */
export function sheetDragOutcome({ dy, height, velocity }: { dy: number; height: number; velocity: number }): "close" | "stay" {
  if (dy <= 0) return "stay";
  if (dy > height / 3) return "close";
  return velocity > FLICK_VELOCITY && dy >= FLICK_MIN_DISTANCE ? "close" : "stay";
}

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

  const drag = useSheetDrag(panelRef, () => onCloseRef.current());

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
        {/* The drag area: handle and header. On a phone, pulling it down closes the sheet (a pointer-only shortcut
            for ✕, Escape and the scrim). `touch-none` there only: the body below keeps its own scrolling. */}
        <div {...drag} data-sheet-drag="" className="shrink-0 touch-none sm:touch-auto">
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
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pt-2 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:px-7 sm:pb-7">
          {children}
        </div>
      </div>
    </div>
  );
}

/**
 * Drag-down-to-close for the bottom sheet (below `sm` only): pointer handlers for the handle + header area. The
 * panel follows the pointer downwards (never up), and on release either slides out and closes or springs back
 * (`sheetDragOutcome`). With `prefers-reduced-motion` it closes or snaps back without animating. A press on a
 * button or link in the header (the ✕) is left alone.
 */
function useSheetDrag(panelRef: RefObject<HTMLDivElement | null>, close: () => void) {
  const drag = useRef<{ id: number; startY: number; lastY: number; lastT: number; velocity: number } | null>(null);

  const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const setTransform = (value: string, animate: boolean) => {
    const panel = panelRef.current;
    if (!panel) return;
    panel.style.transition = animate ? `transform ${SHEET_TRANSITION_MS}ms ease-out` : "";
    panel.style.transform = value;
  };

  function end(e: PointerEvent<HTMLElement>, cancelled: boolean) {
    const state = drag.current;
    const panel = panelRef.current;
    if (!state || state.id !== e.pointerId || !panel) return;
    drag.current = null;
    const dy = Math.max(0, e.clientY - state.startY);
    const outcome = cancelled
      ? "stay"
      : sheetDragOutcome({ dy, height: panel.getBoundingClientRect().height, velocity: state.velocity });
    const animate = !reducedMotion();
    if (outcome === "stay") {
      setTransform("", animate && dy > 0);
      return;
    }
    if (!animate) {
      close();
      return;
    }
    setTransform("translateY(100%)", true);
    window.setTimeout(close, SHEET_TRANSITION_MS);
  }

  return {
    onPointerDown(e: PointerEvent<HTMLElement>) {
      if (e.button !== 0 || !window.matchMedia("(max-width: 639px)").matches) return;
      if (e.target instanceof Element && e.target.closest("button, a, input, select, textarea")) return;
      drag.current = { id: e.pointerId, startY: e.clientY, lastY: e.clientY, lastT: e.timeStamp, velocity: 0 };
      e.currentTarget.setPointerCapture?.(e.pointerId);
    },
    onPointerMove(e: PointerEvent<HTMLElement>) {
      const state = drag.current;
      if (!state || state.id !== e.pointerId) return;
      const dt = e.timeStamp - state.lastT;
      if (dt > 0) state.velocity = (e.clientY - state.lastY) / dt;
      state.lastY = e.clientY;
      state.lastT = e.timeStamp;
      setTransform(`translateY(${Math.max(0, e.clientY - state.startY)}px)`, false);
    },
    onPointerUp(e: PointerEvent<HTMLElement>) {
      end(e, false);
    },
    onPointerCancel(e: PointerEvent<HTMLElement>) {
      end(e, true);
    },
  };
}
