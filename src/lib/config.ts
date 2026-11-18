import "server-only";

// Runtime configuration, read from the environment on every call (no rebuild needed to change it).
// Documented in .env.example and docs/SPEC.md "Deployment".

function flag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  return !["false", "0", "no", "off"].includes(value.trim().toLowerCase());
}

/** `ALLOW_REGISTRATION` (default true). */
export function isRegistrationAllowed(): boolean {
  return flag(process.env.ALLOW_REGISTRATION, true);
}

export type CookieSecureMode = "auto" | "true" | "false";

/** `COOKIE_SECURE`: `auto` (default) | `true` | `false`. */
export function cookieSecureMode(): CookieSecureMode {
  const v = process.env.COOKIE_SECURE?.trim().toLowerCase();
  return v === "true" || v === "false" ? v : "auto";
}

/** Whether to mark the session cookie `secure`, given the request's `x-forwarded-proto` header. */
export function shouldUseSecureCookie(forwardedProto: string | null | undefined): boolean {
  const mode = cookieSecureMode();
  if (mode !== "auto") return mode === "true";
  return forwardedProto?.split(",")[0]?.trim().toLowerCase() === "https";
}

/**
 * Which `X-Forwarded-For` hop is the client, for the per-address sign-in limit:
 * - `none`: no proxy is trusted; the header is ignored and the per-address limit is skipped (Next.js gives a Server
 *   Action no socket address it could use instead);
 * - `first`: the first (left-most) hop;
 * - `hops`: the `hops`-th hop from the right, i.e. the address the `hops`-th proxy in front of the app saw.
 */
export type TrustProxy = { mode: "none" } | { mode: "first" } | { mode: "hops"; hops: number };

/**
 * `TRUST_PROXY`: unset / `false` (default) → none; `true` → the first hop; a whole number N ≥ 1 → the Nth hop from
 * the right (N = how many proxies append to the header). `0` means none; anything else is treated as unset.
 */
export function trustProxy(value: string | undefined = process.env.TRUST_PROXY): TrustProxy {
  const v = value?.trim().toLowerCase() ?? "";
  if (["true", "yes", "on"].includes(v)) return { mode: "first" };
  if (/^\d{1,3}$/.test(v) && Number(v) > 0) return { mode: "hops", hops: Number(v) };
  return { mode: "none" };
}

/** `EXCHANGE_RATES` (default true): fetch daily rates for the converted wallet total on Overview. */
export function exchangeRatesEnabled(): boolean {
  return flag(process.env.EXCHANGE_RATES, true);
}
