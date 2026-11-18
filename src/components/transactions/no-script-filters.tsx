import { buttonClasses } from "@/components/ui";
import { cn } from "@/lib/cn";
import { formatMonth, shiftMonth } from "@/lib/dates";
import { resolveView, type ListParams } from "./list-params";

/** Months offered by the no-JS month select: this many back from the current month, and one ahead. */
export const NO_SCRIPT_MONTHS_BACK = 24;

/**
 * The month select's options, newest first: next month, the current month (value "" — the default, so the URL stays
 * clean), the 24 before it, the month in view if it is older, then "All time".
 */
export function noScriptMonthOptions(params: ListParams, thisMonth: string): { value: string; label: string }[] {
  const view = resolveView(params, thisMonth);
  const months: string[] = [];
  for (let i = 1; i >= -NO_SCRIPT_MONTHS_BACK; i--) months.push(shiftMonth(thisMonth, i));
  const shown = view.type === "month" ? view.month : view.type === "range" ? (view.from ?? view.to)!.slice(0, 7) : null;
  if (shown && !months.includes(shown)) {
    months.push(shown);
    months.sort().reverse();
  }
  return [
    ...months.map((m) => ({ value: m === thisMonth ? "" : m, label: formatMonth(m) })),
    { value: "all", label: "All time" },
  ];
}

const selectClass =
  "h-11 w-full min-w-0 rounded-full border border-border bg-field px-3 text-sm text-foreground sm:h-10 sm:w-auto";

/**
 * The /transactions filters without JavaScript, rendered by the page inside `<noscript>`: a plain GET form with a
 * select per chip (Month · Wallet · Type · Category) and "Apply"; the note search and the strip's currency ride
 * along as hidden fields. A date range or a selected day is replaced by the month chosen here. Empty choices
 * ("All wallets") submit empty values, which the page redirects away (`hasEmptyParams`). The `<style>` hides the
 * popover chips (`data-needs-js`), which cannot open without scripts; the month chip's ‹ › links still work.
 */
export function NoScriptFilters({
  params,
  thisMonth,
  wallets,
  categories,
}: {
  params: ListParams;
  thisMonth: string;
  wallets: { id: number; name: string; currency: string; archived: boolean }[];
  categories: { id: number; name: string; kind: "expense" | "income" }[];
}) {
  const view = resolveView(params, thisMonth);
  const monthValue =
    view.type === "all"
      ? "all"
      : (() => {
          const m = view.type === "month" ? view.month : (view.from ?? view.to)!.slice(0, 7);
          return m === thisMonth ? "" : m;
        })();
  const field = "flex min-w-0 flex-col gap-1 text-xs font-semibold text-muted-foreground";
  return (
    <>
      <style>{"[data-needs-js]{display:none!important}"}</style>
      <form
        action="/transactions"
        method="get"
        aria-label="Filters"
        className="mb-4 flex flex-wrap items-end gap-2 rounded-[18px] border border-border bg-surface p-3"
      >
        <label className={field}>
          Month
          <select name="month" defaultValue={monthValue} className={selectClass}>
            {noScriptMonthOptions(params, thisMonth).map((o) => (
              <option key={o.value || "current"} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        {wallets.length > 0 && (
          <label className={field}>
            Wallet
            <select name="wallet" defaultValue={params.wallet ? String(params.wallet) : ""} className={selectClass}>
              <option value="">All wallets</option>
              {wallets.map((w) => (
                <option key={w.id} value={w.id}>
                  {`${w.name} · ${w.currency}${w.archived ? " (archived)" : ""}`}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className={field}>
          Type
          <select name="kind" defaultValue={params.kind ?? ""} className={selectClass}>
            <option value="">All types</option>
            <option value="expense">Expenses</option>
            <option value="income">Income</option>
            <option value="transfer">Transfers</option>
          </select>
        </label>
        {categories.length > 0 && (
          <label className={field}>
            Category
            <select name="category" defaultValue={params.category ? String(params.category) : ""} className={selectClass}>
              <option value="">All categories</option>
              {(["expense", "income"] as const).map((kind) => {
                const list = categories.filter((c) => c.kind === kind);
                return list.length === 0 ? null : (
                  <optgroup key={kind} label={kind === "expense" ? "Expense" : "Income"}>
                    {list.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </optgroup>
                );
              })}
            </select>
          </label>
        )}
        {params.q && <input type="hidden" name="q" value={params.q} />}
        {params.currency && <input type="hidden" name="currency" value={params.currency} />}
        <button type="submit" className={cn(buttonClasses({ variant: "secondary" }), "sm:h-10")}>
          Apply
        </button>
      </form>
    </>
  );
}
