"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { createCategoryAction } from "@/app/(app)/categories/actions";
import { FieldError, Input, SubmitButton } from "@/components/ui";
import { ExpandableList, ExpandableRow } from "@/components/ui/expandable-row";
import { rowShare, type SplitSegment } from "@/lib/category-split";
import { initialFormState, type FormState } from "@/lib/form";
import type { CategoryWithMonthUsage } from "@/server/categories";
import { CategoryPanel, CategorySummary, MAX_CATEGORY_NAME, type Announce } from "./category-row";

const TITLE = { expense: "Expense", income: "Income" } as const;

/**
 * One kind's list on /categories: heading ("Expense · 5 categories"), a live status line (announces adds, renames
 * and removals), the categories as rows that open in place to rename / remove, and the dashed "add" row.
 * `segments` are the spending split's (expense only); `currency` is the one the month amounts are in.
 */
export function CategorySection({
  kind,
  categories,
  currency,
  segments,
}: {
  kind: "expense" | "income";
  categories: CategoryWithMonthUsage[];
  currency: string | null;
  segments: SplitSegment[];
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [status, setStatus] = useState("");
  const headingId = `${kind}-categories-heading`;
  const byId = new Map(segments.map((s) => [s.id, s]));

  /** Show + announce a success message; after a removal the row is gone, so focus moves to the heading. */
  const announce: Announce = (message, opts = {}) => {
    setStatus(message ?? "");
    if (opts.focusHeading) headingRef.current?.focus();
  };

  const count = categories.length;
  return (
    <section aria-labelledby={headingId} className="min-w-0 rounded-[20px] border border-border bg-surface">
      <div className="px-4 pt-4 pb-3 sm:px-[18px]">
        <h2
          id={headingId}
          ref={headingRef}
          tabIndex={-1}
          className="rounded text-base font-bold text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {TITLE[kind]}{" "}
          <span className="font-semibold text-muted-foreground">
            · {count} {count === 1 ? "category" : "categories"}
          </span>
        </h2>
        <p role="status" className="mt-1 text-sm text-income empty:hidden">
          {status}
        </p>
      </div>

      {count === 0 ? (
        <p className="border-t border-surface-muted px-4 py-6 text-center text-sm text-muted-foreground sm:px-[18px]">
          No {kind} categories yet. Add one below to start recording {kind === "expense" ? "expenses" : "income"}.
        </p>
      ) : (
        <ExpandableList>
          <ul className="divide-y divide-surface-muted border-t border-surface-muted">
            {categories.map((c) => (
              <ExpandableRow
                key={c.id}
                id={String(c.id)}
                buttonClassName="min-h-11 px-4 py-3 text-sm sm:px-[18px]"
                summary={
                  <CategorySummary
                    key="summary"
                    category={c}
                    currency={currency}
                    share={kind === "expense" ? rowShare(byId.get(c.id)) : null}
                  />
                }
                panelLabel={`Rename or remove ${c.name}`}
                panel={
                  <CategoryPanel
                    key="panel"
                    category={c}
                    others={categories.filter((o) => o.id !== c.id)}
                    announce={announce}
                  />
                }
              />
            ))}
          </ul>
        </ExpandableList>
      )}

      <AddCategoryForm kind={kind} onAdded={announce} />
    </section>
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
    <form action={formAction} noValidate className="space-y-1.5 border-t border-surface-muted px-4 py-3.5 sm:px-[18px]">
      <label htmlFor={id} className="sr-only">
        New {kind} category
      </label>
      <div className="flex gap-2">
        <Input
          ref={inputRef}
          id={id}
          name="name"
          required
          maxLength={MAX_CATEGORY_NAME}
          autoComplete="off"
          placeholder={`+ New ${kind} category`}
          defaultValue={state.values?.name}
          error={error}
          className="min-w-0 flex-1 border-dashed"
        />
        <SubmitButton variant="secondary" pendingLabel="Adding…" className="shrink-0">
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
