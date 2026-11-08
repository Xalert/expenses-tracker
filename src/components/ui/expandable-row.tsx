"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
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
};

const ExpandableListContext = createContext<ListContext | null>(null);
const ExpandableRowContext = createContext<RowContext | null>(null);

/** Clicking a row's button: open it, or close it when it already is the open one. */
export function toggleOpen(current: string | null, id: string): string | null {
  return current === id ? null : id;
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
  const panelId = useId();

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
        if (message) announce(message);
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
        onClick={() => setOpenId((current) => toggleOpen(current, id))}
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
        <div id={panelId} role="region" aria-label={panelLabel} data-expandable-open="">
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
