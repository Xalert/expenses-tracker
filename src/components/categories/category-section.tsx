"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { createCategoryAction } from "@/app/(app)/categories/actions";
import { FieldError, Input, SubmitButton } from "@/components/ui";
import { ExpandableList, ExpandableRow } from "@/components/ui/expandable-row";
import { rowShare, type SplitSegment } from "@/lib/category-split";
import { initialFormState, type FormState } from "@/lib/form";
import type { CategoryWithMonthUsage } from "@/server/categories";
import { CATEGORY_MOVED_EVENT, announceCategoryMoved, isMovedInto, movedRowButton } from "./category-move";
import { CategoryPanel, CategorySummary, MAX_CATEGORY_NAME, type Announce } from "./category-row";

const TITLE = { expense: "Expense", income: "Income" } as const;

/**
 * One kind's list on /categories: heading ("Expense · 5 categories", active ones), a live status line (announces
 * adds, renames, kind changes, (un)archiving and removals), the active categories as rows that open in place, the
 * dashed "add" row, then — when there are any — the archived ones under a muted "Archived · N" heading.
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
  const sectionRef = useRef<HTMLElement>(null);
  const [status, setStatus] = useState("");
  const headingId = `${kind}-categories-heading`;
  const byId = new Map(segments.map((s) => [s.id, s]));
  /** A category that moved into this card (kind change) whose row should take the focus once it is here. */
  const pendingFocus = useRef<number | null>(null);

  /**
   * Show + announce a success message; after a removal the row is gone, so focus moves to the heading. After a kind
   * change (`movedTo`) the other card announces it and takes the focus (its heading at once, then the moved row).
   */
  const announce: Announce = (message, opts = {}) => {
    if (opts.movedTo) {
      setStatus("");
      announceCategoryMoved({ ...opts.movedTo, message: message ?? "" });
      return;
    }
    setStatus(message ?? "");
    if (opts.focusHeading) headingRef.current?.focus();
  };

  useEffect(() => {
    function onMoved(e: Event) {
      const detail = (e as CustomEvent<unknown>).detail;
      if (!isMovedInto(detail, kind)) return;
      setStatus(detail.message);
      pendingFocus.current = detail.id;
      headingRef.current?.focus();
      // The refreshed list may already be here, or arrive with the next render (the effect below).
      window.setTimeout(() => focusPendingRow(sectionRef.current, pendingFocus), 0);
    }
    window.addEventListener(CATEGORY_MOVED_EVENT, onMoved);
    return () => window.removeEventListener(CATEGORY_MOVED_EVENT, onMoved);
  }, [kind]);

  // Each new list from the server: focus the moved row if it has arrived.
  useEffect(() => focusPendingRow(sectionRef.current, pendingFocus), [categories]);

  const active = categories.filter((c) => c.archivedAt === null);
  const archived = categories.filter((c) => c.archivedAt !== null);
  const count = active.length;
  const archivedHeadingId = `${kind}-archived-categories-heading`;

  const rowFor = (c: CategoryWithMonthUsage) => (
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
      panelLabel={`Edit ${c.name}`}
      panel={
        <CategoryPanel key="panel" category={c} others={active.filter((o) => o.id !== c.id)} announce={announce} />
      }
    />
  );

  return (
    <section ref={sectionRef} aria-labelledby={headingId} className="min-w-0 rounded-[20px] border border-border bg-surface">
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

      {/* One list for both groups, so only one row is open at a time in the section. */}
      <ExpandableList>
        {count === 0 ? (
          <p className="border-t border-surface-muted px-4 py-6 text-center text-sm text-muted-foreground sm:px-[18px]">
            {archived.length > 0 ? `No active ${kind} categories.` : `No ${kind} categories yet.`} Add one below to
            start recording {kind === "expense" ? "expenses" : "income"}.
          </p>
        ) : (
          <ul className="divide-y divide-surface-muted border-t border-surface-muted">{active.map(rowFor)}</ul>
        )}

        <AddCategoryForm kind={kind} onAdded={announce} />

        {archived.length > 0 && (
          <div className="border-t border-surface-muted">
            <div className="px-4 pt-3.5 pb-2 sm:px-[18px]">
              <h3 id={archivedHeadingId} className="text-sm font-semibold text-muted-foreground">
                Archived · {archived.length} {archived.length === 1 ? "category" : "categories"}
              </h3>
              <p className="text-xs text-muted-foreground">
                Hidden from the entry form; their entries stay in reports and history.
              </p>
            </div>
            <ul aria-labelledby={archivedHeadingId} className="divide-y divide-surface-muted border-t border-surface-muted">
              {archived.map(rowFor)}
            </ul>
          </div>
        )}
      </ExpandableList>
    </section>
  );
}

/** Focus the row `pending` names once it is inside `root`, then forget it. */
function focusPendingRow(root: HTMLElement | null, pending: { current: number | null }) {
  if (pending.current === null) return;
  const button = movedRowButton(root, pending.current);
  if (!button) return;
  pending.current = null;
  button.focus();
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
