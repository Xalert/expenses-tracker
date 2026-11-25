"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { DatePicker, Field, FormError, Input, SubmitButton, buttonClasses } from "@/components/ui";
import { cn } from "@/lib/cn";
import { formatDate, formatMonth, isValidDate } from "@/lib/dates";
import { initialFormState, type FormState } from "@/lib/form";
import { currencyDecimals, formatMoney, parseAmount } from "@/lib/money";
import { adjustmentPreview, balanceOnDate } from "@/lib/reconcile";

/** The id of the actual-balance input; the wallet menu's "Reconcile balance" item focuses it when already open. */
export const RECONCILE_INPUT_ID = "actualBalance";

/** The id of the wallet menu's "⋯" button, where focus goes back when the form closes. */
export const walletMenuTriggerId = (walletId: number) => `wallet-menu-${walletId}`;

export type ReconcileFormProps = {
  /** `reconcileWalletAction.bind(null, walletId)`, bound on the server (so the form also posts without JavaScript). */
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  walletId: number;
  walletName: string;
  currency: string;
  /** The user's today (`todayInZone`): the default date and the latest one. */
  today: string;
  /** `listWalletClosingBalances` through today: the live preview's tracked balance for any chosen date. */
  initialBalanceMinor: number;
  closings: [string, number][];
  /** The page without `?reconcile=1` (Close). */
  closeHref: string;
  /** The `YYYY-MM` the page shows: after saving for another month, the confirmation links to it. */
  month: string;
  /** `/wallets/<id>`, to build that link. */
  walletHref: string;
  /** Overrides the action's initial state (render tests). */
  initialState?: FormState;
};

// A small id per action-state object: the fields remount after every result (React resets a form after its action
// runs; remounting with the echoed values is the codebase's fix), and two equal results still count as two.
const stateIds = new WeakMap<object, number>();
let nextStateId = 0;
function stateId(state: object): number {
  let id = stateIds.get(state);
  if (id === undefined) {
    id = nextStateId++;
    stateIds.set(state, id);
  }
  return id;
}

function amountHint(currency: string): string {
  const d = currencyDecimals(currency);
  const decimals = d === 0 ? "whole amounts only" : `up to ${d} decimal${d === 1 ? "" : "s"}`;
  return `In ${currency}, ${decimals}. May be negative (use −).`;
}

/**
 * The wallet page's "Reconcile balance" panel, open while the URL has `?reconcile=1` (the wallet menu links there, so
 * it is a real URL and works without JavaScript). The user types the wallet's actual balance and a date (today by
 * default); the difference from the tracked balance at the end of that day is recorded as one entry
 * (`reconcileWalletAction`). With JavaScript the panel says live what saving will add; without it the confirmation
 * does. Focus goes into the balance input on open, and back to the "⋯" button on Close or Escape.
 */
export function ReconcileForm(props: ReconcileFormProps) {
  const router = useRouter();
  const [state, formAction] = useActionState(props.action, props.initialState ?? initialFormState);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    document.getElementById(RECONCILE_INPUT_ID)?.focus();
  }, []);

  // After a failed save the fields remounted: focus the first invalid one (else focus would drop to <body>).
  const handled = useRef(new WeakSet<FormState>([initialFormState]));
  useEffect(() => {
    if (handled.current.has(state)) return;
    handled.current.add(state);
    if (!state.ok) formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [state]);

  function close() {
    router.replace(props.closeHref, { scroll: false });
    document.getElementById(walletMenuTriggerId(props.walletId))?.focus();
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    // Escape inside the date picker (or on its open trigger) closes the calendar only.
    const target = e.target as HTMLElement;
    if (target.closest('[role="dialog"]') || target.getAttribute("aria-expanded") === "true") return;
    e.preventDefault();
    close();
  }

  const savedDate = state.ok ? state.values?.date : undefined;
  const otherMonth = savedDate && isValidDate(savedDate) && savedDate.slice(0, 7) !== props.month ? savedDate.slice(0, 7) : null;

  return (
    <section
      id="reconcile"
      aria-labelledby="reconcile-heading"
      onKeyDown={onKeyDown}
      className="flex flex-col gap-4 rounded-2xl border border-border bg-surface-open p-4 sm:p-5"
    >
      <div>
        <h2 id="reconcile-heading" className="text-base font-bold text-foreground">
          Reconcile balance
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Enter what {props.walletName} really holds. The difference from the tracked balance is added as one entry in
          “Balance adjustment”, dated that day, which you can edit or delete like any other.
        </p>
      </div>

      {state.ok ? (
        <p role="status" className="rounded-xl border border-income/30 bg-income-soft px-3 py-2 text-sm text-income">
          {state.message}
          {otherMonth && (
            <>
              {" "}
              <Link
                href={`${props.walletHref}?month=${otherMonth}&reconcile=1`}
                className="font-semibold underline"
              >
                Show {formatMonth(otherMonth)}
              </Link>
            </>
          )}
        </p>
      ) : (
        <FormError message={state.message} />
      )}

      <form ref={formRef} action={formAction} noValidate className="flex flex-col gap-4">
        <ReconcileFields key={stateId(state)} {...props} state={state} />
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Link
            href={props.closeHref}
            scroll={false}
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
              e.preventDefault();
              close();
            }}
            className={buttonClasses({ variant: "secondary" })}
          >
            Close
          </Link>
          <SubmitButton pendingLabel="Recording…">Record adjustment</SubmitButton>
        </div>
      </form>
    </section>
  );
}

function ReconcileFields(props: ReconcileFormProps & { state: FormState }) {
  const { state, currency, today } = props;
  const err = state.ok ? {} : (state.fieldErrors ?? {});
  const v = state.ok ? {} : (state.values ?? {});
  const [text, setText] = useState(v.actualBalance ?? "");
  const [date, setDate] = useState(isValidDate(v.date) && v.date <= today ? v.date : today);

  const tracked = balanceOnDate(props.initialBalanceMinor, props.closings, date);
  const typed = text.trim() === "" ? null : parseAmount(text, currency, { allowNegative: true });
  const dayLabel = date === today ? "today" : formatDate(date);

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id={RECONCILE_INPUT_ID} label="Actual balance" hint={amountHint(currency)} error={err.actualBalance}>
          <Input
            id={RECONCILE_INPUT_ID}
            name="actualBalance"
            inputMode="decimal"
            autoComplete="off"
            required
            value={text}
            onChange={(e) => setText(e.target.value)}
            error={err.actualBalance}
            aria-describedby={cn(!err.actualBalance && `${RECONCILE_INPUT_ID}-hint`, "reconcile-preview")}
          />
        </Field>
        <Field id="reconcile-date" label="As of the end of" error={err.date}>
          <DatePicker
            id="reconcile-date"
            name="date"
            today={today}
            max={today}
            required
            value={date}
            onChange={(next) => setDate(next || today)}
            error={err.date}
            align="end"
          />
        </Field>
      </div>
      <p
        id="reconcile-preview"
        aria-live="polite"
        className="rounded-xl bg-surface px-3 py-2.5 text-sm text-muted-foreground tabular-nums"
      >
        Tracked balance at the end of {dayLabel}:{" "}
        <span className={cn("font-semibold", tracked < 0 ? "text-expense" : "text-foreground")}>
          {formatMoney(tracked, currency)}
        </span>
        .
        {typed !== null && <span className="font-semibold text-foreground"> {adjustmentPreview(typed - tracked, currency)}</span>}
      </p>
    </>
  );
}
