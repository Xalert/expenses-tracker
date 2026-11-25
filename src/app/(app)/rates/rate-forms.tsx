"use client";

import { useActionState } from "react";
import { DatePicker, Field, Input, Select, SubmitButton } from "@/components/ui";
import { initialFormState } from "@/lib/form";
import { FormStatus, resultKey } from "../account/form-status";
import { deleteManualRateAction, setManualRateAction } from "./actions";

/**
 * "1 KWD = [rate] [EUR ▾] from [date]" for one currency. Keyed on the action result, so a failed save refills the
 * fields and a successful one clears the rate.
 */
export function RateForm({ currency, bases, today }: { currency: string; bases: string[]; today: string }) {
  const [state, formAction] = useActionState(setManualRateAction, initialFormState);
  const v = state.ok ? {} : (state.values ?? {});
  const err = state.fieldErrors ?? {};
  const id = (name: string) => `${name}-${currency}`;
  return (
    <form key={resultKey(state)} action={formAction} className="space-y-3" aria-label={`New rate for ${currency}`}>
      <FormStatus state={state} />
      <input type="hidden" name="currency" value={currency} />
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_7rem_minmax(0,1fr)]">
        <Field id={id("rate")} label={`1 ${currency} =`} error={err.rate ?? err.currency}>
          <Input
            id={id("rate")}
            name="rate"
            inputMode="decimal"
            autoComplete="off"
            placeholder="3.25"
            defaultValue={v.rate ?? ""}
            error={err.rate ?? err.currency}
            required
          />
        </Field>
        <Field id={id("base")} label="Currency" error={err.base}>
          <Select id={id("base")} name="base" defaultValue={v.base ?? bases[0]} error={err.base}>
            {bases.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </Select>
        </Field>
        <Field id={id("effectiveDate")} label="From" error={err.effectiveDate}>
          <DatePicker
            id={id("effectiveDate")}
            name="effectiveDate"
            today={today}
            defaultValue={v.effectiveDate ?? today}
            error={err.effectiveDate}
            required
          />
        </Field>
      </div>
      <SubmitButton size="sm" pendingLabel="Saving…">
        Save rate
      </SubmitButton>
    </form>
  );
}

/** Removes one rate (a small form, so it works without JavaScript too). */
export function DeleteRateButton({ id, label }: { id: number; label: string }) {
  const [state, formAction] = useActionState(deleteManualRateAction, initialFormState);
  return (
    <form action={formAction} className="flex items-center gap-2">
      <input type="hidden" name="id" value={id} />
      {!state.ok && state.message && <span className="text-xs text-danger">{state.message}</span>}
      <SubmitButton size="sm" variant="secondary" pendingLabel="Removing…" aria-label={`Remove ${label}`}>
        Remove
      </SubmitButton>
    </form>
  );
}
