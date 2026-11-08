"use client";

import { useEffect, useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { cn } from "@/lib/cn";

/** Keeps the panel this far from the viewport edges when it would otherwise stick out. */
const VIEWPORT_GUTTER = 8;

export type PopoverProps = {
  open: boolean;
  /** Called on Escape, on a pointer-down outside `anchor`, and when focus moves outside `anchor`. */
  onClose: () => void;
  /**
   * The positioned (`relative`) wrapper around the trigger; the panel renders inside it, under the trigger, and
   * anything inside it does not count as "outside".
   */
  anchor: RefObject<HTMLElement | null>;
  /** Focus goes back here when the popover closes from inside (Escape, a choice made in the panel). */
  trigger: RefObject<HTMLElement | null>;
  /** Left-aligned (`start`) or right-aligned (`end`) under the trigger; nudged back inside a narrow viewport. */
  align?: "start" | "end";
  id?: string;
  role?: "dialog";
  "aria-label"?: string;
  className?: string;
  children: ReactNode;
};

/**
 * A small anchored popover: no portal, absolutely positioned under its anchor. Renders nothing when closed.
 * Non-modal: Tab can leave it (which closes it), and it does not trap focus.
 */
export function Popover(props: PopoverProps) {
  const { open, trigger } = props;
  // False when the popover closed because the user clicked or tabbed somewhere else: focus stays where they put it.
  const restoreFocus = useRef(true);
  const wasOpen = useRef(false);

  // Runs after the panel has been removed, so focus that was inside it has already dropped to <body>. Kept out of
  // the panel's own effect cleanup so StrictMode's mount → unmount → mount check does not steal focus.
  useEffect(() => {
    if (open) {
      restoreFocus.current = true;
    } else if (wasOpen.current && restoreFocus.current) {
      const active = document.activeElement;
      if (!active || active === document.body) trigger.current?.focus();
    }
    wasOpen.current = open;
  }, [open, trigger]);

  if (!open) return null;
  return (
    <PopoverPanel
      {...props}
      onDismiss={(restore) => {
        restoreFocus.current = restore;
        props.onClose();
      }}
    />
  );
}

function PopoverPanel({
  onDismiss,
  anchor,
  align = "start",
  id,
  role,
  className,
  children,
  "aria-label": ariaLabel,
}: PopoverProps & { onDismiss: (restoreFocus: boolean) => void }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const onDismissRef = useRef(onDismiss);

  useEffect(() => {
    onDismissRef.current = onDismiss;
  });

  useEffect(() => {
    const inside = (target: EventTarget | null) => target instanceof Node && Boolean(anchor.current?.contains(target));

    function onKeyDown(e: KeyboardEvent) {
      // A panel can claim Escape for itself (the date picker's month view steps back) by preventing its default.
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      onDismissRef.current(true);
    }
    function onOutside(e: Event) {
      if (!inside(e.target)) onDismissRef.current(false);
    }

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onOutside);
    document.addEventListener("focusin", onOutside);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onOutside);
      document.removeEventListener("focusin", onOutside);
    };
  }, [anchor]);

  // Keep the panel inside the viewport at phone widths (no horizontal page scroll): shift it sideways if needed.
  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const width = document.documentElement.clientWidth;
    let dx = 0;
    if (rect.right > width - VIEWPORT_GUTTER) dx = width - VIEWPORT_GUTTER - rect.right;
    if (rect.left + dx < VIEWPORT_GUTTER) dx = VIEWPORT_GUTTER - rect.left;
    if (dx !== 0) el.style.transform = `translateX(${Math.round(dx)}px)`;
  }, []);

  return (
    <div
      ref={panelRef}
      id={id}
      role={role}
      aria-label={ariaLabel}
      className={cn(
        "absolute top-full z-30 mt-2 rounded-2xl border border-border bg-surface p-3 text-foreground",
        "shadow-lg shadow-black/10 dark:shadow-black/50",
        align === "end" ? "right-0" : "left-0",
        className,
      )}
    >
      {children}
    </div>
  );
}
