import { buttonClasses } from "@/components/ui";
import { cn } from "@/lib/cn";
import { formatMonth, shiftMonth } from "@/lib/dates";
import type { AmountRangeErrors } from "@/lib/amount-filter";
import { resolveView, type ListParams } from "./list-params";

/** Months offered by the no-JS month select: this many back from the current month, and one ahead. */
export const NO_SCRIPT_MONTHS_BACK = 24;

/** The no-JS month select's id: without JavaScript the Month chip's label is a link to it. */
export const NO_SCRIPT_MONTH_ID = "no-script-month";

/** The no-JS minimum amount field's id: the Amount chip's fallback link points at it. */
export const NO_SCRIPT_AMOUNT_ID = "no-script-min";

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
 * select per chip (Month · Wallet · Type, and multiple selects for Category · Tag, whose repeated keys the page folds
 * into `?category=1,2`), the two amount fields and "Apply"; the search, the strip's currency and selection mode ride
 * along as hidden fields. A date range or a selected day is replaced by the month chosen here. Empty choices
 * ("All wallets") submit empty values, which the page redirects away (`hasEmptyParams`). The `<style>` hides the
 * popover chips (`data-needs-js`), which cannot open without scripts; the month chip's ‹ › links still work, and its
 * label becomes a link to the month select here (`NO_SCRIPT_MONTH_ID`).
 */
export function NoScriptFilters({
  params,
  thisMonth,
  wallets,
  categories,
  tags = [],
  amountErrors = {},
}: {
  params: ListParams;
  thisMonth: string;
  wallets: { id: number; name: string; currency: string; archived: boolean }[];
  categories: { id: number; name: string; kind: "expense" | "income" }[];
  tags?: { id: number; name: string }[];
  amountErrors?: AmountRangeErrors;
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
  const multiClass = "w-full min-w-0 rounded-2xl border border-border bg-field px-2 py-1 text-sm text-foreground sm:w-auto";
  const selectedCategories = (params.categories ?? []).map(String);
  const selectedTags = (params.tags ?? []).map(String);
  const amountField = (side: "min" | "max", label: string) => {
    const error = amountErrors[side];
    const id = side === "min" ? NO_SCRIPT_AMOUNT_ID : "no-script-max";
    return (
      <label className={field}>
        {label}
        <input
          id={id}
          name={side}
          inputMode="decimal"
          maxLength={32}
          defaultValue={params[side] ?? ""}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          className={cn(selectClass, "w-28 scroll-mt-24 sm:w-28", error && "border-danger")}
        />
        {error && (
          <span id={`${id}-error`} className="max-w-48 font-medium text-danger">
            {error}
          </span>
        )}
      </label>
    );
  };
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
          <select id={NO_SCRIPT_MONTH_ID} name="month" defaultValue={monthValue} className={cn(selectClass, "scroll-mt-24")}>
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
            Categories (none = all)
            <select name="category" multiple size={4} defaultValue={selectedCategories} className={multiClass}>
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
        {(tags.length > 0 || params.tags) && (
          <label className={field}>
            Tags (none = all)
            <select name="tag" multiple size={4} defaultValue={selectedTags} className={multiClass}>
              {(params.tags ?? [])
                .filter((id) => !tags.some((t) => t.id === id))
                .map((id) => (
                  <option key={`unknown-${id}`} value={id}>
                    Unknown tag
                  </option>
                ))}
              {tags.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {amountField("min", "At least")}
        {amountField("max", "At most")}
        {params.q && <input type="hidden" name="q" value={params.q} />}
        {params.select && <input type="hidden" name="select" value={params.select === "page" ? "page" : "1"} />}
        {params.currency && <input type="hidden" name="currency" value={params.currency} />}
        {params.view && <input type="hidden" name="view" value={params.view} />}
        <button type="submit" className={cn(buttonClasses({ variant: "secondary" }), "sm:h-10")}>
          Apply
        </button>
      </form>
    </>
  );
}
