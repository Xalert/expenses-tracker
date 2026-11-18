"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { cn } from "@/lib/cn";

type ListContext = {
  openId: string | null;
  setOpenId: Dispatch<SetStateAction<string | null>>;
  announce(message: string): void;
};

type RowContext = {
  /** Close the row; focus goes back to its button unless `restoreFocus` is false. */
  close(opts?: { restoreFocus?: boolean }): void;
  /** Close the row after a successful save and announce `message` in the list's status line. */
  saved(message?: string): void;
  /**
   * The row is about to go away (a confirmed Delete): when it leaves the list, `message` is announced with the
   * focus move to the next row.
   */
  removing(message: string): void;
};

const ExpandableListContext = createContext<ListContext | null>(null);
const ExpandableRowContext = createContext<RowContext | null>(null);

/** Clicking a row's button: open it, or close it when it already is the open one. */
export function toggleOpen(current: string | null, id: string): string | null {
  return current === id ? null : id;
}

/**
 * Where focus goes when the row `id` leaves the list while it held the focus (or was open): the same row if it
 * came back elsewhere (a save that moved it to another day), else the rows after it, then the rows before it
 * (nearest first). `order` is every row id in document order just before the removal.
 */
export function focusCandidates(order: string[], id: string): string[] {
  const i = order.indexOf(id);
  if (i < 0) return [id];
  return [id, ...order.slice(i + 1), ...order.slice(0, i).reverse()];
}

/** The first of `candidates` still in the list (`present`), or null: focus the list heading then. */
export function pickFocusTarget(candidates: string[], present: (id: string) => boolean): string | null {
  return candidates.find(present) ?? null;
}

