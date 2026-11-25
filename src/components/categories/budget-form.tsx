"use client";

import { useActionState } from "react";
import { removeBudgetAction, setBudgetAction } from "@/app/(app)/categories/actions";
import { FieldError, FormError, Input, Label, Select, SubmitButton } from "@/components/ui";
import { initialFormState, type FormState } from "@/lib/form";
import { formatMoney, minorToInputValue } from "@/lib/money";
import type { BudgetView } from "@/server/budgets";

/**
 * Set, change or remove a monthly budget, inside a /categories row's editor (`target`: the category id, or null for
 * the overall budget). One amount for every month, in one currency of the user's wallets (`currencies`, archived
 * wallets included; a select when there are several). The amount is echoed back after a refused save and the select
 * is keyed on its value, so both survive React's form reset. Without wallets it only says why there is no form.
 */
export function BudgetForm({
  target,
  subject,
  budget,
  currencies,
  defaultCurrency,
  onDone,
}: {
  target: number | null;
  /** "Food" / "all spending": used in the label and the remove button. */
  subject: string;
  budget: BudgetView | undefined;
  currencies: readonly string[];
  /** The currency offered for a new budget (the page's, when it is one of `currencies`). */
  defaultCurrency: string | null;
  onDone: (message?: string) => void;
}) {
  const [state, formAction] = useActionState(async (prev: FormState, formData: FormData) => {
    const next = await setBudgetAction(target, prev, formData);
    if (next.ok) onDone(next.message);
    return next;
  }, initialFormState);
  const key = target === null ? "overall" : String(target);
  const amountId = `budget-${key}-amount`;
  const currencyId = `budget-${key}-currency`;
  const noteId = `budget-${key}-note`;

  if (currencies.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Add a wallet to set a budget: a budget is in the currency of one of your wallets.
      </p>
    );
  }

  // A budget whose currency is no longer held (its last wallet was deleted) still shows it; saving it is refused.
  const options = budget && !currencies.includes(budget.currency) ? [...currencies, budget.currency].sort() : currencies;
  const v = state.values;
  const currency =
    v?.currency ??
    budget?.currency ??
    (defaultCurrency && currencies.includes(defaultCurrency) ? defaultCurrency : currencies[0]);
  const amount = v?.amount ?? (budget ? minorToInputValue(budget.amountMinor, budget.currency) : "");
  const amountError = state.fieldErrors?.amount;
  const currencyError = state.fieldErrors?.currency;

  return (
    <div className="space-y-2">
      <form action={formAction} noValidate className="space-y-1.5">
        <Label htmlFor={amountId}>{target === null ? "Monthly budget for all spending" : `Monthly budget for “${subject}”`}</Label>
        <div className="flex flex-wrap gap-2">
          <Input
            id={amountId}
            name="amount"
            inputMode="decimal"
            autoComplete="off"
            placeholder={budget ? undefined : "No budget"}
            defaultValue={amount}
            error={amountError}
            aria-describedby={noteId}
            className="min-w-0 flex-1 basis-28 tabular-nums"
          />
          {options.length > 1 ? (
            <>
              <label htmlFor={currencyId} className="sr-only">
                Budget currency
              </label>
              <Select
                key={currency}
                id={currencyId}
                name="currency"
                defaultValue={currency}
                error={currencyError}
                className="w-24"
              >
                {options.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            </>
          ) : (
            <>
              <input type="hidden" name="currency" value={currency} />
              <span className="flex h-11 items-center text-sm font-semibold text-muted-foreground">{currency}</span>
            </>
          )}
          <SubmitButton variant="secondary" pendingLabel="Saving…" className="shrink-0">
            {budget ? "Save budget" : "Set budget"}
          </SubmitButton>
        </div>
        <FieldError id={amountId}>{amountError}</FieldError>
        {options.length > 1 ? (
          <FieldError id={currencyId}>{currencyError}</FieldError>
        ) : (
          currencyError && (
            <p role="alert" className="text-sm text-danger">
              {currencyError}
            </p>
          )
        )}
        <p id={noteId} className="text-xs text-muted-foreground">
          {budget ? `Now ${formatMoney(budget.amountMinor, budget.currency)} a month. ` : ""}
          The same amount every month, over all your wallets and groups; spending in other currencies is converted at
          each day&apos;s rate.
        </p>
        <FormError message={state.message} />
      </form>
      {budget && <RemoveBudgetButton target={target} subject={subject} onDone={onDone} />}
    </div>
  );
}

function RemoveBudgetButton({
  target,
  subject,
  onDone,
}: {
  target: number | null;
  subject: string;
  onDone: (message?: string) => void;
}) {
  const [state, formAction] = useActionState(async () => {
    const next = await removeBudgetAction(target);
    if (next.ok) onDone(next.message);
    return next;
  }, initialFormState);
  return (
    <form action={formAction}>
      <SubmitButton variant="ghost" pendingLabel="Removing…" className="-ml-3 text-danger! hover:bg-danger-soft!">
        Remove the budget{target === null ? "" : ` for ${subject}`}
      </SubmitButton>
      {!state.ok && state.message && (
        <p role="alert" className="text-sm text-danger">
          {state.message}
        </p>
      )}
    </form>
  );
}
