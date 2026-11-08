"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { buttonClasses, Field, FormError, Input, Select, SubmitButton } from "@/components/ui";
import type { CurrencyOption } from "@/lib/currencies";
import { initialFormState, type FormState } from "@/lib/form";
import { currencyDecimals } from "@/lib/money";

type WalletFormProps = {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  cancelHref: string;
  submitLabel: string;
  pendingLabel: string;
  defaults?: { name?: string; initialBalance?: string; currency?: string };
} & (
  | { mode: "create"; currencies: { pinned: CurrencyOption[]; rest: CurrencyOption[] } }
  | { mode: "edit"; currency: string; currencyLabel: string }
);

function balanceHint(currency: string | undefined) {
  if (!currency) return "Choose a currency first. May be negative (e.g. a credit card).";
  let d = 2;
  try {
    d = currencyDecimals(currency);
  } catch {
    // unknown code: keep the default
  }
  const decimals = d === 0 ? "whole amounts only" : `up to ${d} decimal${d === 1 ? "" : "s"}`;
  return `In ${currency}, ${decimals}. May be negative (e.g. a credit card).`;
}

/** Create / edit wallet form. The currency can only be chosen on creation. */
export function WalletForm(props: WalletFormProps) {
  const [state, formAction] = useActionState(props.action, initialFormState);
  const err = state.fieldErrors ?? {};
  const v = state.values ?? {};

  const initialCurrency = props.mode === "edit" ? props.currency : (v.currency ?? props.defaults?.currency ?? "");
  const [currency, setCurrency] = useState(initialCurrency);
  // Keep the picker in sync with the echoed value after a failed submit.
  const [echoed, setEchoed] = useState(state.values);
  if (echoed !== state.values) {
    setEchoed(state.values);
    if (props.mode === "create" && state.values?.currency !== undefined) setCurrency(state.values.currency);
  }

  return (
    <form action={formAction} className="space-y-5" noValidate>
      <FormError message={state.message} />

      <Field id="name" label="Name" error={err.name}>
        <Input
          id="name"
          name="name"
          required
          maxLength={60}
          autoComplete="off"
          placeholder="e.g. Main account, Cash, Savings"
          defaultValue={v.name ?? props.defaults?.name}
          error={err.name}
        />
      </Field>

      {props.mode === "create" ? (
        <Field
          id="currency"
          label="Currency"
          hint="Can't be changed later. Type a code to jump to it."
          error={err.currency}
        >
          <Select
            id="currency"
            name="currency"
            required
            // Uncontrolled on purpose: React resets the form after an action and only `defaultValue` survives
            // that. React applies a select's defaultValue on mount only, hence the key on the echoed value.
            // `currency` state just drives the balance hint/suffix.
            key={v.currency ?? "initial"}
            defaultValue={v.currency ?? props.defaults?.currency ?? ""}
            onChange={(e) => setCurrency(e.target.value)}
            aria-describedby={err.currency ? undefined : "currency-hint"}
            error={err.currency}
          >
            <option value="" disabled>
              Choose a currency…
            </option>
            <optgroup label="Common">
              {props.currencies.pinned.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.code} — {c.name}
                </option>
              ))}
            </optgroup>
            <optgroup label="All currencies">
              {props.currencies.rest.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.code} — {c.name}
                </option>
              ))}
            </optgroup>
          </Select>
        </Field>
      ) : (
        <div className="space-y-1.5">
          <p className="text-sm font-medium text-foreground">Currency</p>
          <p className="flex h-11 items-center rounded-xl border border-border bg-surface-muted px-3.5 text-sm text-muted-foreground">
            {props.currencyLabel}
          </p>
          <p className="text-xs text-muted-foreground">The currency of a wallet can&apos;t be changed.</p>
        </div>
      )}

      <Field id="initialBalance" label="Initial balance" hint={balanceHint(currency || undefined)} error={err.initialBalance}>
        <div className="relative">
          <Input
            id="initialBalance"
            name="initialBalance"
            inputMode="decimal"
            autoComplete="off"
            placeholder="0"
            className="pr-16 text-right tabular-nums"
            defaultValue={v.initialBalance ?? props.defaults?.initialBalance}
            aria-describedby={err.initialBalance ? undefined : "initialBalance-hint"}
            error={err.initialBalance}
          />
          {currency && (
            <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-muted-foreground">
              {currency}
            </span>
          )}
        </div>
      </Field>

      <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
        <Link href={props.cancelHref} className={buttonClasses({ variant: "secondary" })}>
          Cancel
        </Link>
        <SubmitButton pendingLabel={props.pendingLabel}>{props.submitLabel}</SubmitButton>
      </div>
    </form>
  );
}
