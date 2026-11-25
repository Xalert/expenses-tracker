import { budgetBar, isOver, leftLine, missingLine, paceLine, spentOfLine, type BudgetFigures, type Elapsed } from "@/lib/budgets";
import { cn } from "@/lib/cn";

/**
 * A budget's month at a glance, phrasing content only (it sits inside a row's button on /categories and in the
 * Overview's Budgets card): "€120.00 of €300.00" and "€180.00 left" (or "… over", in the danger colour), the bar
 * (decorative, `aria-hidden`: the text carries the same figures), then "40% spent · day 10 of 30" for the current month
 * and the currencies left out for want of a rate. On the bar the fill is the share spent (capped at the end; the danger
 * colour once over) and, for the current month, a tick marks how far through the month today is.
 */
export function BudgetMeter({
  budget,
  elapsed,
  className,
}: {
  budget: BudgetFigures & { missingCurrencies: readonly string[] };
  elapsed: Elapsed;
  className?: string;
}) {
  const over = isOver(budget);
  const { fill, pace } = budgetBar(budget, elapsed);
  const missing = missingLine(budget.missingCurrencies);
  return (
    <span className={cn("block min-w-0", className)} data-budget-meter="">
      <span className="flex flex-wrap items-baseline justify-between gap-x-3 text-[13px] tabular-nums">
        <span className="font-semibold text-foreground">{spentOfLine(budget)}</span>
        <span className={cn("font-semibold", over ? "text-danger" : "text-muted-foreground")}>{leftLine(budget)}</span>
      </span>
      <span aria-hidden="true" className="relative mt-1.5 block h-2 rounded-full bg-surface-muted">
        <span
          className={cn("absolute inset-y-0 left-0 rounded-full", over ? "bg-danger" : "bg-muted-foreground")}
          style={{ width: `${fill * 100}%` }}
        />
        {pace !== null && (
          <span
            data-budget-pace=""
            className="absolute -top-1 -bottom-1 w-0.5 -translate-x-1/2 rounded-full bg-foreground ring-2 ring-surface"
            style={{ left: `${pace * 100}%` }}
          />
        )}
      </span>
      <span className="mt-1.5 block text-xs text-muted-foreground">
        {paceLine(budget, elapsed)}
        {missing && <span className="block">{missing}</span>}
      </span>
    </span>
  );
}
