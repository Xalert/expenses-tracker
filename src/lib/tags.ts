// Tag names (pure; shared by the services, the importer and the entry form). A tag is a free label on an expense or
// income ("holiday 2026", "reimbursable"); see SPEC "Tags".

export const MAX_TAG_NAME_LENGTH = 40;
export const MAX_TAGS_PER_ENTRY = 10;
/** What separates tags in the entry form's text field and in the CSV `tags` cell (written as ", "). */
export const TAG_SEPARATOR = ",";

/** Trimmed, inner whitespace collapsed (the way category names are). */
export function cleanTagName(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

/** Why `name` (already cleaned) is not a valid tag name, or null. */
export function tagNameProblem(name: string): string | null {
  if (!name) return "Enter a tag name.";
  if (name.includes(TAG_SEPARATOR)) return "A tag name cannot contain a comma.";
  if (name.length > MAX_TAG_NAME_LENGTH) {
    return `Keep each tag to ${MAX_TAG_NAME_LENGTH} characters or fewer (“${name.slice(0, 20)}…” is longer).`;
  }
  return null;
}

/** Case-folded key tags are matched on (the database's unique index is on `lower(name)`). */
export const tagKey = (name: string) => name.toLowerCase();

/**
 * The names in a comma-separated text ("holiday 2026, Reimbursable"): split on commas, cleaned, blanks dropped and
 * repeats (ignoring case) dropped, keeping the first spelling and the order. Length is not checked here.
 */
export function splitTagInput(raw: string): string[] {
  return dedupeTagNames(raw.split(TAG_SEPARATOR).map(cleanTagName));
}

/** Cleaned, blank and case-insensitive repeats dropped (the first spelling wins), order kept. */
export function dedupeTagNames(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    const name = cleanTagName(raw);
    if (!name || seen.has(tagKey(name))) continue;
    seen.add(tagKey(name));
    out.push(name);
  }
  return out;
}

/**
 * The first problem with an entry's tag list (each name valid, at most `MAX_TAGS_PER_ENTRY` after dropping repeats),
 * or null. `names` should already be split and deduped (`splitTagInput`).
 */
export function tagListProblem(names: readonly string[]): string | null {
  for (const n of names) {
    const problem = tagNameProblem(n);
    if (problem) return problem;
  }
  if (names.length > MAX_TAGS_PER_ENTRY) return `An entry can have at most ${MAX_TAGS_PER_ENTRY} tags.`;
  return null;
}

/** Display / storage order: lower-cased name by code point, then as given (stable). */
export function sortTagNames(names: readonly string[]): string[] {
  return [...names].sort((a, b) => {
    const x = tagKey(a);
    const y = tagKey(b);
    return x < y ? -1 : x > y ? 1 : 0;
  });
}

/** The text of an entry's tags in a form field or a CSV cell: "holiday 2026, reimbursable". */
export function joinTags(names: readonly string[]): string {
  return names.join(`${TAG_SEPARATOR} `);
}
