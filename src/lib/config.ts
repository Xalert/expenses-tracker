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
