// An account's time zone: an IANA name, checked with the runtime's `Intl` (no time-zone data of our own).

/** Longer than any IANA name; anything above is refused before `Intl` sees it. */
const MAX_LENGTH = 100;

let supported: Set<string> | undefined;
const supportedZones = () => (supported ??= new Set([...Intl.supportedValuesOf("timeZone"), "UTC"]));

/** Every IANA zone `Intl` knows (`Intl.supportedValuesOf("timeZone")`) plus "UTC", sorted. */
export function listTimeZones(): string[] {
  return [...supportedZones()].sort();
}

/**
 * The canonical spelling of a valid IANA time zone ("europe/kyiv" → "Europe/Kiev" on Node 24's ICU, "Etc/UTC" →
 * "UTC"), or null for anything else: missing, empty, too long, refused by `Intl.DateTimeFormat`, or accepted by it
 * but not an IANA name from `listTimeZones()` (an offset such as "+02:00", "Etc/GMT+5").
 */
export function canonicalTimeZone(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (!v || v.length > MAX_LENGTH) return null;
  let zone: string;
  try {
    zone = new Intl.DateTimeFormat("en-US", { timeZone: v }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
  return supportedZones().has(zone) ? zone : null;
}

/**
 * The zones grouped for a native <select>: by the part before the first "/" ("Europe", "America", …), with names
 * that have none ("UTC") under "Other", last. Each option's label is the rest of the name with "_" as spaces.
 */
export function groupedTimeZones(): { group: string; zones: { value: string; label: string }[] }[] {
  const groups = new Map<string, { value: string; label: string }[]>();
  for (const zone of listTimeZones()) {
    const slash = zone.indexOf("/");
    const group = slash < 0 ? "Other" : zone.slice(0, slash);
    const label = (slash < 0 ? zone : zone.slice(slash + 1)).replace(/_/g, " ");
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group)!.push({ value: zone, label });
  }
  return [...groups]
    .sort(([a], [b]) => (a === "Other" ? 1 : b === "Other" ? -1 : a.localeCompare(b)))
    .map(([group, zones]) => ({ group, zones }));
}
