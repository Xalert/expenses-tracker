// After a kind change the row moves to the other kind's card on /categories; that card is told through a window event
// (no DOM in tests: the pieces are checked on their own; the focus move itself needs a browser, see DECISIONS "Not
// verified").
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CATEGORY_MOVED_EVENT,
  announceCategoryMoved,
  isMovedInto,
  movedRowButton,
} from "@/components/categories/category-move";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("category moved between cards", () => {
  it("dispatches one event on window with the target kind, the id and the message", () => {
    const target = new EventTarget();
    vi.stubGlobal("window", target);
    const seen: unknown[] = [];
    target.addEventListener(CATEGORY_MOVED_EVENT, (e) => seen.push((e as CustomEvent).detail));
    announceCategoryMoved({ kind: "income", id: 7, message: "“Pets” is now an income category." });
    expect(seen).toEqual([{ kind: "income", id: 7, message: "“Pets” is now an income category." }]);
  });

  it("only the card of the target kind takes it", () => {
    const detail = { kind: "income", id: 7, message: "moved" };
    expect(isMovedInto(detail, "income")).toBe(true);
    expect(isMovedInto(detail, "expense")).toBe(false);
    expect(isMovedInto(null, "income")).toBe(false);
    expect(isMovedInto({ kind: "income", id: "7", message: "x" }, "income")).toBe(false);
  });

  it("finds the moved row's button by its ExpandableRow id inside the card only", () => {
    const button = { focus() {} } as unknown as HTMLElement;
    const root = { querySelector: (sel: string) => (sel === '[data-expandable-row="7"]' ? button : null) } as unknown as ParentNode;
    expect(movedRowButton(root, 7)).toBe(button);
    expect(movedRowButton(root, 8)).toBeNull();
    expect(movedRowButton(null, 7)).toBeNull();
  });
});
