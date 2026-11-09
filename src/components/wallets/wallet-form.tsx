"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { BigAmount, Button, Field, FieldError, FormError, Input, PillPicker, Select, buttonClasses } from "@/components/ui";
import { cn } from "@/lib/cn";
import type { CurrencyOption } from "@/lib/currencies";
import { initialFormState, type FormState } from "@/lib/form";
import { currencyDecimals } from "@/lib/money";

type Action = (prev: FormState, formData: FormData) => Promise<FormState>;

type WalletFormProps = {
  action: Action;
  submitLabel: string;
  pendingLabel: string;
  /**
   * `page` (the full page; Cancel links to `cancelHref` and the action redirects) or `dialog` (posts `mode=dialog`;
   * on success the dialog closes with `router.back()` and the page behind refreshes; Cancel is `router.back()`).
   */
  variant?: "page" | "dialog";
  cancelHref: string;
  defaults?: { name?: string; initialBalance?: string; /** The group preselected in the Group select. */ groupId?: string };
  /** The user's groups; the Group select is shown from two. */
  groups?: { id: number; name: string }[];
  /** Edit only: the Archive / Unarchive (and Delete) section, rendered between the fields and the footer. */
  manage?: ReactNode;
} & (
  | {
      mode: "create";
      /** The pinned common currencies, shown as pills. */
      pinned: CurrencyOption[];
      /** Every currency, offered as suggestions for the typed code. */
      all: CurrencyOption[];
    }
  | { mode: "edit"; currency: string; currencyLabel: string }
);

const sectionLabel = "text-[13px] font-semibold text-muted-foreground";

function balanceHint(currency: string) {
  if (!/^[A-Z]{3}$/.test(currency)) return "Choose a currency first. May be negative (e.g. a credit card).";
  let d = 2;
  try {
    d = currencyDecimals(currency);
  } catch {
    // unknown code: keep the default
  }
  const decimals = d === 0 ? "whole amounts only" : `up to ${d} decimal${d === 1 ? "" : "s"}`;
  return `In ${currency}, ${decimals}. May be negative (e.g. a credit card). Leave empty for 0.`;
}

// Stable small ids for action-state objects: the fields remount after every result (React resets a form after its
// action runs; remounting with the echoed values is the codebase's fix, and it re-checks the right currency pill).
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

/**
 * Create / edit wallet form. The currency can only be chosen on creation: pills for the common currencies plus a
 * "type a code" input with suggestions over every currency (both post `currency`; a typed code wins, see
 * `chosenCurrency`). The footer sits outside the keyed `<form>` (its submit joins it with `form=`), so the edit
 * variant's Archive / Delete forms can sit between the fields and the footer.
 */
export function WalletForm(props: WalletFormProps) {
  const router = useRouter();
  const formId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const [state, formAction, pending] = useActionState(props.action, initialFormState);
  const isDialog = props.variant === "dialog";

  // After each result: close the dialog on success, else move focus to the first invalid control (the fields
  // remounted, so focus would otherwise drop to <body>, outside the dialog's focus trap).
  const handled = useRef(new WeakSet<FormState>([initialFormState]));
  useEffect(() => {
    if (handled.current.has(state)) return;
    handled.current.add(state);
    if (state.ok) {
      if (isDialog) {
        // Refresh once the page behind is back (back() is asynchronous), so it shows the change.
        window.addEventListener("popstate", () => router.refresh(), { once: true });
        router.back();
      }
      return;
    }
    const invalid = formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
    const target =
      invalid?.getAttribute("role") === "radiogroup"
        ? (invalid.querySelector<HTMLElement>("input:checked") ?? invalid.querySelector<HTMLElement>("input"))
        : invalid;
    target?.focus();
  }, [state, isDialog, router]);

  return (
    <div className="space-y-5">
      <form id={formId} ref={formRef} action={formAction} className="space-y-5" noValidate>
        {isDialog && <input type="hidden" name="mode" value="dialog" />}
        <WalletFields key={stateId(state)} {...props} state={state} />
      </form>

      {props.manage}

      <div className="flex flex-col-reverse gap-2 border-t border-border pt-4 sm:flex-row sm:justify-end">
        {isDialog ? (
          <Button variant="secondary" onClick={() => router.back()}>
            Cancel
          </Button>
        ) : (
          <Link href={props.cancelHref} className={buttonClasses({ variant: "secondary" })}>
            Cancel
          </Link>
        )}
        <Button type="submit" form={formId} pending={pending}>
          {pending ? props.pendingLabel : props.submitLabel}
        </Button>
      </div>
    </div>
  );
}

