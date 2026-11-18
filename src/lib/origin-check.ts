// The Server Action origin check, done early (src/proxy.ts) so a misconfigured reverse proxy gets an explanation.
//
// Next.js refuses every Server Action (every form in this app) whose `Origin` host differs from the host the request
// was sent to — the first `X-Forwarded-Host` value, else `Host` (next/dist/server/app-render/action-handler.js,
// `parseHostHeader`). A reverse proxy that rewrites `Host` to `localhost:3000` without setting `X-Forwarded-Host`
// trips it, and Next.js answers with a bare 500 ("Invalid Server Actions request.", logged as "`host` header with
// value ... does not match `origin` header ..."). This module repeats the same comparison so the proxy can answer
// with a readable message instead. Client-safe: the error page compares against HOST_MISMATCH_MESSAGE.

/** Shown to the user (error page, or the text of the refused action) when the check fails. */
export const HOST_MISMATCH_MESSAGE =
  "This server refused the form because the address in your browser does not match the address the app received. " +
  "If it runs behind a reverse proxy, the proxy must pass the original Host header (or set X-Forwarded-Host); see " +
  "docs/SELF-HOSTING.md, “Behind a reverse proxy”.";

type HeaderGetter = { get(name: string): string | null };

/** The host Next.js compares the Origin with: first `x-forwarded-host` hop, else `host`; null when neither is set. */
export function requestHost(headers: HeaderGetter): string | null {
  const forwarded = headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  return forwarded || headers.get("host") || null;
}

/**
 * For a POST: null when Next.js will accept it as a Server Action (no Origin, or an Origin whose host matches),
 * otherwise the details for the log line. Mirrors Next.js with no `serverActions.allowedOrigins` (this app sets none).
 */
export function hostMismatch(headers: HeaderGetter): { origin: string; host: string | null } | null {
  const origin = headers.get("origin");
  if (!origin) return null; // Next.js lets these through with a warning (hand-made requests)
  let originHost: string;
  try {
    originHost = origin === "null" ? "null" : new URL(origin).host;
  } catch {
    return { origin, host: requestHost(headers) };
  }
  const host = requestHost(headers);
  return host === originHost ? null : { origin: originHost, host };
}

/** The log line for a refused request (header values cut to 100 characters, as Next.js does). */
export function hostMismatchLogLine(m: { origin: string; host: string | null }, path: string): string {
  const cut = (v: string) => (v.length > 100 ? `${v.slice(0, 100)}...` : v);
  const host = m.host === null ? "no Host or X-Forwarded-Host header" : `host "${cut(m.host)}"`;
  return (
    `[origin-check] Refused a form post to ${cut(path)}: the browser's Origin "${cut(m.origin)}" does not match the ` +
    `${host}. A reverse proxy in front of the app must pass the original Host header or set X-Forwarded-Host ` +
    `(docs/SELF-HOSTING.md, "Behind a reverse proxy").`
  );
}
