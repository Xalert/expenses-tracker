"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  Button,
  Card,
  CardBody,
  DatePicker,
  FieldError,
  FormError,
  Input,
  PillPicker,
  Segmented,
  Select,
  SubmitButton,
  buttonClasses,
  pillClasses,
} from "@/components/ui";
import { CalendarIcon } from "@/components/ui/picker-icons";
import { cn } from "@/lib/cn";
import { addDays, formatDate } from "@/lib/dates";
import { initialFormState, type FormState } from "@/lib/form";
import { currencyDecimals } from "@/lib/money";

export type EntryKind = "expense" | "income" | "transfer";

export type WalletOption = { id: number; name: string; currency: string; archived: boolean };
export type CategoryOption = { id: number; name: string; kind: "expense" | "income" };

export type EntryInitialValues = {
  kind: EntryKind;
  walletId?: number;
  categoryId?: number;
  amount?: string;
  date: string;
  note?: string;
  fromWalletId?: number;
  toWalletId?: number;
  receivedAmount?: string;
};

type Action = (prev: FormState, formData: FormData) => Promise<FormState>;

const KIND_LABEL: Record<EntryKind, string> = { expense: "Expense", income: "Income", transfer: "Transfer" };

/** Small muted heading over a group of pills (and the visible label of the big amount inputs). */
const sectionLabel = "text-[13px] font-semibold text-muted-foreground";
const focusRing = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

// Stable small ids for action-state objects. The form is keyed by them so it remounts after every action
// result: React resets a form after its action runs, which would otherwise snap the controlled <select>s
// back to their initial options while their React state still holds the user's choice. The remount is also what
// clears the amount and note after a "Keep open for another" save (a success state carries no `values`).
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

function placeholderFor(currency: string | undefined) {
  const d = currency ? currencyDecimals(currency) : 2;
  return d === 0 ? "0" : `0.${"0".repeat(d)}`;
}

function walletLabel(w: WalletOption) {
  return `${w.name} (${w.currency})${w.archived ? " — archived" : ""}`;
}

