"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { cn } from "@/lib/cn";

/** Keeps the panel this far from the viewport edges when it would otherwise stick out. */
const VIEWPORT_GUTTER = 8;
/** The gap between the anchor and the panel (`mt-2` / `mb-2`). */
const PANEL_GAP = 8;

export type PopoverPlacement = "below" | "above";

/**
 * Whether the panel opens under its anchor (the default) or above it: above only when it does not fit below and
 * there is more room above. `anchor` is the anchor's top / bottom and `bounds` the visible band's top / bottom (the
 * viewport, narrowed by any ancestor that clips overflow), all in viewport pixels.
 */
export function choosePlacement({
  anchor,
  bounds,
  panelHeight,
  gap = PANEL_GAP,
  gutter = VIEWPORT_GUTTER,
}: {
  anchor: { top: number; bottom: number };
  bounds: { top: number; bottom: number };
  panelHeight: number;
  gap?: number;
  gutter?: number;
}): PopoverPlacement {
  const below = bounds.bottom - gutter - (anchor.bottom + gap);
  const above = anchor.top - gap - (bounds.top + gutter);
  return panelHeight > below && above > below ? "above" : "below";
}

/** The visible vertical band around `el`: the viewport, cut down by every ancestor that clips its overflow. */
function visibleBounds(el: HTMLElement): { top: number; bottom: number } {
  let top = 0;
  let bottom = window.innerHeight;
  for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
    if (getComputedStyle(node).overflowY === "visible") continue;
    const rect = node.getBoundingClientRect();
    top = Math.max(top, rect.top);
    bottom = Math.min(bottom, rect.bottom);
  }
  return { top, bottom };
}

export type PopoverProps = {
  open: boolean;
  /** Called on Escape, on a pointer-down outside `anchor`, and when focus moves outside `anchor`. */
  onClose: () => void;
  /**
   * The positioned (`relative`) wrapper around the trigger; the panel renders inside it, under (or above) the
   * trigger, and anything inside it does not count as "outside".
   */
  anchor: RefObject<HTMLElement | null>;
  /** Focus goes back here when the popover closes from inside (Escape, a choice made in the panel). */
  trigger: RefObject<HTMLElement | null>;
  /**
   * Left-aligned (`start`) or right-aligned (`end`) with the trigger; nudged back inside a narrow viewport. The panel
   * opens under the trigger, or above it when it does not fit below and there is more room above.
   */
  align?: "start" | "end";
  id?: string;
  role?: "dialog" | "listbox" | "menu";
  "aria-label"?: string;
  /** For a `listbox` whose options toggle (several can be selected). */
  "aria-multiselectable"?: boolean;
  className?: string;
  children: ReactNode;
};

/**
 * A small anchored popover: no portal, absolutely positioned under its anchor, or above it when there is no room
 * below (measured on open and again on resize, on scroll and when the panel's size changes). Renders nothing when
 * closed. Non-modal: Tab can leave it (which closes it), and it does not trap focus.
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
  "aria-multiselectable": multiselectable,
}: PopoverProps & { onDismiss: (restoreFocus: boolean) => void }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const onDismissRef = useRef(onDismiss);
  const [placement, setPlacement] = useState<PopoverPlacement>("below");

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
      if (inside(e.target)) return;
      // Focus landing on a container of the popover (e.g. the Dialog's panel) is not leaving it: WebKit moves focus
      // there when the focused element inside is removed (a day cell replaced by the next month's), and that must not
      // close the picker. A click there still does (pointerdown).
      if (e.type === "focusin" && e.target instanceof Node && anchor.current && e.target.contains(anchor.current)) return;
      onDismissRef.current(false);
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

  // Keep the panel inside the viewport at phone widths (no horizontal page scroll) by shifting it sideways, and open
  // it upwards when it does not fit below. Measured before paint on open, then again on resize, scroll (any
  // container: the dialog's body moves the anchor too) and when the panel's own size changes (the month view).
  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const panel = el;
    function place() {
      // Measure the unshifted panel: StrictMode runs this twice in development, and measuring an already shifted
      // panel found a sub-pixel overflow and overwrote the shift with `translateX(0px)`.
      panel.style.transform = "";
      const rect = panel.getBoundingClientRect();
      const width = document.documentElement.clientWidth;
      let dx = 0;
      if (rect.right > width - VIEWPORT_GUTTER) dx = width - VIEWPORT_GUTTER - rect.right;
      if (rect.left + dx < VIEWPORT_GUTTER) dx = VIEWPORT_GUTTER - rect.left;
      if (dx !== 0) panel.style.transform = `translateX(${Math.round(dx)}px)`;

      const box = anchor.current;
      if (box) {
        setPlacement(
          choosePlacement({ anchor: box.getBoundingClientRect(), bounds: visibleBounds(box), panelHeight: rect.height }),
        );
      }
    }
    place();

    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(place);
    };
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    observer?.observe(panel);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      observer?.disconnect();
    };
  }, [anchor]);

  return (
    <div
      ref={panelRef}
      id={id}
      role={role}
      aria-label={ariaLabel}
      aria-multiselectable={multiselectable || undefined}
      data-placement={placement}
      className={cn(
        "absolute z-30 rounded-2xl border border-border bg-surface p-3 text-foreground",
        "shadow-lg shadow-black/10 dark:shadow-black/50",
        placement === "above" ? "bottom-full mb-2" : "top-full mt-2",
        align === "end" ? "right-0" : "left-0",
        className,
      )}
    >
      {children}
    </div>
  );
}
