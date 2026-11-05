"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import {
  Card,
  CardBody,
  Field,
  FieldError,
  FormError,
  Input,
  Label,
  Select,
  SubmitButton,
  Textarea,
  buttonClasses,
} from "@/components/ui";
import { cn } from "@/lib/cn";
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
const KIND_ACTIVE: Record<EntryKind, string> = {
  expense: "bg-expense-soft text-expense ring-1 ring-expense/40",
  income: "bg-income-soft text-income ring-1 ring-income/40",
  transfer: "bg-transfer-soft text-transfer ring-1 ring-transfer/40",
};

// Stable small ids for action-state objects. The form is keyed by them so it remounts after every action
// result: React resets a form after its action runs, which would otherwise snap the controlled <select>s
// back to their initial options while their React state still holds the user's choice.
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

/** Amount input with the currency code shown inside, on the right. */
function AmountInput({
  id,
  currency,
  defaultValue,
  error,
}: {
  id: string;
  currency: string | undefined;
  defaultValue?: string;
  error?: string;
}) {
  return (
    <div className="relative">
      <Input
        id={id}
        name={id}
        inputMode="decimal"
        autoComplete="off"
        required
        placeholder={placeholderFor(currency)}
        defaultValue={defaultValue}
        error={error}
        aria-describedby={`${id}-currency`}
        className="pr-14 text-right tabular-nums"
      />
      <span
        id={`${id}-currency`}
        className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm font-medium text-muted-foreground"
      >
        {currency ?? ""}
      </span>
    </div>
  );
}

/**
 * The shared add / edit form with an Expense / Income / Transfer switch. Pass `transactionAction` to allow
 * expense/income and `transferAction` to allow transfers (the new page passes both; each edit page passes one).
 */
