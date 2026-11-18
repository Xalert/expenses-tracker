// A readable label for a session's User-Agent on /account ("Firefox on macOS"). Deliberately simple: a few
// substring checks in the order that matters (Edge and Opera also say "Chrome", Chrome also says "Safari"), no
// version numbers, no dependency. Anything unrecognised is "Unknown browser".

/** Longest `User-Agent` stored with a session; longer values are cut. */
export const USER_AGENT_MAX = 256;

/** A request's `User-Agent` as stored with a session: trimmed, cut to `USER_AGENT_MAX`, null when empty. */
export function storedUserAgent(value: string | null | undefined): string | null {
  const v = (value ?? "").trim();
  return v ? v.slice(0, USER_AGENT_MAX) : null;
}

const BROWSERS: [RegExp, string][] = [
  [/\bEdg(e|A|iOS)?\//, "Edge"],
  [/\b(OPR|Opera)\//, "Opera"],
  [/\bSamsungBrowser\//, "Samsung Internet"],
  [/\b(Firefox|FxiOS)\//, "Firefox"],
  [/\b(Chrome|CriOS|Chromium)\//, "Chrome"],
  [/\bVersion\/[\d.]+.*\bSafari\//, "Safari"],
];

const SYSTEMS: [RegExp, string][] = [
  [/\b(iPhone|iPod)\b/, "iPhone"],
  [/\biPad\b/, "iPad"],
  [/\bAndroid\b/, "Android"],
  [/\bCrOS\b/, "ChromeOS"],
  [/\bWindows\b/, "Windows"],
  [/\b(Macintosh|Mac OS X)\b/, "macOS"],
  [/\bLinux\b/, "Linux"],
];

const first = (ua: string, table: [RegExp, string][]) => table.find(([re]) => re.test(ua))?.[1] ?? null;

/** "Firefox on macOS", "Safari on iPhone", "Chrome" (system not recognised), "Unknown browser" (browser not recognised). */
export function deviceLabel(userAgent: string | null | undefined): string {
  const ua = userAgent ?? "";
  const browser = first(ua, BROWSERS);
  if (!browser) return "Unknown browser";
  const system = first(ua, SYSTEMS);
  return system ? `${browser} on ${system}` : browser;
}
