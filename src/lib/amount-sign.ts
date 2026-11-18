// The sign of a typed amount, for the "±" toggle next to a wallet's starting balance (`SignToggle`).

/** A leading minus (ASCII or U+2212, as `parseAmount` accepts) after optional whitespace. */
const MINUS = /^\s*[-−]/;

export function isNegativeText(value: string): boolean {
  return MINUS.test(value);
}

/** Adds or removes the leading minus: "12.50" → "-12.50", "−3" → "3", "" → "-". Other text is kept as typed. */
export function toggleSign(value: string): string {
  const trimmed = value.trim();
  return isNegativeText(trimmed) ? trimmed.replace(MINUS, "").trimStart() : `-${trimmed}`;
}
