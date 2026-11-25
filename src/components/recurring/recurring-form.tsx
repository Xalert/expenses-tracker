"use client";

import Link from "next/link";
import { useActionState, useEffect, useRef, useState } from "react";
import type { CategoryOption, WalletOption } from "@/components/transactions/entry-form";
import {
  BigAmount,
  Card,
  CardBody,
  DatePicker,
  FieldError,
  FormError,
  Input,
  PillPicker,
  Select,
  SubmitButton,
  buttonClasses,
} from "@/components/ui";
import { initialFormState, type FormState } from "@/lib/form";
import { RECURRING_FREQUENCY_VALUES, unitLabel, type Frequency } from "@/lib/recurrence";

export type RecurringFormDefaults = {
  walletId: number;
  categoryId: number;
  amount: string;
  note: string;
  frequency: Frequency;
  interval: number;
  /** "" for an ended rule (the form then asks for one). */
  nextDate: string;
  endDate: string;
};

const LABEL: Record<Frequency, string> = { daily: "Daily", weekly: "Weekly", monthly: "Monthly", yearly: "Yearly" };
const sectionLabel = "text-[13px] font-semibold text-muted-foreground";

// The form is keyed per action result so React's reset after an action cannot leave the selects / pills out of step
// with the echoed values (see "Forms after a failed Server Action" in CLAUDE.md).
const resultIds = new WeakMap<object, number>();
let nextResultId = 0;
function resultId(state: object): number {
  let id = resultIds.get(state);
  if (id === undefined) {
    id = nextResultId++;
    resultIds.set(state, id);
  }
  return id;
}

/**
 * Edit a repeating entry (`/recurring/<id>/edit`): amount, category (the rule's kind), wallet, how often, the next
 * date, an optional end date and the note. A plain `<form action>`: it works without JavaScript, and a refused save
 * comes back with the errors on their fields and the submitted values.
 */
export function RecurringForm({
  action,
  defaults,
  wallets,
  categories,
  kind,
  today,
}: {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  defaults: RecurringFormDefaults;
  wallets: WalletOption[];
  categories: CategoryOption[];
  kind: "expense" | "income";
  /** The user's today (`todayInZone`), for the date pickers. */
  today: string;
}) {
  const [state, formAction] = useActionState(action, initialFormState);
  const v = state.values ?? {};
  const err = state.fieldErrors ?? {};
  const pick = (name: keyof RecurringFormDefaults) => v[name] ?? String(defaults[name]);
  const [walletId, setWalletId] = useState(String(defaults.walletId));
  const [frequency, setFrequency] = useState<Frequency>(defaults.frequency);
  const [every, setEvery] = useState(String(defaults.interval));
  const wallet = wallets.find((w) => String(w.id) === walletId);
  const formRef = useRef<HTMLFormElement>(null);

  // After a refused save, focus the first invalid control (the form remounted).
  useEffect(() => {
    if (state === initialFormState) return;
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [state]);

  const n = /^\d{1,2}$/.test(every) && Number(every) >= 1 ? Number(every) : 2;

  return (
    <Card>
      <CardBody>
        <form ref={formRef} key={resultId(state)} action={formAction} noValidate className="space-y-6">
          <FormError message={state.ok ? undefined : state.message} />
          <BigAmount
            id="amount"
            name="amount"
            label="Amount"
            currency={wallet?.currency}
            currencyText={wallet ? `${wallet.currency} · ${kind === "expense" ? "from" : "into"} ${wallet.name}` : ""}
            defaultValue={pick("amount")}
            error={err.amount}
          />

          <div className="space-y-2">
            <p id="categoryId-label" className={sectionLabel}>
              Category
            </p>
            <PillPicker
              id="categoryId"
              name="categoryId"
              aria-labelledby="categoryId-label"
              required
              options={categories.map((c) => ({ value: String(c.id), label: c.name }))}
              defaultValue={pick("categoryId")}
              error={err.categoryId}
            />
          </div>

          <div className="space-y-2">
            <p id="walletId-label" className={sectionLabel}>
              Wallet
            </p>
            <PillPicker
              id="walletId"
              name="walletId"
              aria-labelledby="walletId-label"
              required
              options={wallets.map((w) => ({ value: String(w.id), label: w.archived ? `${w.name} (archived)` : w.name }))}
              defaultValue={pick("walletId")}
              onChange={setWalletId}
              error={err.walletId}
            />
          </div>

          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <label htmlFor="frequency" className={sectionLabel}>
                Repeat
              </label>
              <Select
                id="frequency"
                name="frequency"
                defaultValue={v.frequency ?? frequency}
                onChange={(e) => setFrequency(e.target.value as Frequency)}
                error={err.frequency}
                className="w-auto min-w-32"
              >
                {RECURRING_FREQUENCY_VALUES.map((f) => (
                  <option key={f} value={f}>
                    {LABEL[f]}
                  </option>
                ))}
              </Select>
              <span className="inline-flex items-center gap-2 text-sm text-foreground">
                <label htmlFor="interval">Every</label>
                <Input
                  id="interval"
                  name="interval"
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={2}
                  defaultValue={pick("interval")}
                  onChange={(e) => setEvery(e.target.value.trim())}
                  error={err.interval}
                  className="w-14 text-center tabular-nums"
                  aria-describedby="interval-unit"
                />
                <span id="interval-unit">{unitLabel(frequency, n)}</span>
              </span>
            </div>
            <FieldError id="frequency">{err.frequency}</FieldError>
            <FieldError id="interval">{err.interval}</FieldError>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label htmlFor="nextDate" className={sectionLabel}>
                Next entry
              </label>
              <DatePicker
                id="nextDate"
                name="nextDate"
                today={today}
                required
                defaultValue={pick("nextDate")}
                error={err.nextDate}
                placeholder="Choose a date"
              />
              <FieldError id="nextDate">{err.nextDate}</FieldError>
            </div>
            <div className="space-y-1.5">
              <label htmlFor="endDate" className={sectionLabel}>
                Until (optional)
              </label>
              <DatePicker
                id="endDate"
                name="endDate"
                today={today}
                allowEmpty
                defaultValue={pick("endDate")}
                error={err.endDate}
                placeholder="No end date"
              />
              <FieldError id="endDate">{err.endDate}</FieldError>
            </div>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="note" className="sr-only">
              Note
            </label>
            <Input
              id="note"
              name="note"
              maxLength={500}
              placeholder="Note (optional)"
              autoComplete="off"
              defaultValue={pick("note")}
              error={err.note}
            />
            <FieldError id="note">{err.note}</FieldError>
          </div>

          <p className="text-sm text-muted-foreground">
            Changes apply to the entries still to come; the ones already added stay as they are. Changing how often it
            repeats or the next date starts the schedule again from that date.
          </p>

          <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
            <Link href="/recurring" className={buttonClasses({ variant: "secondary" })}>
              Cancel
            </Link>
            <SubmitButton pendingLabel="Saving…">Save changes</SubmitButton>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}
