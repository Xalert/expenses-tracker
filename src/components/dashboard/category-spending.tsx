import { Amount } from "@/components/ui";
import type { CategorySpend } from "@/server/dashboard";
import { groupSpendingByCurrency } from "./spending";

/** Horizontal bars of the month's expenses per category, one group per currency. */
export function CategorySpending({ items, emptyMessage }: { items: CategorySpend[]; emptyMessage: string }) {
  const groups = groupSpendingByCurrency(items);
  if (groups.length === 0) {
    return <p className="px-4 py-8 text-center text-sm text-muted-foreground sm:px-5">{emptyMessage}</p>;
  }

  return (
    <div className="divide-y divide-border">
      {groups.map((g) => (
        <section key={g.currency} className="px-4 py-4 sm:px-5" aria-label={`Spending in ${g.currency}`}>
          <div className="mb-3 flex items-baseline justify-between gap-3">
            <h3 className="text-sm font-semibold text-foreground">{g.currency}</h3>
            <p className="text-xs text-muted-foreground">
              Total <Amount minor={g.totalMinor} currency={g.currency} className="font-medium text-foreground" />
            </p>
          </div>
          <ul className="space-y-3">
            {g.rows.map((r) => (
              <li key={r.categoryId}>
                <div className="mb-1 flex items-baseline justify-between gap-3 text-sm">
                  <span className="min-w-0 truncate text-foreground">{r.categoryName}</span>
                  <span className="shrink-0">
                    <Amount minor={r.amountMinor} currency={g.currency} className="font-medium text-foreground" />
                    <span className="ml-2 inline-block w-9 text-right text-xs text-muted-foreground tabular-nums">
                      {r.sharePercent}%
                    </span>
                  </span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-surface-muted" aria-hidden="true">
                  <div className="h-full rounded-full bg-expense/80" style={{ width: `${r.barPercent}%` }} />
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
