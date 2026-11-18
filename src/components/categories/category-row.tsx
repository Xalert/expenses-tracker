"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import {
  changeCategoryKindAction,
  deleteCategoryAction,
  renameCategoryAction,
  setCategoryArchivedAction,
} from "@/app/(app)/categories/actions";
import { NEW_CATEGORY_VALUE } from "@/app/(app)/categories/form-input";
import { Button, FieldError, FormError, Input, Label, Select, SubmitButton } from "@/components/ui";
import { useExpandableRow } from "@/components/ui/expandable-row";
import type { RowShare } from "@/lib/category-split";
import { cn } from "@/lib/cn";
import { initialFormState, type FormState } from "@/lib/form";
import { formatMoney } from "@/lib/money";
import type { CategoryWithMonthUsage, CategoryWithUsage } from "@/server/categories";

export const MAX_CATEGORY_NAME = 40;

/**
 * A success message for the card's status line. `focusHeading`: the row left the list (removal, (un)archive), so focus
 * goes to the card's heading. `movedTo`: the row moved to the other kind's card, which announces it and focuses it.
 */
export type Announce = (
  message: string | undefined,
  opts?: { focusHeading?: boolean; movedTo?: { kind: "expense" | "income"; id: number } },
) => void;


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
 * The open row: the rename form; then (under a divider) the kind and archive controls; then the remove flow — an
 * unused category is removed after a confirm(); one with transactions needs a replacement of the same kind first (an
 * existing one or a new one named here). Focus goes into the name on open; Escape and Cancel close the row and
 * return focus to it (`ExpandableRow`); after a removal or (un)archiving the row leaves its list, so focus goes to the
 * section heading; after a kind change the other kind's card announces it and focuses the row there.
 */
export function CategoryPanel({
  category,
  others,
  announce,
}: {
  category: CategoryWithUsage;
  /** The other active categories of the same kind (possible replacements). */
  others: CategoryWithUsage[];
  announce: Announce;
}) {
  const row = useExpandableRow();
  // The row is about to move or disappear: no focus back to its button; the heading takes it.
  const leave = (message?: string) => {
    row.close({ restoreFocus: false });
    announce(message, { focusHeading: true });
  };
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
      <div className="mt-4 space-y-3 border-t border-border pt-3">
        <KindControls
          category={category}
          onChanged={(message) => {
            row.close({ restoreFocus: false });
            announce(message, { movedTo: { kind: OTHER_KIND[category.kind], id: category.id } });
          }}
        />
        <ArchiveControls category={category} onChanged={leave} />
      </div>
      <div className="mt-4 border-t border-border pt-3">
        <RemoveControls category={category} others={others} onRemoved={leave} />
      </div>
    </div>
  );
}

const OTHER_KIND = { expense: "income", income: "expense" } as const;

/**
 * Switch expense ↔ income: offered only while nothing uses the category; with transactions a line says why it stays
 * (the service refuses too, e.g. when an entry was added meanwhile — the error shows here).
 */
