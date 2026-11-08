import { z } from "zod";
import { isValidCurrency } from "@/lib/currencies";
import type { FormState } from "@/lib/form";
import { zodErrorState } from "@/lib/form";
import { currencyDecimals, parseAmount } from "@/lib/money";

// Pure form-data parsing for the wallet Server Actions (kept out of the "use server" file so it can be tested).

const MAX_NAME = 60;

const nameSchema = z
  .string({ error: "Enter a name." })
  .trim()
  .min(1, "Enter a name.")
  .max(MAX_NAME, `Keep the name under ${MAX_NAME} characters.`);

const createSchema = z.object({
  name: nameSchema,
  currency: z
    .string({ error: "Choose a currency." })
    .trim()
    .toUpperCase()
    .refine(isValidCurrency, "Choose a currency."),
  initialBalance: z.string().optional(),
});

const updateSchema = z.object({
  name: nameSchema,
  initialBalance: z.string().optional(),
});

type Parsed<T> = { ok: true; data: T } | { ok: false; state: FormState };

function amountHint(currency: string): string {
  const d = currencyDecimals(currency);
  return d === 0
    ? `Enter a whole amount in ${currency} (no decimals).`
    : `Enter a valid amount in ${currency} (up to ${d} decimal${d === 1 ? "" : "s"}).`;
}

/** Empty → 0; otherwise `parseAmount` with negatives allowed. Null when invalid. */
function parseInitialBalance(raw: string | undefined, currency: string): number | null {
  if (raw === undefined || raw.trim() === "") return 0;
  return parseAmount(raw, currency, { allowNegative: true });
}

/**
 * The currency a create form posted. The form has two controls named `currency`: the pills of the common currencies
 * (a radio, posted only when one is checked) and, after them, the "type a code" text input (always posted, often
 * empty). The typed code wins when it is filled: the last non-empty value, trimmed and upper-cased; "" when none.
 * With JavaScript the form unchecks the pills while a code is typed, so only one value is posted; this rule is what
 * makes the no-JS form behave the same. Validation stays in the schema (`isValidCurrency`).
 */
export function chosenCurrency(posted: FormDataEntryValue[]): string {
  const filled = posted.filter((v): v is string => typeof v === "string" && v.trim() !== "");
  return (filled.at(-1) ?? "").trim().toUpperCase();
}

export function parseCreateWallet(
  formData: FormData,
  values: Record<string, string>,
): Parsed<{ name: string; currency: string; initialBalanceMinor: number }> {
  // Check the balance whenever the currency is usable, so every field error shows at once.
  const rawCurrency = chosenCurrency(formData.getAll("currency"));
  values = { ...values, currency: rawCurrency };
  const parsed = createSchema.safeParse({ ...Object.fromEntries(formData), currency: rawCurrency });
  const currencyOk = isValidCurrency(rawCurrency);
  const rawBalance = formData.get("initialBalance");
  const initialBalanceMinor = currencyOk
    ? parseInitialBalance(typeof rawBalance === "string" ? rawBalance : undefined, rawCurrency)
    : 0;
  if (!parsed.success || initialBalanceMinor === null) {
    const state: FormState = parsed.success
      ? { message: "Please fix the highlighted fields.", fieldErrors: {}, values }
      : zodErrorState(parsed.error, values);
    if (initialBalanceMinor === null) state.fieldErrors = { ...state.fieldErrors, initialBalance: amountHint(rawCurrency) };
    return { ok: false, state };
  }
  return { ok: true, data: { name: parsed.data.name, currency: parsed.data.currency, initialBalanceMinor } };
}

export function parseUpdateWallet(
  formData: FormData,
  values: Record<string, string>,
  currency: string,
): Parsed<{ name: string; initialBalanceMinor: number }> {
  const parsed = updateSchema.safeParse(Object.fromEntries(formData));
  const rawBalance = formData.get("initialBalance");
  const initialBalanceMinor = parseInitialBalance(typeof rawBalance === "string" ? rawBalance : undefined, currency);
  if (!parsed.success || initialBalanceMinor === null) {
    const state: FormState = parsed.success
      ? { message: "Please fix the highlighted fields.", fieldErrors: {}, values }
      : zodErrorState(parsed.error, values);
    if (initialBalanceMinor === null) state.fieldErrors = { ...state.fieldErrors, initialBalance: amountHint(currency) };
    return { ok: false, state };
  }
  return { ok: true, data: { name: parsed.data.name, initialBalanceMinor } };
}

/** Wallet id from a route segment or bound argument; null unless a positive safe integer. */
export function parseWalletId(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
