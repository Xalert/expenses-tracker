import type { CategoryKind } from "@/db/schema";

// Pure parsing for the category Server Actions (kept out of the "use server" file so it can be tested).
// Name rules (trim, collapse whitespace, 1–40 chars, unique ignoring case) live in the service.

/** A bound `kind` argument: only "expense" or "income". */
export function parseCategoryKind(value: unknown): CategoryKind | null {
  return value === "expense" || value === "income" ? value : null;
}

/** Category id from a bound argument or form value; null unless a positive safe integer. */
export function parseCategoryId(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && /^\d{1,15}$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Raw `name` field (the service normalises and validates it). */
export function nameField(formData: FormData): string {
  const v = formData.get("name");
  return typeof v === "string" ? v : "";
}

/** The replacement select's value for "a new category" (then `moveToNewCategoryName` holds its name). */
export const NEW_CATEGORY_VALUE = "new";

/**
 * `moveToCategoryId` field: missing/empty/"new" → undefined (no existing replacement chosen), a valid id → that id,
 * anything else → 0, which the service rejects as an invalid replacement.
 */
export function parseMoveTo(formData: FormData): number | undefined {
  const raw = formData.get("moveToCategoryId");
  if (raw === null || raw === "" || raw === NEW_CATEGORY_VALUE) return undefined;
  return parseCategoryId(raw) ?? 0;
}

/**
 * The removal's replacement: an existing category (`moveToCategoryId`), or a new one named by `moveToNewCategoryName`
 * — used when the select says "new" or when the form has no select (the category is the only active one of its
 * kind, so the name field is all there is).
 */
export function parseReplacement(formData: FormData): { moveToCategoryId?: number; moveToNewCategoryName?: string } {
  const select = formData.get("moveToCategoryId");
  const name = formData.get("moveToNewCategoryName");
  if ((select === null || select === NEW_CATEGORY_VALUE) && typeof name === "string") {
    return { moveToNewCategoryName: name };
  }
  const moveToCategoryId = parseMoveTo(formData);
  return moveToCategoryId === undefined ? {} : { moveToCategoryId };
}
