"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { createCategoryAction } from "@/app/(app)/categories/actions";
import { Card, FieldError, Input, Label, SubmitButton } from "@/components/ui";
import { initialFormState, type FormState } from "@/lib/form";
import type { CategoryWithUsage } from "@/server/categories";
import { CategoryRow } from "./category-row";

export const MAX_CATEGORY_NAME = 40;

const TITLE = { expense: "Expense", income: "Income" } as const;

/**
 * One kind's card on /categories: heading, a live status line (announces adds / renames / removals), the list
 * of categories with rename + remove, and an "add category" form whose kind is decided by the section.
 */
export function CategorySection({
  kind,
  categories,
}: {
  kind: "expense" | "income";
  categories: CategoryWithUsage[];
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [status, setStatus] = useState("");
  const headingId = `${kind}-categories-heading`;

  /** Show + announce a success message; after a removal the row is gone, so focus moves to the heading. */
  function announce(message: string | undefined, opts: { focusHeading?: boolean } = {}) {
    setStatus(message ?? "");
    if (opts.focusHeading) headingRef.current?.focus();
  }

  const count = categories.length;
  return (
    <Card aria-labelledby={headingId} role="region">
      <div className="border-b border-border px-4 py-3 sm:px-5">
        <h2
          id={headingId}
          ref={headingRef}
          tabIndex={-1}
          className="rounded text-base font-semibold text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {TITLE[kind]}
        </h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {count} {count === 1 ? "category" : "categories"}
        </p>
        <p role="status" className="mt-1 text-sm text-income empty:hidden">
          {status}
        </p>
      </div>

      {count === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-muted-foreground sm:px-5">
          No {kind} categories yet. Add one below to start recording {kind === "expense" ? "expenses" : "income"}.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {categories.map((c) => (
            <CategoryRow
              key={c.id}
              category={c}
              others={categories.filter((o) => o.id !== c.id)}
              announce={announce}
            />
          ))}
        </ul>
      )}

      <AddCategoryForm kind={kind} onAdded={announce} />
    </Card>
  );
}

function AddCategoryForm({ kind, onAdded }: { kind: "expense" | "income"; onAdded: (message?: string) => void }) {
  const [state, formAction] = useActionState(async (prev: FormState, formData: FormData) => {
    const next = await createCategoryAction(kind, prev, formData);
    onAdded(next.ok ? next.message : undefined);
    return next;
  }, initialFormState);
  const inputRef = useRef<HTMLInputElement>(null);
  const id = `new-${kind}-category`;
  const error = state.fieldErrors?.name;

  // Move focus to the input when the server rejected the name, so the error is read out with it.
  useEffect(() => {
    if (state.fieldErrors?.name) inputRef.current?.focus();
  }, [state]);

  return (
    <form action={formAction} noValidate className="space-y-1.5 border-t border-border px-4 py-4 sm:px-5">
      <Label htmlFor={id}>Add {kind} category</Label>
      <div className="flex gap-2">
        <Input
          ref={inputRef}
          id={id}
          name="name"
          required
          maxLength={MAX_CATEGORY_NAME}
          autoComplete="off"
          placeholder={kind === "expense" ? "e.g. Eating out" : "e.g. Freelance"}
          defaultValue={state.values?.name}
          error={error}
          className="min-w-0 flex-1"
        />
        <SubmitButton pendingLabel="Adding…" className="shrink-0">
          Add
        </SubmitButton>
      </div>
      <FieldError id={id}>{error}</FieldError>
      {state.message && !state.ok && (
        <p role="alert" className="text-sm text-danger">
          {state.message}
        </p>
      )}
    </form>
  );
}
