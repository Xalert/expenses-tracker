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
import { BigAmount } from "@/components/ui/big-amount";
import { CalendarIcon } from "@/components/ui/picker-icons";
import { cn } from "@/lib/cn";
import { addDays, formatDate } from "@/lib/dates";
import { initialFormState, type FormState } from "@/lib/form";

export type EntryKind = "expense" | "income" | "transfer";

export type WalletOption = {
  id: number;
  name: string;
  currency: string;
  archived: boolean;
  /** The wallet's group name; set only when the user has two or more groups (the pickers then group by it). */
  groupName?: string;
};
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

function walletLabel(w: WalletOption) {
  return `${w.name} (${w.currency})${w.archived ? " — archived" : ""}`;
}

/**
 * The <option>s of a wallet <select>: one <optgroup> per group (in the order the wallets come) when the wallets carry
 * a group name, else a flat list. `disabledId` greys one wallet out (a transfer's other side).
 */
function WalletSelectOptions({ wallets, disabledId }: { wallets: WalletOption[]; disabledId?: string }) {
  const option = (w: WalletOption) => (
    <option key={w.id} value={w.id} disabled={disabledId !== undefined && String(w.id) === disabledId}>
      {walletLabel(w)}
    </option>
  );
  if (!wallets.some((w) => w.groupName)) return <>{wallets.map(option)}</>;
  const groups = new Map<string, WalletOption[]>();
  for (const w of wallets) groups.set(w.groupName ?? "", [...(groups.get(w.groupName ?? "") ?? []), w]);
  return (
    <>
      {[...groups].map(([name, list]) => (
        <optgroup key={name} label={name}>
          {list.map(option)}
        </optgroup>
      ))}
    </>
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
 * `variant="inline"` is the in-place editor of a transactions-list row: no card, a compact amount, the footer outside
 * the form (`footerStart` holds the Delete form and the "Open as page" link), Cancel calls `onCancel`, and a result
 * with `ok` calls `onSaved(message)` (the inline update actions return form state instead of redirecting). Its ids
 * carry `idPrefix` so they cannot clash with the Add dialog opened over the list; the posted names are unchanged.
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
  idPrefix = "",
  onCancel,
  onSaved,
  footerStart,
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
  variant?: "page" | "dialog" | "inline";
  /** Prefix for every element id (not for the field names), e.g. "edit-42-". */
  idPrefix?: string;
  /** Inline: the Cancel button. */
  onCancel?: () => void;
  /** Inline: called with the action's message after a successful save. */
  onSaved?: (message?: string) => void;
  /** Inline: shown at the start of the footer (outside the form, so it may hold its own <form>). */
  footerStart?: ReactNode;
}) {
  const router = useRouter();
  const formId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const isDialog = variant === "dialog";
  const isInline = variant === "inline";
  const pid = (name: string) => `${idPrefix}${name}`;

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
      if (isInline) {
        onSaved?.(state.message);
      } else if (keepOpen) {
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
  }, [state, keepOpen, router, isInline, onSaved]);

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
      className={isInline ? "space-y-4" : "space-y-6"}
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
              <label htmlFor={pid("fromWalletId")} className={sectionLabel}>
                From
              </label>
              <Select
                id={pid("fromWalletId")}
                name="fromWalletId"
                value={fromWalletId}
                onChange={(e) => setFromWalletId(e.target.value)}
                error={err.fromWalletId}
              >
                <WalletSelectOptions wallets={wallets} />
              </Select>
              <FieldError id={pid("fromWalletId")}>{err.fromWalletId}</FieldError>
            </div>
            <span aria-hidden="true" className="hidden h-11 items-center text-lg text-muted-foreground sm:flex">
              →
            </span>
            <div className="space-y-1.5">
              <label htmlFor={pid("toWalletId")} className={sectionLabel}>
                To
              </label>
              <Select
                id={pid("toWalletId")}
                name="toWalletId"
                value={toWalletId}
                onChange={(e) => setToWalletId(e.target.value)}
                error={err.toWalletId}
              >
                {!toWalletId && <option value="">Choose a wallet</option>}
                <WalletSelectOptions wallets={wallets} disabledId={fromWalletId} />
              </Select>
              <FieldError id={pid("toWalletId")}>{err.toWalletId}</FieldError>
            </div>
          </div>
          <div className="space-y-2">
            <div className={cn("grid gap-4", crossCurrency && "sm:grid-cols-2")}>
              <BigAmount
                id={pid("amount")}
                name="amount"
                compact={isInline}
                label="Sent"
                currency={from?.currency}
                currencyText={from?.currency ?? ""}
                defaultValue={v.amount ?? initial.amount}
                error={err.amount}
                autoFocus={isDialog}
              />
              {crossCurrency && (
                <BigAmount
                  id={pid("receivedAmount")}
                  name="receivedAmount"
                  compact={isInline}
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
            id={pid("amount")}
            name="amount"
            compact={isInline}
            label="Amount"
            currency={wallet?.currency}
            currencyText={wallet ? `${wallet.currency} · from ${wallet.name}` : ""}
            defaultValue={v.amount ?? initial.amount}
            error={err.amount}
            autoFocus={isDialog}
          />

          <div className="space-y-2">
            <p id={pid("categoryId-label")} className={sectionLabel}>
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
                  id={pid("categoryId")}
                  name="categoryId"
                  aria-labelledby={pid("categoryId-label")}
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
            <p id={pid("walletId-label")} className={sectionLabel}>
              Wallet
            </p>
            <PillPicker
              id={pid("walletId")}
              name="walletId"
              aria-labelledby={pid("walletId-label")}
              required
              options={wallets.map((w) => ({
                value: String(w.id),
                label: (
                  <>
                    {w.archived ? `${w.name} (archived)` : w.name}
                    {w.groupName && <span className="font-normal text-muted-foreground"> · {w.groupName}</span>}
                  </>
                ),
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
            <p id={pid("date-label")} className={sectionLabel}>
              Date
            </p>
            <div role="group" aria-labelledby={pid("date-label")} className="flex flex-wrap items-center gap-2">
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
                id={pid("date")}
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
            <FieldError id={pid("date")}>{err.date}</FieldError>
          </div>

          <div className="space-y-1.5">
            <label htmlFor={pid("note")} className="sr-only">
              Note
            </label>
            <Input
              id={pid("note")}
              name="note"
              maxLength={500}
              placeholder="Note (optional)"
              autoComplete="off"
              defaultValue={v.note ?? initial.note}
              error={err.note}
            />
            <FieldError id={pid("note")}>{err.note}</FieldError>
          </div>
        </>
      )}

      {variant === "page" && (
        <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
          <Link href={returnTo} className={buttonClasses({ variant: "secondary" })}>
            Cancel
          </Link>
          {canSubmit && <SubmitButton pendingLabel="Saving…">{label}</SubmitButton>}
        </div>
      )}
    </form>
  );

  if (variant === "page") {
    return (
      <Card>
        <CardBody>{form}</CardBody>
      </Card>
    );
  }

  if (isInline) {
    // Like the dialog, the footer sits outside the keyed <form>: it holds the Delete form (forms cannot nest).
    return (
      <div className="space-y-4">
        {form}
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-border pt-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">{footerStart}</div>
          <div className="ml-auto flex gap-2">
            <Button variant="secondary" onClick={onCancel}>
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