function KindControls({ category, onChanged }: { category: CategoryWithUsage; onChanged: (message?: string) => void }) {
  const [state, formAction] = useActionState(async (prev: FormState, formData: FormData) => {
    const next = await changeCategoryKindAction(category.id, prev, formData);
    if (next.ok) onChanged(next.message);
    return next;
  }, initialFormState);
  const target = OTHER_KIND[category.kind];
  const count = category.transactionCount;
  const error = state.fieldErrors?.kind ?? (state.ok ? undefined : state.message);
  const errorId = `category-${category.id}-kind-error`;

  if (count > 0 && !error) {
    return (
      <p className="text-sm text-muted-foreground">
        Used by {plural(count)}, so it stays an {category.kind} category: changing it would turn{" "}
        {count === 1 ? "that entry" : "those entries"} into {target}.
      </p>
    );
  }
  return (
    <form action={formAction} className="space-y-1.5">
      <input type="hidden" name="kind" value={target} />
      {count === 0 && (
        <SubmitButton variant="secondary" pendingLabel="Changing…" aria-describedby={error ? errorId : undefined}>
          Make it an {target} category
        </SubmitButton>
      )}
      {error && (
        <p id={errorId} role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </form>
  );
}

/** Archive (hide from the entry form, keep the history) or unarchive. No confirm: it is undone with one click. */
function ArchiveControls({ category, onChanged }: { category: CategoryWithUsage; onChanged: (message?: string) => void }) {
  const archived = category.archivedAt !== null;
  const [state, formAction] = useActionState(async () => {
    const next = await setCategoryArchivedAction(category.id, !archived);
    if (next.ok) onChanged(next.message);
    return next;
  }, initialFormState);
  const descriptionId = `category-${category.id}-archive-note`;
  return (
    <form action={formAction} className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <SubmitButton
        variant="secondary"
        pendingLabel={archived ? "Unarchiving…" : "Archiving…"}
        aria-describedby={descriptionId}
      >
        {archived ? "Unarchive" : "Archive"}
      </SubmitButton>
      <p id={descriptionId} className="min-w-0 flex-1 basis-48 text-sm text-muted-foreground">
        {archived
          ? "Archived: hidden from the entry form. Its entries stay in reports and history."
          : "Hides it from the entry form; its entries stay in reports and history."}
      </p>
      {!state.ok && state.message && (
        <p role="alert" className="w-full text-sm text-danger">
          {state.message}
        </p>
      )}
    </form>
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
 * Remove: unused → "Remove <name>" with a confirm(); used → a replacement first: an existing active category of the
 * same kind or a new one named here (the only choice when there is no other). A removal of an "unused" category that
 * gained transactions meanwhile is refused (CONFLICT); the page refreshes, this switches to the replacement form and
 * the error stays above it.
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

/**
 * Remove a category in use, moving its entries. With other active categories of its kind: a select of them plus "A
 * new category…", which shows a name field; without any: only the name field. Either way one server call creates (if
 * needed), moves and deletes in one DB transaction.
 */
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
  const hasSelect = others.length > 0;
  const v = state.values ?? {};
  // Controlled, so the choice (and the name field it shows) survives React's reset of the form after the action.
  const [choice, setChoice] = useState(hasSelect ? "" : NEW_CATEGORY_VALUE);
  const naming = choice === NEW_CATEGORY_VALUE;
  const selectRef = useRef<HTMLSelectElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const selectId = `move-category-${category.id}`;
  const nameId = `move-category-${category.id}-new-name`;
  const selectError = state.fieldErrors?.moveToCategoryId;
  const nameError = state.fieldErrors?.moveToNewCategoryName;
  const kind = category.kind;
  const archived = category.archivedAt !== null;

  // Back to the field at fault after a rejected removal (not on open: the name input has focus then), or on mount when
  // this replaced the plain Remove button because the category turned out to be in use.
  useEffect(() => {
    if (state === initialFormState && !focusOnMount) return;
    if (naming && (nameError || !hasSelect)) nameRef.current?.focus();
    else selectRef.current?.focus();
  }, [state, focusOnMount, naming, nameError, hasSelect]);

  const nameField = (
    <Input
      ref={nameRef}
      id={nameId}
      name="moveToNewCategoryName"
      required
      maxLength={MAX_CATEGORY_NAME}
      autoComplete="off"
      // Uncontrolled; keyed on the result so the echoed name is applied again after React resets the form.
      key={`name-${v.moveToNewCategoryName ?? ""}`}
      defaultValue={v.moveToNewCategoryName ?? ""}
      error={nameError}
    />
  );

  return (
    <form action={formAction} noValidate className="space-y-1.5">
      {hasSelect ? (
        <>
          <Label htmlFor={selectId}>Remove, moving its {plural(category.transactionCount)} to</Label>
          <Select
            ref={selectRef}
            id={selectId}
            name="moveToCategoryId"
            required
            value={choice}
            onChange={(e) => setChoice(e.target.value)}
            error={selectError}
          >
            <option value="" disabled>
              Choose a category…
            </option>
            {others.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
            <option value={NEW_CATEGORY_VALUE}>A new {kind} category…</option>
          </Select>
          <FieldError id={selectId}>{selectError}</FieldError>
          {naming && (
            <div className="space-y-1.5 pt-1">
              <Label htmlFor={nameId}>Name of the new {kind} category</Label>
              {nameField}
            </div>
          )}
        </>
      ) : (
        <>
          <Label htmlFor={nameId}>
            Remove, moving its {plural(category.transactionCount)} to a new {kind} category named
          </Label>
          {nameField}
        </>
      )}
      {naming && <FieldError id={nameId}>{nameError}</FieldError>}
      <SubmitButton variant="ghost" className={removeButtonClass} pendingLabel="Removing…">
        <span className="truncate">Remove {category.name}</span>
      </SubmitButton>
      {!archived && (
        <p className="text-sm text-muted-foreground">
          {hasSelect ? "" : `It is your only active ${kind} category. `}
          To keep its entries where they are, archive it instead.
        </p>
      )}
      <FormError message={state.message} />
    </form>
  );
}