const ROW_ATTR = "data-expandable-row";
const FIELD_SELECTOR = [
  "input:not([type=hidden]):not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "button:not([disabled])",
  "a[href]",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

/** The first control of an opened panel; a radio group gives its checked option (as Tab would). */
function firstField(root: HTMLElement): HTMLElement | null {
  const first = root.querySelector<HTMLElement>(FIELD_SELECTOR);
  if (first instanceof HTMLInputElement && first.type === "radio" && !first.checked && first.name) {
    const checked = root.querySelector<HTMLInputElement>(`input[type=radio][name="${CSS.escape(first.name)}"]:checked`);
    if (checked) return checked;
  }
  return first;
}

/** A polite live region outside React, so the message survives the list itself unmounting (an emptied page). */
function announcePolitely(message: string) {
  let region = document.getElementById("expandable-row-announcer");
  if (!region) {
    region = document.createElement("div");
    region.id = "expandable-row-announcer";
    region.setAttribute("role", "status");
    region.setAttribute("aria-live", "polite");
    region.className = "sr-only";
    document.body.appendChild(region);
  }
  const target = region;
  target.textContent = "";
  // A beat later, so screen readers notice the change in a region that may have just been created.
  window.setTimeout(() => {
    target.textContent = message;
  }, 100);
}

/**
 * After a row that held the focus left the DOM: once the update has landed, focus the row `pickFocusTarget` gives
 * (its button), else the list heading (`[data-list-heading]`, else the page's `<h1>`). Only when the focus was
 * actually lost (it is on `<body>`) and the page is still the one the row was on.
 */
function restoreFocusAfterRemoval(order: string[], id: string, pathname: string, notice: string | null) {
  window.setTimeout(() => {
    if (window.location.pathname !== pathname) return;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    const button = (rowId: string) => document.querySelector<HTMLElement>(`[${ROW_ATTR}="${CSS.escape(rowId)}"]`);
    const target = pickFocusTarget(focusCandidates(order, id), (rowId) => button(rowId) !== null);
    if (target === id) {
      button(id)?.focus();
      return;
    }
    if (target !== null) {
      button(target)?.focus();
    } else {
      const heading = document.querySelector<HTMLElement>("[data-list-heading]") ?? document.querySelector<HTMLElement>("main h1");
      if (heading) {
        if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
        heading.focus();
      }
    }
    announcePolitely(
      `${notice ?? "That entry is no longer in this list."} ${target !== null ? "Focus is on the next entry." : "The list is empty."}`,
    );
  }, 0);
}

/**
 * Holds which `ExpandableRow` inside it is open: one at a time across the whole list (every day group of a page).
 * Renders no element of its own apart from a visually hidden `role="status"` line that `saved(message)` fills.
 */
export function ExpandableList({ children, defaultOpenId = null }: { children: ReactNode; defaultOpenId?: string | null }) {
  const [openId, setOpenId] = useState<string | null>(defaultOpenId);
  const [status, setStatus] = useState("");
  const value = useMemo<ListContext>(() => ({ openId, setOpenId, announce: setStatus }), [openId]);
  return (
    <ExpandableListContext.Provider value={value}>
      {children}
      <p role="status" className="sr-only">
        {status}
      </p>
    </ExpandableListContext.Provider>
  );
}

/**
 * A list row (`<li>`) whose content is a `<button aria-expanded>`; activating it opens `panel` under the row (the
 * open row gets `bg-surface-open`). Escape inside the row (unless something inside handled it first, e.g. an open
 * date picker) or the panel's own Cancel (`useExpandableRow().close()`) closes it and returns focus to the button.
 * `panel` is only rendered while open, so a heavy form costs nothing for closed rows. Must sit in an
 * `ExpandableList`.
 */
export function ExpandableRow({
  id,
  summary,
  panel,
  panelLabel,
  className,
  buttonClassName,
  after,
}: {
  /** Unique within the list. */
  id: string;
  /** The row's content, inside the button (phrasing content only). */
  summary: ReactNode;
  panel: ReactNode;
  /** Accessible name of the panel region, e.g. "Edit Food, €12.40". */
  panelLabel: string;
  className?: string;
  buttonClassName?: string;
  /** Rendered after the button, outside it (e.g. a `<noscript>` link). */
  after?: ReactNode;
}) {
  const list = useContext(ExpandableListContext);
  if (!list) throw new Error("ExpandableRow must be inside an ExpandableList.");
  const { openId, setOpenId, announce } = list;
  const open = openId === id;
  const rowRef = useRef<HTMLLIElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  // Set by a click that opens the row: focus moves into the panel once it has rendered.
  const focusOnOpen = useRef(false);
  // Read by the unmount cleanup below (it has no fresh props then).
  const openRef = useRef(open);
  const pathnameRef = useRef("");
  const noticeRef = useRef<string | null>(null);

  useLayoutEffect(() => {
    openRef.current = open;
    pathnameRef.current = window.location.pathname;
  });

  useEffect(() => {
    if (!open || !focusOnOpen.current) return;
    focusOnOpen.current = false;
    const panel = panelRef.current;
    if (panel) firstField(panel)?.focus();
  }, [open]);

  // Leaving the DOM (a Delete, or a save that moved the entry off this page or month) while the row held the focus
  // or was open: hand the focus to a neighbour instead of letting it fall back to <body>. A layout-effect cleanup
  // runs before React detaches the row's nodes, so the neighbours can still be read in document order here.
  useLayoutEffect(() => {
    const row = rowRef.current;
    return () => {
      if (!row || !row.isConnected) return;
      const active = document.activeElement;
      if (!openRef.current && !(active && row.contains(active))) return;
      const order = [...document.querySelectorAll<HTMLElement>(`[${ROW_ATTR}]`)].map((el) => el.getAttribute(ROW_ATTR)!);
      restoreFocusAfterRemoval(order, id, pathnameRef.current, noticeRef.current);
    };
  }, [id]);

  const close = useCallback(
    (opts: { restoreFocus?: boolean } = {}) => {
      setOpenId((current) => (current === id ? null : current));
      if (opts.restoreFocus !== false) buttonRef.current?.focus();
    },
    [id, setOpenId],
  );

  useEffect(() => {
    if (!open) return;
    // On window, so handlers on the document (the date picker's popover) see Escape first and can claim it.
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (!(e.target instanceof Node) || !rowRef.current?.contains(e.target)) return;
      e.preventDefault();
      close();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, close]);

  const row = useMemo<RowContext>(
    () => ({
      close,
      saved(message) {
        close();
        if (message) {
          announce(message);
          noticeRef.current = `${message}. It is no longer in this list.`;
        }
      },
      removing(message) {
        noticeRef.current = message;
      },
    }),
    [close, announce],
  );

  return (
    <li ref={rowRef} className={cn(open && "bg-surface-open", className) || undefined}>
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        {...{ [ROW_ATTR]: id }}
        onClick={() => {
          focusOnOpen.current = !open;
          setOpenId((current) => toggleOpen(current, id));
        }}
        className={cn(
          "flex w-full items-center gap-3 text-left transition-colors",
          "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
          !open && "hover:bg-surface-open",
          buttonClassName,
        )}
      >
        {summary}
      </button>
      {after}
      {open && (
        <div ref={panelRef} id={panelId} role="region" aria-label={panelLabel} data-expandable-open="">
          <ExpandableRowContext.Provider value={row}>{panel}</ExpandableRowContext.Provider>
        </div>
      )}
    </li>
  );
}

/** For the panel of an `ExpandableRow`: close it (Cancel) or close it after a save. */
export function useExpandableRow(): RowContext {
  const row = useContext(ExpandableRowContext);
  if (!row) throw new Error("useExpandableRow must be used inside an ExpandableRow's panel.");
  return row;
}
