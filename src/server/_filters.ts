import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { transactions } from "@/db/schema";
import { boundToMinor, parseAmountRange, type AmountBound } from "@/lib/amount-filter";
import { ServiceError } from "@/lib/errors";
import { currencyDecimals } from "@/lib/money";

// Internal: the amount-range condition shared by `filterConditions` (the list, its day totals, the CSV export, bulk
// edits) and the day strip (`getMonthTimeline`).

/** Every currency the runtime knows whose decimals are not 2, grouped by decimals (JPY… 0, KWD… 3). */
const OTHER_DECIMALS: [number, string[]][] = (() => {
  const groups = new Map<number, string[]>();
  let codes: string[] = [];
  try {
    codes = Intl.supportedValuesOf("currency");
  } catch {
    codes = [];
  }
  for (const code of codes) {
    if (!/^[A-Z]{3}$/.test(code)) continue;
    const d = currencyDecimals(code);
    if (d !== 2) groups.set(d, [...(groups.get(d) ?? []), code]);
  }
  return [...groups.entries()].sort((a, b) => a[0] - b[0]);
})();

/**
 * `amount_minor <op> (the bound in the minor units of the entry's wallet currency)`: a correlated lookup of the wallet's
 * currency, so it works in queries that do not join `wallets`. The codes are ISO letters from Intl, inlined.
 */
function boundCondition(bound: AmountBound, side: "min" | "max"): SQL {
  const minor = (d: number) => sql`${boundToMinor(bound, d, side)}::bigint`;
  const branches = OTHER_DECIMALS.map(
    ([d, codes]) => sql`when w.currency in (${sql.raw(codes.map((c) => `'${c}'`).join(", "))}) then ${minor(d)} `,
  );
  const scaled = sql`(select case ${sql.join(branches, sql``)}else ${minor(2)} end from wallets w where w.id = ${transactions.walletId})`;
  return side === "min" ? sql`${transactions.amountMinor} >= ${scaled}` : sql`${transactions.amountMinor} <= ${scaled}`;
}

/**
 * The conditions for `minAmount` / `maxAmount` (major units as typed; see src/lib/amount-filter.ts). An invalid bound,
 * a negative one, or a maximum below the minimum → VALIDATION on field `min` / `max`.
 */
export function amountConditions(minAmount: string | undefined, maxAmount: string | undefined): SQL[] {
  if (minAmount === undefined && maxAmount === undefined) return [];
  const { range, errors } = parseAmountRange(minAmount, maxAmount);
  if (errors.min) throw new ServiceError("VALIDATION", errors.min, "min");
  if (errors.max) throw new ServiceError("VALIDATION", errors.max, "max");
  const out: SQL[] = [];
  if (range.min) out.push(boundCondition(range.min, "min"));
  if (range.max) out.push(boundCondition(range.max, "max"));
  return out;
}
