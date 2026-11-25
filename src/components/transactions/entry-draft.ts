// A typed-in entry kept in sessionStorage while the person visits /categories from the entry form ("Manage
// categories"), restored (once) when the same form opens again in this browser tab. Storage can be missing or throw
// (private windows, blocked site data), so every access is guarded and the form works without it.

export type EntryDraftKind = "expense" | "income" | "transfer";

/** The posted field names a draft keeps (the same names the form posts). */
export const DRAFT_FIELDS = [
  "amount",
  "receivedAmount",
  "walletId",
  "categoryId",
  "fromWalletId",
  "toWalletId",
  "date",
  "note",
  "tags",
] as const;

export type DraftField = (typeof DRAFT_FIELDS)[number];

export type EntryDraft = { kind: EntryDraftKind; values: Partial<Record<DraftField, string>> };

/** A draft older than this is dropped rather than restored. */
export const DRAFT_MAX_AGE_MS = 60 * 60 * 1000;

const PREFIX = "entry-draft:";

/**
 * Validates a stored draft against what the form offers now: a kind it allows, wallets and a category (of the
 * draft's kind) that still exist, a `YYYY-MM-DD` date, string values only. Anything else is dropped field by field;
 * a draft without a usable kind or too old is null.
 */
export function sanitizeDraft(
  raw: unknown,
  ctx: { kinds: readonly EntryDraftKind[]; walletIds: number[]; categories: { id: number; kind: string }[]; now: number },
): EntryDraft | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { kind?: unknown; values?: unknown; savedAt?: unknown };
  if (typeof r.kind !== "string" || !ctx.kinds.includes(r.kind as EntryDraftKind)) return null;
  if (typeof r.savedAt !== "number" || ctx.now - r.savedAt > DRAFT_MAX_AGE_MS || r.savedAt > ctx.now + 60_000) {
    return null;
  }
  const kind = r.kind as EntryDraftKind;
  const input = r.values && typeof r.values === "object" ? (r.values as Record<string, unknown>) : {};
  const values: EntryDraft["values"] = {};
  const wallet = (v: string) => ctx.walletIds.includes(Number(v));
  for (const field of DRAFT_FIELDS) {
    const v = input[field];
    if (typeof v !== "string" || v.length > 500) continue;
    if ((field === "walletId" || field === "fromWalletId" || field === "toWalletId") && !wallet(v)) continue;
    if (field === "categoryId" && !ctx.categories.some((c) => String(c.id) === v && c.kind === kind)) continue;
    if (field === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(v)) continue;
    values[field] = v;
  }
  return { kind, values };
}

/** Saves the form's current values under `key` (replacing an older draft). Silently does nothing without storage. */
export function saveEntryDraft(key: string, kind: EntryDraftKind, form: HTMLFormElement | null, now = Date.now()) {
  if (!form) return;
  try {
    const data = new FormData(form);
    const values: Record<string, string> = {};
    for (const field of DRAFT_FIELDS) {
      const v = data.get(field);
      if (typeof v === "string" && v !== "") values[field] = v;
    }
    window.sessionStorage.setItem(PREFIX + key, JSON.stringify({ kind, values, savedAt: now }));
  } catch {
    // no storage: the draft is simply not kept
  }
}

/** Reads and removes the draft under `key` (raw, unvalidated: pass it to `sanitizeDraft`). */
export function takeEntryDraft(key: string): unknown {
  try {
    const raw = window.sessionStorage.getItem(PREFIX + key);
    if (raw === null) return null;
    window.sessionStorage.removeItem(PREFIX + key);
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
