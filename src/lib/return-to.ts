// `?returnTo=` handling for the transaction forms. This is an open-redirect guard: only same-site,
// relative paths are honoured; anything else falls back to the default.

export const DEFAULT_RETURN_TO = "/transactions";

const MAX_LENGTH = 2000;
const PROBE_ORIGIN = "http://return-to.invalid";

/**
 * Returns `value` when it is a same-site relative path (starts with a single `/`, not `//` or `/\`,
 * no control characters or backslashes, and resolves to this origin), otherwise `fallback`.
 */
export function safeReturnTo(value: unknown, fallback: string = DEFAULT_RETURN_TO): string {
  if (Array.isArray(value)) value = value[0];
  if (typeof value !== "string") return fallback;
  if (value.length === 0 || value.length > MAX_LENGTH) return fallback;
  if (value[0] !== "/") return fallback;
  // `//host` and `/\host` are protocol-relative URLs to browsers; backslashes are normalised to `/`.
  if (value[1] === "/" || value.includes("\\")) return fallback;
  // Browsers strip tabs/newlines from URLs (`/\t/evil.com` → `//evil.com`); reject all control chars and spaces.
  if (/[\u0000-\u0020\u007f-\u009f]/.test(value)) return fallback;
  try {
    const url = new URL(value, PROBE_ORIGIN);
    if (url.origin !== PROBE_ORIGIN) return fallback;
  } catch {
    return fallback;
  }
  return value;
}

/** Append `returnTo` to an internal href (skipped when it is the default). */
export function withReturnTo(href: string, returnTo: string): string {
  const safe = safeReturnTo(returnTo);
  if (safe === DEFAULT_RETURN_TO) return href;
  const sep = href.includes("?") ? "&" : "?";
  return `${href}${sep}returnTo=${encodeURIComponent(safe)}`;
}
