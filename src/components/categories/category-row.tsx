"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { deleteCategoryAction, renameCategoryAction } from "@/app/(app)/categories/actions";
import { Button, FieldError, FormError, Input, Label, Select, SubmitButton } from "@/components/ui";
import { useExpandableRow } from "@/components/ui/expandable-row";
import type { RowShare } from "@/lib/category-split";
import { cn } from "@/lib/cn";
import { initialFormState, type FormState } from "@/lib/form";
import { formatMoney } from "@/lib/money";
import type { CategoryWithMonthUsage, CategoryWithUsage } from "@/server/categories";

export const MAX_CATEGORY_NAME = 40;

export type Announce = (message: string | undefined, opts?: { focusHeading?: boolean }) => void;


const plural = (n: number) => (n === 1 ? "1 transaction" : `${n} transactions`);

/** The danger text button of the open row ("Remove Food"): `--danger` text, no fill, 44px tall. */
const removeButtonClass = "-ml-3 max-w-full min-w-0 text-danger! hover:bg-danger-soft!";

/**
 * The row's content inside its `ExpandableRow` button (phrasing content only): swatch, **name** · "N this month · M in
 * all", the share bar (expense rows) and the month's amount in `currency` ("—" when 0). Without a currency (no wallets)
 * the amount and the bar are left out.
 */
