import { Amount } from "@/components/ui";
import { currencyName } from "@/lib/currencies";
import type { CurrencyTotals as Totals } from "@/server/dashboard";

/** One tile per currency: total balance of its active wallets, plus the month's income and expenses. */
export function CurrencyTotals({ totals }: { totals: Totals[] }) {
  return (
    <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {totals.map((t) => {
        const net = t.incomeMinor - t.expenseMinor;
        return (
          <li key={t.currency} className="rounded-xl border border-border bg-surface p-4 shadow-xs">
            <div className="flex items-baseline justify-between gap-2">
              <p className="text-sm font-semibold text-foreground">{t.currency}</p>
              <p className="truncate text-xs text-muted-foreground">{currencyName(t.currency)}</p>
            </div>
            <p className="mt-2 text-2xl font-semibold tracking-tight text-foreground">
              <Amount minor={t.balanceMinor} currency={t.currency} colorNegative />
            </p>
            <p className="text-xs text-muted-foreground">Total balance</p>
            <dl className="mt-3 grid grid-cols-2 gap-2 border-t border-border pt-3 text-sm">
              <div className="min-w-0">
                <dt className="text-xs text-muted-foreground">Income</dt>
                <dd className="font-medium">
                  <Amount minor={t.incomeMinor} currency={t.currency} kind="income" />
                </dd>
              </div>
              <div className="min-w-0 text-right">
                <dt className="text-xs text-muted-foreground">Expenses</dt>
                <dd className="font-medium">
                  <Amount minor={t.expenseMinor} currency={t.currency} kind="expense" />
                </dd>
              </div>
            </dl>
            <p className="mt-2 flex justify-between text-xs text-muted-foreground">
              <span>Net this month</span>
              <span className="font-medium">
                <Amount minor={net} currency={t.currency} signed colorNegative />
              </span>
            </p>
          </li>
        );
      })}
    </ul>
  );
}