/** A large amount input (`tabular-nums`, decimal keyboard) with a label above and the currency beside it. */
function BigAmount({
  id,
  label,
  currency,
  currencyText,
  defaultValue,
  error,
  autoFocus,
}: {
  id: string;
  label: string;
  currency: string | undefined;
  /** Shown beside the number, e.g. "EUR · from Cash". */
  currencyText: ReactNode;
  defaultValue?: string;
  error?: string;
  /** Marks the input for `Dialog` to focus when it opens (`data-autofocus`). */
  autoFocus?: boolean;
}) {
  return (
    <div className="min-w-0 space-y-1.5">
      <label htmlFor={id} className={sectionLabel}>
        {label}
      </label>
      <div
        className={cn(
          "flex items-center gap-3 rounded-2xl border bg-field px-4",
          "focus-within:border-accent focus-within:outline-2 focus-within:outline-ring/40",
          error ? "border-danger focus-within:outline-danger/30" : "border-border",
        )}
      >
        <input
          id={id}
          name={id}
          inputMode="decimal"
          autoComplete="off"
          required
          placeholder={placeholderFor(currency)}
          defaultValue={defaultValue}
          data-autofocus={autoFocus ? "" : undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={cn(`${id}-currency`, error && `${id}-error`)}
          className={cn(
            "h-[72px] w-full min-w-0 flex-1 bg-transparent text-[44px] leading-none font-extrabold tracking-[-0.03em]",
            "text-foreground tabular-nums outline-none placeholder:text-muted-foreground/45 sm:text-[48px]",
          )}
        />
        <span
          id={`${id}-currency`}
          className="max-w-[45%] shrink-0 truncate text-sm font-semibold text-muted-foreground"
        >
          {currencyText}
        </span>
      </div>
      <FieldError id={id}>{error}</FieldError>
    </div>
  );
}

/**
 * The shared add / edit form with an Expense / Income / Transfer switch. Pass `transactionAction` to allow
 * expense/income and `transferAction` to allow transfers (the Add form passes both; each edit page passes one).
 *
 * `variant="page"` (default) is the full-page form: a card, Cancel links to `returnTo`, and the action redirects.
 * `variant="dialog"` is the Add dialog: no card, it posts `mode=dialog` so the create actions return
 * `{ ok: true, message }`, and on success it either closes the dialog (`router.back()`, then `router.refresh()`) or,
 * with "Keep open for another", clears amount and note and stays.
 */
export function EntryForm({
  wallets,
  categories,
  initial,
  today,
  transactionAction,
  transferAction,
  returnTo,
  submitLabel,
  canTransfer,
  variant = "page",
}: {
  wallets: WalletOption[];
  categories: CategoryOption[];
  initial: EntryInitialValues;
  /** The server's today (`todayISO()`), for the Today / Yesterday pills; passed in so SSR and the browser agree. */
  today: string;
  transactionAction?: Action;
  transferAction?: Action;
  returnTo: string;
  /** Overrides the "Add expense" / "Add transfer"… label, e.g. "Save changes" when editing. */
  submitLabel?: string;
  /** False when fewer than two wallets can take part in a transfer. */
  canTransfer: boolean;
  variant?: "page" | "dialog";
}) {
  const router = useRouter();
  const formId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const isDialog = variant === "dialog";

  const kinds: EntryKind[] = [
    ...(transactionAction ? (["expense", "income"] as const) : []),
    ...(transferAction ? (["transfer"] as const) : []),
  ];

  const [txState, txFormAction, txPending] = useActionState(transactionAction ?? noop, initialFormState);
  const [trState, trFormAction, trPending] = useActionState(transferAction ?? noop, initialFormState);

  const activeWallets = wallets.filter((w) => !w.archived);
  const firstWallet = (activeWallets[0] ?? wallets[0])?.id;

  const [kind, setKind] = useState<EntryKind>(kinds.includes(initial.kind) ? initial.kind : kinds[0]);
  const [walletId, setWalletId] = useState(String(initial.walletId ?? firstWallet ?? ""));
  const [categoryId, setCategoryId] = useState(String(initial.categoryId ?? ""));
  const initialFrom = initial.fromWalletId ?? initial.walletId ?? firstWallet;
  const [fromWalletId, setFromWalletId] = useState(String(initialFrom ?? ""));
  const [toWalletId, setToWalletId] = useState(
    String(initial.toWalletId ?? activeWallets.find((w) => w.id !== initialFrom)?.id ?? ""),
  );
  const [date, setDate] = useState(initial.date);
  const [keepOpen, setKeepOpen] = useState(false);

  const isTransfer = kind === "transfer";
  const state = isTransfer ? trState : txState;
  const pending = isTransfer ? trPending : txPending;
  const err = state.fieldErrors ?? {};
  const v = state.values ?? {};

  // After each action result: close / clear on success, else move focus to the first invalid control (the form
  // remounted, so focus would otherwise be lost to <body>, outside the dialog).
  // Each result is handled once, also when switching kinds brings an older result back into `state`.
  const handled = useRef(new WeakSet<FormState>([initialFormState]));
  useEffect(() => {
    if (handled.current.has(state)) return;
    handled.current.add(state);
    const form = formRef.current;
    if (state.ok) {
      if (keepOpen) {
        (form?.elements.namedItem("amount") as HTMLInputElement | null)?.focus();
      } else {
        // Refresh once the page behind is back, so it shows the new entry (back() is asynchronous).
        window.addEventListener("popstate", () => router.refresh(), { once: true });
        router.back();
      }
      return;
    }
    const invalid = form?.querySelector<HTMLElement>('[aria-invalid="true"]');
    const target =
      invalid?.getAttribute("role") === "radiogroup"
        ? (invalid.querySelector<HTMLElement>("input:checked") ?? invalid.querySelector<HTMLElement>("input"))
        : invalid;
    target?.focus();
  }, [state, keepOpen, router]);

  const byId = (id: string) => wallets.find((w) => String(w.id) === id);
  const wallet = byId(walletId);
  const from = byId(fromWalletId);
  const to = byId(toWalletId);
  const crossCurrency = Boolean(from && to && from.currency !== to.currency);
  const kindCategories = categories.filter((c) => c.kind === kind);

  const transferBlocked = isTransfer && !canTransfer;
  // Expense / income needs a category of that kind; without one the picker becomes an empty state.
  const noCategories = !isTransfer && kindCategories.length === 0;
  const canSubmit = !transferBlocked && !noCategories;
  const label = submitLabel ?? `Add ${KIND_LABEL[kind].toLowerCase()}`;

  const yesterday = addDays(today, -1);
  const otherDate = date !== today && date !== yesterday;

  function changeKind(next: EntryKind) {
    if (next === kind) return;
    setKind(next);
    // Categories belong to one kind; keep the choice only if it still fits.
    if (!categories.some((c) => String(c.id) === categoryId && c.kind === next)) setCategoryId("");
    // Carry the chosen wallet over as the transfer source and back.
    if (next === "transfer" && walletId) {
      setFromWalletId(walletId);
      if (toWalletId === walletId) setToWalletId(String(activeWallets.find((w) => String(w.id) !== walletId)?.id ?? ""));
    } else if (kind === "transfer" && fromWalletId) {
      setWalletId(fromWalletId);
    }
  }

  const form = (
    <form
      id={formId}
      ref={formRef}
      key={`${stateId(txState)}-${stateId(trState)}`}
      action={isTransfer ? trFormAction : txFormAction}
      className="space-y-6"
      noValidate
    >
      <input type="hidden" name="returnTo" value={returnTo} />
      {isDialog && <input type="hidden" name="mode" value="dialog" />}
      {!state.ok && <FormError message={state.message} />}

      {kinds.length > 1 && (
        <Segmented
          name="kind"
          aria-label="Type"
          options={kinds.map((k) => ({ value: k, label: KIND_LABEL[k] }))}
          value={kind}
          onChange={(k) => changeKind(k as EntryKind)}
          fullWidth
          className="w-full sm:w-auto"
        />
      )}
      {kinds.length === 1 && kind !== "transfer" && <input type="hidden" name="kind" value={kind} />}

      {transferBlocked ? (
        <div className="rounded-2xl border border-dashed border-border-strong px-4 py-6 text-center text-sm text-muted-foreground">
          <p>A transfer needs at least two active wallets.</p>
          <Link href="/wallets/new" className="mt-2 inline-block font-medium text-accent hover:underline">
            Create another wallet
          </Link>
        </div>
      ) : isTransfer ? (
        <>
          <div className="grid gap-4 sm:grid-cols-[1fr_auto_1fr] sm:items-end">
            <div className="space-y-1.5">
              <label htmlFor="fromWalletId" className={sectionLabel}>
                From
              </label>
              <Select
                id="fromWalletId"
                name="fromWalletId"
                value={fromWalletId}
                onChange={(e) => setFromWalletId(e.target.value)}
                error={err.fromWalletId}
              >
                {wallets.map((w) => (
                  <option key={w.id} value={w.id}>
                    {walletLabel(w)}
                  </option>
                ))}
              </Select>
              <FieldError id="fromWalletId">{err.fromWalletId}</FieldError>
            </div>
            <span aria-hidden="true" className="hidden h-11 items-center text-lg text-muted-foreground sm:flex">
              →
            </span>
            <div className="space-y-1.5">
              <label htmlFor="toWalletId" className={sectionLabel}>
                To
              </label>
              <Select
                id="toWalletId"
                name="toWalletId"
                value={toWalletId}
                onChange={(e) => setToWalletId(e.target.value)}
                error={err.toWalletId}
              >
                {!toWalletId && <option value="">Choose a wallet</option>}
                {wallets.map((w) => (
                  <option key={w.id} value={w.id} disabled={String(w.id) === fromWalletId}>
                    {walletLabel(w)}
                  </option>
                ))}
              </Select>
              <FieldError id="toWalletId">{err.toWalletId}</FieldError>
            </div>
          </div>
          <div className="space-y-2">
            <div className={cn("grid gap-4", crossCurrency && "sm:grid-cols-2")}>
              <BigAmount
                id="amount"
                label="Sent"
                currency={from?.currency}
                currencyText={from?.currency ?? ""}
                defaultValue={v.amount ?? initial.amount}
                error={err.amount}
                autoFocus={isDialog}
              />
              {crossCurrency && (
                <BigAmount
                  id="receivedAmount"
                  label="Received"
                  currency={to?.currency}
                  currencyText={to?.currency ?? ""}
                  defaultValue={v.receivedAmount ?? initial.receivedAmount}
                  error={err.receivedAmount}
                />
              )}
            </div>
            {crossCurrency && (
              <p className="text-sm text-muted-foreground">
                Different currencies, so enter what actually arrived. No rate is applied for you.
              </p>
            )}
          </div>
        </>
      ) : (
        <>
          <BigAmount
            id="amount"
            label="Amount"
            currency={wallet?.currency}
            currencyText={wallet ? `${wallet.currency} · from ${wallet.name}` : ""}
            defaultValue={v.amount ?? initial.amount}
            error={err.amount}
            autoFocus={isDialog}
          />

          <div className="space-y-2">
            <p id="categoryId-label" className={sectionLabel}>
              Category
            </p>
            {noCategories ? (
              <div className="rounded-2xl border border-dashed border-border-strong px-4 py-3 text-sm text-muted-foreground">
                You have no {kind} categories.{" "}
                <Link href="/categories" className="font-medium text-accent hover:underline">
                  Create one
                </Link>{" "}
                to record {kind === "expense" ? "an expense" : "income"}.
              </div>
            ) : (
              <div className="flex flex-wrap items-start gap-2">
                <PillPicker
                  // A new kind has other categories: remount so nothing stays checked.
                  key={kind}
                  id="categoryId"
                  name="categoryId"
                  aria-labelledby="categoryId-label"
                  required
                  options={kindCategories.map((c) => ({ value: String(c.id), label: c.name }))}
                  defaultValue={categoryId}
                  onChange={setCategoryId}
                  error={err.categoryId}
                />
                {/* Plain navigation: whatever was typed in this form is not kept. */}
                <Link
                  href="/categories"
                  className={cn(
                    "inline-flex min-h-11 items-center rounded-full border border-dashed border-border-strong px-4 text-sm font-semibold text-muted-foreground transition-colors hover:text-foreground sm:min-h-10",
                    focusRing,
                  )}
                >
                  Manage categories
                </Link>
              </div>
            )}
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
              options={wallets.map((w) => ({
                value: String(w.id),
                label: w.archived ? `${w.name} (archived)` : w.name,
              }))}
              defaultValue={walletId}
              onChange={setWalletId}
              error={err.walletId}
            />
          </div>
        </>
      )}

      {!transferBlocked && (
        <>
          <div className="space-y-2">
            <p id="date-label" className={sectionLabel}>
              Date
            </p>
            <div role="group" aria-labelledby="date-label" className="flex flex-wrap items-center gap-2">
              {[
                { value: today, label: "Today" },
                { value: yesterday, label: "Yesterday" },
              ].map((d) => (
                <button
                  key={d.label}
                  type="button"
                  aria-pressed={date === d.value}
                  onClick={() => setDate(d.value)}
                  className={cn(pillClasses({ selected: date === d.value, error: Boolean(err.date) }), focusRing)}
                >
                  {d.label}
                </button>
              ))}
              {/* The picker owns the hidden <input name="date">; the pills above set the same value. */}
              <DatePicker
                id="date"
                name="date"
                required
                value={date}
                onChange={setDate}
                error={err.date}
                aria-label={otherDate ? `Date: ${formatDate(date)}. Choose another date` : "Choose another date"}
                triggerClassName={cn(pillClasses({ selected: otherDate, error: Boolean(err.date) }), focusRing, "tabular-nums")}
                display={
                  <>
                    <CalendarIcon className="size-4 shrink-0" />
                    <span>{otherDate ? formatDate(date) : "Other date"}</span>
                  </>
                }
              />
            </div>
            <FieldError id="date">{err.date}</FieldError>
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
              defaultValue={v.note ?? initial.note}
              error={err.note}
            />
            <FieldError id="note">{err.note}</FieldError>
          </div>
        </>
      )}

      {!isDialog && (
        <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
          <Link href={returnTo} className={buttonClasses({ variant: "secondary" })}>
            Cancel
          </Link>
          {canSubmit && <SubmitButton pendingLabel="Saving…">{label}</SubmitButton>}
        </div>
      )}
    </form>
  );

  if (!isDialog) {
    return (
      <Card>
        <CardBody>{form}</CardBody>
      </Card>
    );
  }

  // The dialog's footer sits outside the keyed <form> (its submit button joins it through `form=`), so the
  // "Keep open" choice and the status line survive the remount after each save.
  return (
    <div className="space-y-5">
      {form}
      <div className="space-y-3 border-t border-border pt-4">
        <p role="status" className={cn("text-sm font-medium text-income", !state.ok && "sr-only")}>
          {state.ok ? state.message : ""}
        </p>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <label className="inline-flex min-h-11 cursor-pointer items-center gap-2.5 text-sm font-medium text-foreground sm:min-h-0">
            <input
              type="checkbox"
              checked={keepOpen}
              onChange={(e) => setKeepOpen(e.target.checked)}
              className="size-4 shrink-0 accent-accent"
            />
            Keep open for another
          </label>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button variant="secondary" onClick={() => router.back()}>
              Cancel
            </Button>
            {canSubmit && (
              <Button type="submit" form={formId} pending={pending}>
                {pending ? "Saving…" : label}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

async function noop(state: FormState): Promise<FormState> {
  return state;
}