function WalletFields(props: WalletFormProps & { state: FormState }) {
  const { state } = props;
  const err = state.ok ? {} : (state.fieldErrors ?? {});
  const v = state.values ?? {};

  return (
    <>
      {!state.ok && <FormError message={state.message} />}

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

      {props.groups && props.groups.length >= 2 && (
        <Field id="groupId" label="Group" error={err.groupId}>
          <Select
            id="groupId"
            name="groupId"
            required
            defaultValue={v.groupId ?? props.defaults?.groupId ?? String(props.groups[0].id)}
            error={err.groupId}
          >
            {props.groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </Select>
        </Field>
      )}

      {props.mode === "create" ? (
        <CurrencyAndBalance
          pinned={props.pinned}
          all={props.all}
          echoedCurrency={v.currency ?? ""}
          initialBalance={v.initialBalance ?? props.defaults?.initialBalance}
          currencyError={err.currency}
          balanceError={err.initialBalance}
        />
      ) : (
        <>
          <div className="space-y-1.5">
            <p className={sectionLabel}>Currency</p>
            <p className="flex min-h-11 items-center rounded-xl border border-border bg-surface-muted px-3.5 text-sm font-semibold text-muted-foreground">
              {props.currencyLabel}
            </p>
            <p className="text-xs text-muted-foreground">A wallet&apos;s currency can&apos;t be changed.</p>
          </div>
          <BigAmount
            id="initialBalance"
            name="initialBalance"
            label="Starting balance"
            required={false}
            currency={props.currency}
            currencyText={props.currency}
            defaultValue={v.initialBalance ?? props.defaults?.initialBalance}
            hint={balanceHint(props.currency)}
            error={err.initialBalance}
          />
        </>
      )}
    </>
  );
}

/**
 * The create form's currency (pills + a typed code) and the starting balance, whose currency label follows the
 * choice. Typing a code unchecks the pills (remount, nothing checked), so only the typed value is posted; choosing a
 * pill clears the typed code.
 */
function CurrencyAndBalance({
  pinned,
  all,
  echoedCurrency,
  initialBalance,
  currencyError,
  balanceError,
}: {
  pinned: CurrencyOption[];
  all: CurrencyOption[];
  echoedCurrency: string;
  initialBalance?: string;
  currencyError?: string;
  balanceError?: string;
}) {
  const isPinned = pinned.some((c) => c.code === echoedCurrency);
  const [pill, setPill] = useState(isPinned ? echoedCurrency : "");
  const [typed, setTyped] = useState(isPinned ? "" : echoedCurrency);
  const [pillsKey, setPillsKey] = useState(0);
  const currency = (typed.trim() || pill).toUpperCase();

  return (
    <>
      <div className="space-y-2">
        <p id="currency-label" className={sectionLabel}>
          Currency
        </p>
        <PillPicker
          key={pillsKey}
          id="currency"
          name="currency"
          aria-labelledby="currency-label"
          required
          options={pinned.map((c) => ({ value: c.code, label: <span title={c.name}>{c.code}</span> }))}
          defaultValue={pill}
          onChange={(code) => {
            setPill(code);
            setTyped("");
          }}
          // A typed code carries the error itself (below), so focus goes to the input after a failed save.
          error={typed ? undefined : currencyError}
        />
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 pt-1">
          <label htmlFor="currency-code" className="text-sm text-muted-foreground">
            Another currency
          </label>
          <Input
            id="currency-code"
            // The same name as the pills: a filled code wins (`chosenCurrency`), so the no-JS form works too.
            name="currency"
            list="currency-suggestions"
            value={typed}
            onChange={(e) => {
              const next = e.target.value.toUpperCase().slice(0, 3);
              if (next !== "" && typed === "") {
                // Uncheck the pills: remount them with nothing selected.
                setPill("");
                setPillsKey((k) => k + 1);
              }
              setTyped(next);
            }}
            maxLength={3}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            placeholder="Type a code"
            aria-invalid={currencyError && typed ? true : undefined}
            aria-describedby={cn("currency-note", currencyError && typed && "currency-error")}
            className="w-36! uppercase"
          />
          <datalist id="currency-suggestions">
            {all.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name}
              </option>
            ))}
          </datalist>
        </div>
        {typed && <FieldError id="currency">{currencyError}</FieldError>}
        <p id="currency-note" className="text-xs text-muted-foreground">
          This can&apos;t be changed once the wallet exists.
        </p>
      </div>

      <BigAmount
        id="initialBalance"
        name="initialBalance"
        label="Starting balance"
        required={false}
        currency={currency || undefined}
        currencyText={currency || "—"}
        defaultValue={initialBalance}
        hint={balanceHint(currency)}
        error={balanceError}
      />
    </>
  );
}
