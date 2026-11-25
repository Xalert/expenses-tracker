import Link from "next/link";
import { BudgetMeter } from "@/components/categories/budget-meter";
import { GroupDot } from "@/components/wallets/group-dot";
import { closestToLimit } from "@/lib/budgets";
import type { MonthBudgets } from "@/server/budgets";

/** How many category budgets the Overview shows next to the overall one. */
export const OVERVIEW_BUDGETS = 3;

/**
 * The Overview's "Budgets" card, shown when the account has budgets: the overall budget and the `OVERVIEW_BUDGETS`
 * category budgets closest to or over their limit, each with its meter, and a link to /categories (`href`, the month
 * in view) where they are set. `budgets` null: a wallet group is selected; budgets cover every group, so one line
 * says so instead of showing figures for the wrong wallets.
 */
export function BudgetsCard({ budgets, href }: { budgets: MonthBudgets | null; href: string }) {
  const overall = budgets?.budgets.find((b) => b.categoryId === null);
  const closest = budgets ? closestToLimit(budgets.budgets, OVERVIEW_BUDGETS) : [];
  const shown = [...(overall ? [overall] : []), ...closest];
  const more = budgets ? budgets.budgets.length - shown.length : 0;
  return (
    <section aria-labelledby="overview-budgets" className="min-w-0 rounded-[18px] border border-border bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 pt-3 pb-2 sm:px-5">
        <h2 id="overview-budgets" className="text-[15px] font-bold text-foreground">
          Budgets
        </h2>
        <Link
          href={href}
          className="inline-flex min-h-11 items-center text-[13px] font-semibold text-accent-hover hover:underline"
        >
          {more > 0 ? `All budgets (${more} more)` : "Manage budgets"}
        </Link>
      </div>
      {budgets === null ? (
        <p className="border-t border-surface-muted px-4 py-3 text-sm text-muted-foreground sm:px-5">
          Budgets cover all your wallet groups, so their progress shows only with All groups selected.
        </p>
      ) : (
        <ul className="grid gap-x-6 gap-y-4 border-t border-surface-muted px-4 pt-3 pb-4 sm:grid-cols-2 sm:px-5 lg:grid-cols-4">
          {shown.map((b) => (
            <li key={b.id} className="min-w-0">
              <p className="mb-1.5 truncate text-sm font-bold text-foreground">
                {b.category ? (
                  <>
                    {b.category.color && <GroupDot color={b.category.color} className="mr-1.5 align-[-1px]" />}
                    {b.category.name}
                    {b.category.archived && <span className="font-semibold text-muted-foreground"> (archived)</span>}
                  </>
                ) : (
                  "All spending"
                )}
              </p>
              <BudgetMeter budget={b} elapsed={budgets.elapsed} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
