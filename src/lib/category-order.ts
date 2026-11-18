// The one order categories are listed in, everywhere (pickers, /categories, filters, ties in rankings). Pure.
//
// Names are compared lower-cased, by Unicode code point: not `localeCompare` (which differs between runtimes and
// locales) and not SQL `lower(name)` (whose result for non-ASCII names, and whose order, depend on the database's
// collation and ctype). So the same account lists its categories the same way on every instance.

/** Lower-cased names by code point: < 0 when `a` comes first, 0 when they are equal ignoring case. */
export function compareCategoryNames(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x === y) return 0;
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const cx = x.codePointAt(i)!;
    const cy = y.codePointAt(i)!;
    if (cx !== cy) return cx < cy ? -1 : 1;
    if (cx > 0xffff) i++; // both strings have the same surrogate pair here
  }
  return x.length < y.length ? -1 : 1;
}

type Listed = { id: number; name: string; kind: "expense" | "income"; archivedAt: Date | null };

/** Expense before income, active before archived, then by name (`compareCategoryNames`), then id. */
export function compareCategories(a: Listed, b: Listed): number {
  return (
    (a.kind === b.kind ? 0 : a.kind === "expense" ? -1 : 1) ||
    Number(a.archivedAt !== null) - Number(b.archivedAt !== null) ||
    compareCategoryNames(a.name, b.name) ||
    a.id - b.id
  );
}

/** A sorted copy (`compareCategories`). */
export function sortCategories<T extends Listed>(rows: readonly T[]): T[] {
  return [...rows].sort(compareCategories);
}
