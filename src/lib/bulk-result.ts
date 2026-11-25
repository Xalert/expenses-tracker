// The outcome of a bulk edit on /transactions, carried in the list URL after the action redirects (`?done=…`), so the
// result line shows with and without JavaScript. Only numbers and ids travel; names are looked up by the page, so a
// hand-made URL can only produce a wrong count, never arbitrary text. Pure (tested in tests/bulk-ui.test.tsx).

export type BulkOutcome =
  | { op: "delete"; entries: number; transfers: number }
  | { op: "category"; categoryId: number; changed: number; unchanged: number; otherKind: number; transfers: number }
  | { op: "addTag"; tagId: number; added: number; already: number; atLimit: number; transfers: number }
  | { op: "removeTag"; tagId: number; removed: number; notTagged: number; transfers: number };

const CODES = { delete: "d", category: "c", addTag: "t", removeTag: "r" } as const;

export function encodeOutcome(o: BulkOutcome): string {
  switch (o.op) {
    case "delete":
      return [CODES.delete, o.entries, o.transfers].join(".");
    case "category":
      return [CODES.category, o.categoryId, o.changed, o.unchanged, o.otherKind, o.transfers].join(".");
    case "addTag":
      return [CODES.addTag, o.tagId, o.added, o.already, o.atLimit, o.transfers].join(".");
    case "removeTag":
      return [CODES.removeTag, o.tagId, o.removed, o.notTagged, o.transfers].join(".");
  }
}

/** The outcome in `?done=`, or null for anything malformed. */
export function decodeOutcome(value: string | undefined): BulkOutcome | null {
  if (!value || value.length > 80) return null;
  const [code, ...rest] = value.split(".");
  if (!rest.every((x) => /^\d{1,9}$/.test(x))) return null;
  const n = rest.map(Number);
  if (code === CODES.delete && n.length === 2) return { op: "delete", entries: n[0], transfers: n[1] };
  if (code === CODES.category && n.length === 5) {
    return { op: "category", categoryId: n[0], changed: n[1], unchanged: n[2], otherKind: n[3], transfers: n[4] };
  }
  if (code === CODES.addTag && n.length === 5) {
    return { op: "addTag", tagId: n[0], added: n[1], already: n[2], atLimit: n[3], transfers: n[4] };
  }
  if (code === CODES.removeTag && n.length === 4) {
    return { op: "removeTag", tagId: n[0], removed: n[1], notTagged: n[2], transfers: n[3] };
  }
  return null;
}

const count = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const entries = (n: number) => count(n, "entry", "entries");
const transfersSkipped = (n: number) => (n > 0 ? [`${count(n, "transfer", "transfers")} skipped`] : []);

/**
 * "Moved 42 entries to Groceries; 3 transfers skipped." — the result line. `names` holds what the page knows about
 * the category / tag of the outcome (missing: it has gone since, and the line says "the category" / "the tag").
 */
export function describeOutcome(
  o: BulkOutcome,
  names: { category?: { name: string; kind: "expense" | "income" }; tag?: string } = {},
): string {
  const sentence = (head: string, rest: string[]) => `${[head, ...rest].join("; ")}.`;
  switch (o.op) {
    case "delete":
      return `Deleted ${selectionText(o)}${o.transfers > 0 ? " (both sides of each transfer)" : ""}.`;
    case "category": {
      const name = names.category?.name ?? "the category";
      const other =
        o.otherKind > 0
          ? [
              names.category
                ? `${o.otherKind.toLocaleString("en-US")} ${names.category.kind === "expense" ? (o.otherKind === 1 ? "income entry" : "income entries") : o.otherKind === 1 ? "expense" : "expenses"} skipped`
                : `${entries(o.otherKind)} of the other kind skipped`,
            ]
          : [];
      return sentence(`Moved ${entries(o.changed)} to ${name}`, [
        ...(o.unchanged > 0 ? [`${o.unchanged.toLocaleString("en-US")} ${o.unchanged === 1 ? "was" : "were"} already in it`] : []),
        ...other,
        ...transfersSkipped(o.transfers),
      ]);
    }
    case "addTag": {
      const tag = names.tag ? `“${names.tag}”` : "the tag";
      return sentence(`Added ${tag} to ${entries(o.added)}`, [
        ...(o.already > 0 ? [`${o.already.toLocaleString("en-US")} already had it`] : []),
        ...(o.atLimit > 0 ? [`${entries(o.atLimit)} skipped (already at 10 tags)`] : []),
        ...transfersSkipped(o.transfers),
      ]);
    }
    case "removeTag": {
      const tag = names.tag ? `“${names.tag}”` : "the tag";
      return sentence(`Removed ${tag} from ${entries(o.removed)}`, [
        ...(o.notTagged > 0 ? [`${o.notTagged.toLocaleString("en-US")} did not have it`] : []),
        ...transfersSkipped(o.transfers),
      ]);
    }
  }
}

/** "12 entries and 3 transfers", "1 entry", "2 transfers". */
export function selectionText(sel: { entries: number; transfers: number }): string {
  return (
    [sel.entries > 0 ? entries(sel.entries) : null, sel.transfers > 0 ? count(sel.transfers, "transfer", "transfers") : null]
      .filter(Boolean)
      .join(" and ") || "nothing"
  );
}

/** The delete confirmation: the counts the server found, no undo, and where the backup is. */
export function deleteConfirmText(sel: { entries: number; transfers: number }): string {
  const what = selectionText(sel);
  const both = sel.transfers > 0 ? ` Each transfer goes with both of its sides (${count(sel.transfers * 2, "row", "rows")}).` : "";
  return `Delete ${what}?${both} There is no undo: download a backup on the Data page first if you may want them back.`;
}
