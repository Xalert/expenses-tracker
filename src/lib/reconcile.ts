// Pure helpers for the wallet page's "Reconcile balance" form (client and server): the live preview and the result
// messages. The service is `reconcileWallet` in src/server/reconcile.ts.

import { formatDate } from "./dates";
import { formatMoney } from "./money";

/**
 * The balance at the end of `date` from `closings` (`[date, closingMinor]` ascending, the dates that have entries;
 * `listWalletClosingBalances`): the closing of the last date on or before it, else the initial balance.
 */
export function balanceOnDate(initialBalanceMinor: number, closings: readonly [string, number][], date: string): number {
  let lo = 0;
  let hi = closings.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (closings[mid][0] <= date) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found === -1 ? initialBalanceMinor : closings[found][1];
}

/** What saving would record: "This adds an expense of €12.40" / "This adds income of €5.00" / already matches. */
export function adjustmentPreview(differenceMinor: number, currency: string): string {
  if (differenceMinor === 0) return "The balance already matches. Nothing will be added.";
  const amount = formatMoney(Math.abs(differenceMinor), currency);
  return differenceMinor < 0 ? `This adds an expense of ${amount}.` : `This adds income of ${amount}.`;
}

/** The confirmation after saving. */
export function adjustmentResultMessage(
  r: { differenceMinor: number; actualBalanceMinor: number },
  date: string,
  currency: string,
): string {
  const on = formatDate(date);
  if (r.differenceMinor === 0) {
    return `The balance already matches ${formatMoney(r.actualBalanceMinor, currency)} on ${on}. Nothing was added.`;
  }
  const amount = formatMoney(Math.abs(r.differenceMinor), currency);
  const what = r.differenceMinor < 0 ? `an expense of ${amount}` : `income of ${amount}`;
  return `Added ${what} on ${on} in “Balance adjustment”. The balance on that day is now ${formatMoney(r.actualBalanceMinor, currency)}.`;
}
