// After a kind change a category's row leaves its card (Expense / Income) for the other one. The two cards are
// separate components, so the one the row left tells the other through a window event; that card announces the
// change in its own status line and moves focus to the row once the refreshed list has it. Browser-only helpers,
// kept apart from the components so the matching rule is testable without a DOM.

export const CATEGORY_MOVED_EVENT = "categories:moved";

export type CategoryMoved = { kind: "expense" | "income"; id: number; message: string };

/** Tell the card of `kind` that category `id` moved into it (call after the server confirmed the change). */
export function announceCategoryMoved(detail: CategoryMoved): void {
  window.dispatchEvent(new CustomEvent<CategoryMoved>(CATEGORY_MOVED_EVENT, { detail }));
}

/** The moved row's button inside `root` (the card), or null while the refreshed list has not arrived yet. */
export function movedRowButton(root: ParentNode | null, id: number): HTMLElement | null {
  return root?.querySelector<HTMLElement>(`[data-expandable-row="${String(id)}"]`) ?? null;
}

/** Whether an event is meant for the card of `kind` (and well-formed). */
export function isMovedInto(detail: unknown, kind: "expense" | "income"): detail is CategoryMoved {
  if (typeof detail !== "object" || detail === null) return false;
  const d = detail as Partial<CategoryMoved>;
  return d.kind === kind && typeof d.id === "number" && typeof d.message === "string";
}
