export type CurrencyOption = { code: string; name: string };

/** Shown first in currency pickers, in this order. */
export const PINNED_CURRENCIES = [
  "EUR", "USD", "GBP", "RON", "CHF", "JPY", "CAD", "AUD", "SEK", "NOK", "DKK", "PLN", "HUF", "CZK",
] as const;

const supported: string[] = (() => {
  try {
    return Intl.supportedValuesOf("currency");
  } catch {
    return [...PINNED_CURRENCIES];
  }
})();
const supportedSet = new Set(supported);

const displayNames = new Intl.DisplayNames(["en"], { type: "currency" });

export function currencyName(code: string): string {
  return displayNames.of(code.toUpperCase()) ?? code.toUpperCase();
}

/** All supported currencies: pinned ones first, then the rest alphabetically by code. */
export const CURRENCIES: CurrencyOption[] = (() => {
  const pinned = PINNED_CURRENCIES.filter((c) => supportedSet.has(c));
  const pinnedSet = new Set<string>(pinned);
  const rest = supported.filter((c) => !pinnedSet.has(c)).sort();
  return [...pinned, ...rest].map((code) => ({ code, name: currencyName(code) }));
})();

/** True for an uppercase 3-letter ISO-4217 code supported by the runtime's Intl. */
export function isValidCurrency(code: string): boolean {
  return typeof code === "string" && /^[A-Z]{3}$/.test(code) && supportedSet.has(code);
}
