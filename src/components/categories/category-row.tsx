"use client";

import Link from "next/link";
import { useActionState, useEffect, useRef, useState } from "react";
import { deleteCategoryAction, renameCategoryAction } from "@/app/(app)/categories/actions";
import { Button, FieldError, FormError, Input, Label, Select, SubmitButton } from "@/components/ui";
import { initialFormState, type FormState } from "@/lib/form";
import type { CategoryWithUsage } from "@/server/categories";
import { MAX_CATEGORY_NAME } from "./category-section";

type Announce = (message: string | undefined, opts?: { focusHeading?: boolean }) => void;
type Mode = "view" | "rename" | "move";

const plural = (n: number) => (n === 1 ? "1 transaction" : `${n} transactions`);

/**
 * One category: name + transaction count, with Rename (inline form) and Remove. An unused category is removed
 * after a confirm(); one with transactions opens an inline panel to pick the replacement first.
 * Focus goes into each form when it opens and back to the button that opened it when it closes.
 */
export function CategoryRow({
  category,
  others,
  announce,
}: {
  category: CategoryWithUsage;
  /** The other categories of the same kind (possible replacements). */
  others: CategoryWithUsage[];
  announce: Announce;
}) {
  const [mode, setMode] = useState<Mode>("view");
  const [removeError, setRemoveError] = useState<string | undefined>();
  const renameButton = useRef<HTMLButtonElement>(null);
  const removeButton = useRef<HTMLButtonElement>(null);
  const restoreFocusTo = useRef<"rename" | "remove" | null>(null);

  useEffect(() => {
    if (mode !== "view" || !restoreFocusTo.current) return;
    (restoreFocusTo.current === "rename" ? renameButton : removeButton).current?.focus();
    restoreFocusTo.current = null;
  }, [mode]);

  function close(from: "rename" | "remove") {
    restoreFocusTo.current = from;
    setMode("view");
  }

  const used = category.transactionCount > 0;
  const nameId = `category-${category.id}-name`;
  const removeErrorId = `category-${category.id}-remove-error`;

  function open(next: Mode) {
    setRemoveError(undefined);
    setMode(next);
  }

  return (
    <li className="px-4 py-3 sm:px-5">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p id={nameId} className="truncate text-sm font-medium text-foreground">
            {category.name}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {used ? (
              <Link
                href={`/transactions?category=${category.id}`}
                className="rounded hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring"
              >
                {plural(category.transactionCount)}
              </Link>
            ) : (
              "No transactions"
            )}
          </p>
        </div>
        {mode === "view" && (
          <div className="flex shrink-0 items-center gap-1">
            <Button
              ref={renameButton}
              variant="ghost"
              size="sm"
              aria-label={`Rename ${category.name}`}
              onClick={() => open("rename")}
            >
              Rename
            </Button>
            {used ? (
              <Button
                ref={removeButton}
                variant="ghost"
                size="sm"
                className="hover:text-danger!"
                aria-label={`Remove ${category.name}`}
                onClick={() => open("move")}
              >
                Remove
              </Button>
            ) : (
              <RemoveUnusedButton
                category={category}
                buttonRef={removeButton}
                errorId={removeError ? removeErrorId : undefined}
                onError={setRemoveError}
                announce={announce}
              />
            )}
          </div>
        )}
      </div>

      {removeError && mode === "view" && (
        <p id={removeErrorId} role="alert" className="mt-2 text-sm text-danger">
          {removeError}
        </p>
      )}
      {mode === "rename" && (
        <RenameForm category={category} onDone={() => close("rename")} announce={announce} />
      )}
      {mode === "move" && (
        <MoveAndRemovePanel category={category} others={others} onCancel={() => close("remove")} announce={announce} />
      )}
    </li>
  );
}

