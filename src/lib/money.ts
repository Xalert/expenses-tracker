const decimalsCache = new Map<string, number>();

/** Number of minor-unit digits for an ISO-4217 currency (JPY 0, EUR 2, KWD 3). */
export function currencyDecimals(code: string): number {
  const key = code.toUpperCase();
  let d = decimalsCache.get(key);
  if (d === undefined) {
    d = new Intl.NumberFormat("en-US", { style: "currency", currency: key }).resolvedOptions()
      .maximumFractionDigits ?? 2;
    decimalsCache.set(key, d);
  }
  return d;
}

/**
 * Parse a user-entered amount into integer minor units.
 *
 * Accepts `12`, `12.5`, `12,50`, `1 234.56`, `1,234.56`, `1.234,56`. When both `.` and `,` appear the
 * last one is the decimal separator; a lone `,` is always a decimal separator. Spaces (incl. NBSP)
 * and `'` are thousands separators. Returns `null` for junk, empty input, negatives (unless
 * `allowNegative`), or more decimals than the currency allows.
 */
export function parseAmount(
  input: string,
  currency: string,
  opts: { allowNegative?: boolean } = {},
): number | null {
  if (typeof input !== "string") return null;
  let s = input.trim().replace(/[\s  ']/g, "");
  if (!s) return null;

  let negative = false;
  if (s.startsWith("-") || s.startsWith("−")) {
    if (!opts.allowNegative) return null;
    negative = true;
    s = s.slice(1);
  }

  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  if (lastDot !== -1 && lastComma !== -1) {
    const decimalSep = lastDot > lastComma ? "." : ",";
    const groupSep = decimalSep === "." ? "," : ".";
    const [intPart, ...rest] = s.split(decimalSep);
    if (rest.length !== 1) return null;
    const groupRe = new RegExp(`^\\d{1,3}(\\${groupSep}\\d{3})*$`);
    if (!groupRe.test(intPart)) return null;
    s = intPart.split(groupSep).join("") + "." + rest[0];
  } else if (lastComma !== -1) {
    s = s.replace(",", ".");
  }

  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) return null;
  const [, whole, frac = ""] = m;
  const decimals = currencyDecimals(currency);
  if (frac.length > decimals) return null;

  const minor = Number(whole + frac.padEnd(decimals, "0"));
  if (!Number.isSafeInteger(minor)) return null;
  if (minor === 0) return 0;
  return negative ? -minor : minor;
}

/** Format integer minor units with the currency, e.g. `formatMoney(-1250, "EUR", { signed: true })` → "-€12.50". */
export function formatMoney(
  minor: number,
  currency: string,
  opts: { signed?: boolean } = {},
): string {
  const decimals = currencyDecimals(currency);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
    currencyDisplay: "narrowSymbol",
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    signDisplay: opts.signed ? "exceptZero" : "auto",
  }).format(minor / 10 ** decimals);
}

/** Minor units → plain input value (no grouping, `.` decimal), e.g. 123450 EUR → "1234.50", -5 JPY → "-5". */
export function minorToInputValue(minor: number, currency: string): string {
  const decimals = currencyDecimals(currency);
  const sign = minor < 0 ? "-" : "";
  const digits = Math.abs(minor).toString().padStart(decimals + 1, "0");
  if (decimals === 0) return sign + digits;
  return `${sign}${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`;
}
