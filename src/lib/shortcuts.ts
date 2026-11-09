// Pure keyboard-shortcut rules (client-safe; tested in tests/shell.test.ts).

/** The parts of a keydown event the shortcut rules read; a real KeyboardEvent fits. */
export type ShortcutEvent = {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  defaultPrevented?: boolean;
  target: EventTarget | null;
};

type ElementLike = {
  tagName?: string;
  isContentEditable?: boolean;
  closest?: (selector: string) => unknown;
};

/** Where typing is text entry, or where a dialog owns the keyboard: shortcuts stay off there. */
const BLOCKING_ANCESTOR = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="dialog"][aria-modal="true"]';

/**
 * True when a keydown should open the Add dialog: "n" or "N" (Shift is allowed, so Caps Lock works), no Ctrl /
 * Alt / Meta (browser and OS shortcuts keep working), not auto-repeat or IME composition, not already handled, and
 * not typed into an input, textarea, select or contenteditable, nor inside an open modal dialog.
 */
export function isNewEntryShortcut(e: ShortcutEvent): boolean {
  return plainKey(e, (k) => k === "n" || k === "N");
}

/**
 * "[" = the previous month, "]" = the next one, "t" / "T" = back to this month (Shift is not a modifier here: some
 * layouts need it for the brackets, and Caps Lock gives "T"). Same guards as N.
 */
export function monthStepShortcut(e: ShortcutEvent): "prev" | "next" | "current" | null {
  if (!plainKey(e, (k) => k === "[" || k === "]" || k === "t" || k === "T")) return null;
  return e.key === "[" ? "prev" : e.key === "]" ? "next" : "current";
}

function plainKey(e: ShortcutEvent, matches: (key: string) => boolean): boolean {
  if (!matches(e.key)) return false;
  if (e.altKey || e.ctrlKey || e.metaKey || e.repeat || e.isComposing || e.defaultPrevented) return false;
  const target = e.target as ElementLike | null;
  if (!target) return true;
  if (target.isContentEditable) return false;
  const tag = target.tagName?.toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return false;
  if (typeof target.closest === "function" && target.closest(BLOCKING_ANCESTOR)) return false;
  return true;
}