function RenameForm({
  category,
  onDone,
  announce,
}: {
  category: CategoryWithUsage;
  onDone: () => void;
  announce: Announce;
}) {
  const [state, formAction] = useActionState(async (prev: FormState, formData: FormData) => {
    const next = await renameCategoryAction(category.id, prev, formData);
    if (next.ok) {
      announce(next.message);
      onDone();
    }
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
    <form
      action={formAction}
      noValidate
      className="mt-3 space-y-1.5"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onDone();
        }
      }}
    >
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
          className="min-w-0 flex-1 basis-40"
        />
        <div className="flex gap-2">
          <SubmitButton pendingLabel="Saving…">Save</SubmitButton>
          <Button variant="secondary" onClick={onDone}>
            Cancel
          </Button>
        </div>
      </div>
      <FieldError id={id}>{error}</FieldError>
      <FormError message={state.message} />
    </form>
  );
}

/** Remove an unused category after a confirm(). If it turns out to be in use, the row shows the error. */
function RemoveUnusedButton({
  category,
  buttonRef,
  errorId,
  onError,
  announce,
}: {
  category: CategoryWithUsage;
  buttonRef: React.RefObject<HTMLButtonElement | null>;
  errorId?: string;
  onError: (message: string | undefined) => void;
  announce: Announce;
}) {
  const [, formAction] = useActionState(async (prev: FormState, formData: FormData) => {
    const next = await deleteCategoryAction(category.id, prev, formData);
    if (next.ok) announce(next.message, { focusHeading: true });
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
        ref={buttonRef}
        variant="ghost"
        size="sm"
        className="hover:text-danger!"
        pendingLabel="Removing…"
        aria-label={`Remove ${category.name}`}
        aria-describedby={errorId}
      >
        Remove
      </SubmitButton>
    </form>
  );
}

function MoveAndRemovePanel({
  category,
  others,
  onCancel,
  announce,
}: {
  category: CategoryWithUsage;
  others: CategoryWithUsage[];
  onCancel: () => void;
  announce: Announce;
}) {
  const [state, formAction] = useActionState(async (prev: FormState, formData: FormData) => {
    const next = await deleteCategoryAction(category.id, prev, formData);
    if (next.ok) announce(next.message, { focusHeading: true });
    return next;
  }, initialFormState);
  const selectRef = useRef<HTMLSelectElement>(null);
  const introRef = useRef<HTMLParagraphElement>(null);
  const id = `move-category-${category.id}`;
  const introId = `${id}-intro`;
  const error = state.fieldErrors?.moveToCategoryId;
  const v = state.values ?? {};
  const kindNoun = category.kind;
  const count = category.transactionCount;

  useEffect(() => {
    (selectRef.current ?? introRef.current)?.focus();
  }, [state]);

  const panelClasses = "mt-3 space-y-3 rounded-lg border border-border bg-surface-muted/60 p-3";
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  };

  if (others.length === 0) {
    return (
      <div role="group" aria-labelledby={introId} className={panelClasses} onKeyDown={onKeyDown}>
        <p id={introId} ref={introRef} tabIndex={-1} className="text-sm text-foreground outline-none">
          “{category.name}” has {plural(count)} and is your only {kindNoun} category, so there is nowhere to move
          {count === 1 ? "it" : "them"}. Add another {kindNoun} category below first, then remove this one.
        </p>
        <Button variant="secondary" size="sm" onClick={onCancel}>
          Close
        </Button>
      </div>
    );
  }

  return (
    <form action={formAction} noValidate className={panelClasses} onKeyDown={onKeyDown} aria-labelledby={introId}>
      <p id={introId} ref={introRef} tabIndex={-1} className="text-sm text-foreground outline-none">
        Remove “{category.name}”? Its {plural(count)} will move to the {kindNoun} category you choose.
      </p>
      <div className="space-y-1.5">
        <Label htmlFor={id}>
          Move {plural(count)} to
        </Label>
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
        <FieldError id={id}>{error}</FieldError>
      </div>
      <FormError message={state.message} />
      <div className="flex flex-wrap gap-2">
        <SubmitButton variant="danger" size="sm" pendingLabel="Removing…">
          Move and remove
        </SubmitButton>
        <Button variant="secondary" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