export function EntryForm({
  wallets,
  categories,
  initial,
  transactionAction,
  transferAction,
  returnTo,
  submitLabel,
  canTransfer,
}: {
  wallets: WalletOption[];
  categories: CategoryOption[];
  initial: EntryInitialValues;
  transactionAction?: Action;
  transferAction?: Action;
  returnTo: string;
  /** Overrides the "Add expense" / "Add transfer"… label, e.g. "Save changes" when editing. */
  submitLabel?: string;
  /** False when fewer than two wallets can take part in a transfer. */
  canTransfer: boolean;
}) {
  const kinds: EntryKind[] = [
    ...(transactionAction ? (["expense", "income"] as const) : []),
    ...(transferAction ? (["transfer"] as const) : []),
  ];

  const [txState, txFormAction] = useActionState(transactionAction ?? noop, initialFormState);
  const [trState, trFormAction] = useActionState(transferAction ?? noop, initialFormState);

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

  const isTransfer = kind === "transfer";
  const state = isTransfer ? trState : txState;
  const err = state.fieldErrors ?? {};
  const v = state.values ?? {};

  const byId = (id: string) => wallets.find((w) => String(w.id) === id);
  const wallet = byId(walletId);
  const from = byId(fromWalletId);
  const to = byId(toWalletId);
  const crossCurrency = Boolean(from && to && from.currency !== to.currency);
  const kindCategories = categories.filter((c) => c.kind === kind);

  const transferBlocked = isTransfer && !canTransfer;
  // Expense / income needs a category of that kind; without one the picker becomes an empty state.
  const noCategories = !isTransfer && kindCategories.length === 0;
  const label = submitLabel ?? `Add ${KIND_LABEL[kind].toLowerCase()}`;

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

  return (
    <Card>
      <CardBody>
        <form
          key={`${stateId(txState)}-${stateId(trState)}`}
          action={isTransfer ? trFormAction : txFormAction} className="space-y-5" noValidate>
          <input type="hidden" name="returnTo" value={returnTo} />
          <FormError message={state.message} />

          {kinds.length > 1 && (
            <fieldset>
              <legend className="sr-only">Type</legend>
              <div
                className={cn(
                  "grid gap-1 rounded-lg bg-surface-muted p-1",
                  kinds.length === 3 ? "grid-cols-3" : "grid-cols-2",
                )}
              >
                {kinds.map((k) => (
                  <label
                    key={k}
                    className={cn(
                      "flex h-9 cursor-pointer items-center justify-center rounded-md text-sm font-medium transition-colors",
                      "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring",
                      kind === k ? KIND_ACTIVE[k] : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <input
                      type="radio"
                      name="kind"
                      value={k}
                      checked={kind === k}
                      onChange={() => changeKind(k)}
                      className="sr-only"
                    />
                    {KIND_LABEL[k]}
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          {kinds.length === 1 && kind !== "transfer" && <input type="hidden" name="kind" value={kind} />}

          {transferBlocked ? (
            <div className="rounded-lg border border-dashed border-border-strong px-4 py-6 text-center text-sm text-muted-foreground">
              <p>A transfer needs at least two active wallets.</p>
              <Link href="/wallets/new" className="mt-2 inline-block font-medium text-accent hover:underline">
                Create another wallet
              </Link>
            </div>
          ) : isTransfer ? (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field id="fromWalletId" label="From wallet" error={err.fromWalletId}>
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
                </Field>
                <Field id="toWalletId" label="To wallet" error={err.toWalletId}>
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
                </Field>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field id="amount" label={crossCurrency ? "Amount sent" : "Amount"} error={err.amount}>
                  <AmountInput
                    id="amount"
                    currency={from?.currency}
                    defaultValue={v.amount ?? initial.amount}
                    error={err.amount}
                  />
                </Field>
                {crossCurrency && (
                  <Field
                    id="receivedAmount"
                    label="Amount received"
                    hint={`What arrives in ${to?.name}, in ${to?.currency}.`}
                    error={err.receivedAmount}
                  >
                    <AmountInput
                      id="receivedAmount"
                      currency={to?.currency}
                      defaultValue={v.receivedAmount ?? initial.receivedAmount}
                      error={err.receivedAmount}
                    />
                  </Field>
                )}
              </div>
            </>
          ) : (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field id="walletId" label="Wallet" error={err.walletId}>
                  <Select
                    id="walletId"
                    name="walletId"
                    value={walletId}
                    onChange={(e) => setWalletId(e.target.value)}
                    error={err.walletId}
                  >
                    {wallets.map((w) => (
                      <option key={w.id} value={w.id}>
                        {walletLabel(w)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <div className="space-y-1.5">
                  <div className="flex items-baseline justify-between gap-2">
                    {noCategories ? (
                      <p className="text-sm font-medium text-foreground">Category</p>
                    ) : (
                      <Label htmlFor="categoryId">Category</Label>
                    )}
                    {/* Plain navigation: whatever was typed in this form is not kept. */}
                    <Link href="/categories" className="text-xs font-medium text-accent hover:underline">
                      Manage categories
                    </Link>
                  </div>
                  {noCategories ? (
                    <div className="rounded-lg border border-dashed border-border-strong px-3 py-2.5 text-sm text-muted-foreground">
                      You have no {kind} categories.{" "}
                      <Link href="/categories" className="font-medium text-accent hover:underline">
                        Create one
                      </Link>{" "}
                      to record {kind === "expense" ? "an expense" : "income"}.
                    </div>
                  ) : (
                    <Select
                      id="categoryId"
                      name="categoryId"
                      value={categoryId}
                      onChange={(e) => setCategoryId(e.target.value)}
                      error={err.categoryId}
                    >
                      <option value="" disabled>
                        Choose a category
                      </option>
                      {kindCategories.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </Select>
                  )}
                  <FieldError id="categoryId">{err.categoryId}</FieldError>
                </div>
              </div>
              <Field id="amount" label="Amount" error={err.amount}>
                <AmountInput
                  id="amount"
                  currency={wallet?.currency}
                  defaultValue={v.amount ?? initial.amount}
                  error={err.amount}
                />
              </Field>
            </>
          )}

          {!transferBlocked && (
            <>
              <Field id="date" label="Date" error={err.date} className="sm:max-w-[calc(50%-0.5rem)]">
                <Input
                  id="date"
                  name="date"
                  type="date"
                  required
                  defaultValue={v.date ?? initial.date}
                  error={err.date}
                />
              </Field>
              <Field id="note" label="Note" hint="Optional." error={err.note}>
                <Textarea
                  id="note"
                  name="note"
                  maxLength={500}
                  rows={2}
                  defaultValue={v.note ?? initial.note}
                  error={err.note}
                />
              </Field>
            </>
          )}

          <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
            <Link href={returnTo} className={buttonClasses({ variant: "secondary" })}>
              Cancel
            </Link>
            {!transferBlocked && !noCategories && <SubmitButton pendingLabel="Saving…">{label}</SubmitButton>}
          </div>
        </form>
      </CardBody>
    </Card>
  );
}

async function noop(state: FormState): Promise<FormState> {
  return state;
}