export function CategorySummary({
  category,
  currency,
  share,
}: {
  category: CategoryWithMonthUsage;
  currency: string | null;
  share: RowShare;
}) {
  const income = category.kind === "income";
  const amount = category.monthAmountMinor;
  return (
    <>
      <span
        aria-hidden="true"
        className={cn(
          "size-2.5 shrink-0 rounded-full",
          income ? "bg-income" : share && share.fraction > 0 ? share.swatchClass : "border border-border-strong",
        )}
      />
      <span className="min-w-0 flex-1 sm:truncate">
        <span className="block truncate font-bold text-foreground sm:inline">{category.name}</span>
        <span className="block truncate text-xs text-muted-foreground sm:inline sm:text-[13px]">
          <span className="hidden sm:inline"> · </span>
          {category.monthCount} this month · {category.transactionCount} in all
        </span>
      </span>
      {currency && share && (
        <span aria-hidden="true" className="block h-1.5 w-12 shrink-0 overflow-hidden rounded-full bg-surface-muted sm:w-20">
          <span className={cn("block h-full rounded-full", share.swatchClass)} style={{ width: `${share.fraction * 100}%` }} />
        </span>
      )}
      {currency && (
        <span
          className={cn(
            "min-w-14 shrink-0 text-right font-bold tabular-nums",
            income && amount > 0 ? "text-income" : amount > 0 ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {amount > 0 ? (
            formatMoney(amount, currency)
          ) : (
            <>
              <span aria-hidden="true">—</span>
              <span className="sr-only">nothing in {currency}</span>
            </>
          )}
          {share && amount > 0 && <span className="sr-only">, {share.percentLabel} of the month&apos;s spending</span>}
        </span>
      )}
    </>
  );
}

/**
 * The open row: the rename form, then (under a divider) the remove flow — an unused category is removed after a
 * confirm(); one with transactions needs a replacement of the same kind first. Focus goes into the name on open;
 * Escape and Cancel close the row and return focus to it (`ExpandableRow`); after a removal focus goes to the
 * section heading.
 */
export function CategoryPanel({
  category,
  others,
  announce,
}: {
  category: CategoryWithUsage;
  /** The other categories of the same kind (possible replacements). */
  others: CategoryWithUsage[];
  announce: Announce;
}) {
  const row = useExpandableRow();
  return (
    <div className="px-4 pt-1 pb-4 sm:px-[18px]">
      <RenameForm
        category={category}
        onCancel={() => row.close()}
        onRenamed={(message) => {
          row.close();
          announce(message);
        }}
      />
      <div className="mt-4 border-t border-border pt-3">
        <RemoveControls
          category={category}
          others={others}
          onRemoved={(message) => {
            // The row is about to disappear: no focus back to its button; the heading takes it.
            row.close({ restoreFocus: false });
            announce(message, { focusHeading: true });
          }}
        />
      </div>
    </div>
  );
}

function RenameForm({
  category,
  onCancel,
  onRenamed,
}: {
  category: CategoryWithUsage;
  onCancel: () => void;
  onRenamed: (message?: string) => void;
}) {
  const [state, formAction] = useActionState(async (prev: FormState, formData: FormData) => {
    const next = await renameCategoryAction(category.id, prev, formData);
    if (next.ok) onRenamed(next.message);
    return next;
  }, initialFormState);
  const inputRef = useRef<HTMLInputElement>(null);
  const id = `rename-category-${category.id}`;
  const error = state.fieldErrors?.name;

  // Focus (and select) the name on open; back to the input after a rejected name.
  useEffect(() => {
    inputRef.current?.focus();
    if (!state.fieldErrors?.name) inputRef.current?.select();
  }, [state]);

  return (
    <form action={formAction} noValidate className="space-y-1.5">
      <Label htmlFor={id}>New name for “{category.name}”</Label>
      <div className="flex flex-wrap gap-2">
        <Input
          ref={inputRef}
          id={id}
          name="name"
          required
          maxLength={MAX_CATEGORY_NAME}
          autoComplete="off"
          defaultValue={state.values?.name ?? category.name}
          error={error}
          className="min-w-0 flex-1 basis-40 not-aria-[invalid=true]:border-accent"
        />
        <div className="flex gap-2">
          <SubmitButton pendingLabel="Renaming…">Rename</SubmitButton>
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
      <FieldError id={id}>{error}</FieldError>
      <FormError message={state.message} />
    </form>
  );
}

/**
 * Remove: unused → "Remove <name>" with a confirm(); used → the replacement select first; the only category of its
 * kind with transactions → an explanation. A removal of an "unused" category that gained transactions meanwhile is
 * refused (CONFLICT); the page refreshes, this switches to the replacement select and the error stays above it.
 */
function RemoveControls({
  category,
  others,
  onRemoved,
}: {
  category: CategoryWithUsage;
  others: CategoryWithUsage[];
  onRemoved: (message?: string) => void;
}) {
  const [error, setError] = useState<string | undefined>();
  const errorId = `category-${category.id}-remove-error`;
  const count = category.transactionCount;

  return (
    <div className="space-y-2">
      {error && (
        <p id={errorId} role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {count === 0 ? (
        <RemoveUnusedButton
          category={category}
          errorId={error ? errorId : undefined}
          onError={setError}
          onRemoved={onRemoved}
        />
      ) : others.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          “{category.name}” has {plural(count)} and is your only {category.kind} category, so there is nowhere to move{" "}
          {count === 1 ? "it" : "them"}. Add another {category.kind} category below first, then remove this one.
        </p>
      ) : (
        <MoveAndRemoveForm
          category={category}
          others={others}
          focusOnMount={Boolean(error)}
          onRemoved={onRemoved}
          onStart={() => setError(undefined)}
        />
      )}
    </div>
  );
}

/** Remove an unused category after a confirm(). If it turns out to be in use, the error shows above. */
function RemoveUnusedButton({
  category,
  errorId,
  onError,
  onRemoved,
}: {
  category: CategoryWithUsage;
  errorId?: string;
  onError: (message: string | undefined) => void;
  onRemoved: (message?: string) => void;
}) {
  const [, formAction] = useActionState(async (prev: FormState, formData: FormData) => {
    const next = await deleteCategoryAction(category.id, prev, formData);
    if (next.ok) onRemoved(next.message);
    else onError(next.message ?? Object.values(next.fieldErrors ?? {})[0]);
    return next;
  }, initialFormState);

  return (
    <form
      action={formAction}
      onSubmit={(e) => {
        if (!window.confirm(`Remove the category “${category.name}”? It has no transactions.`)) e.preventDefault();
        else onError(undefined);
      }}
    >
      <SubmitButton
        variant="ghost"
        className={removeButtonClass}
        pendingLabel="Removing…"
        aria-describedby={errorId}
      >
        <span className="truncate">Remove {category.name}</span>
      </SubmitButton>
    </form>
  );
}

function MoveAndRemoveForm({
  category,
  others,
  focusOnMount,
  onRemoved,
  onStart,
}: {
  category: CategoryWithUsage;
  others: CategoryWithUsage[];
  focusOnMount: boolean;
  onRemoved: (message?: string) => void;
  onStart: () => void;
}) {
  const [state, formAction] = useActionState(async (prev: FormState, formData: FormData) => {
    onStart();
    const next = await deleteCategoryAction(category.id, prev, formData);
    if (next.ok) onRemoved(next.message);
    return next;
  }, initialFormState);
  const selectRef = useRef<HTMLSelectElement>(null);
  const id = `move-category-${category.id}`;
  const error = state.fieldErrors?.moveToCategoryId;
  const v = state.values ?? {};

  // Back to the select after a rejected removal (not on open: the name input has focus then), or on mount when this
  // replaced the plain Remove button because the category turned out to be in use.
  useEffect(() => {
    if (state !== initialFormState || focusOnMount) selectRef.current?.focus();
  }, [state, focusOnMount]);

  return (
    <form action={formAction} noValidate className="space-y-1.5">
      <Label htmlFor={id}>Remove, moving its {plural(category.transactionCount)} to</Label>
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1 basis-48">
          <Select
            ref={selectRef}
            id={id}
            name="moveToCategoryId"
            required
            // Uncontrolled: React resets the form after the action and only defaultValue survives, applied on mount
            // only — hence the key on the echoed value.
            key={v.moveToCategoryId ?? "initial"}
            defaultValue={v.moveToCategoryId ?? ""}
            error={error}
          >
            <option value="" disabled>
              Choose a category…
            </option>
            {others.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </Select>
        </div>
        <SubmitButton variant="ghost" className={removeButtonClass} pendingLabel="Removing…">
          <span className="truncate">Remove {category.name}</span>
        </SubmitButton>
      </div>
      <FieldError id={id}>{error}</FieldError>
      <FormError message={state.message} />
    </form>
  );
}
