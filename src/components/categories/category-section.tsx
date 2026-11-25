"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { createCategoryAction } from "@/app/(app)/categories/actions";
import { Button, FieldError, Input, SubmitButton } from "@/components/ui";
import { ExpandableList, ExpandableRow, useExpandableRow } from "@/components/ui/expandable-row";
import type { Elapsed } from "@/lib/budgets";
import { rowShare, type SplitSegment } from "@/lib/category-split";
import { cn } from "@/lib/cn";
import { initialFormState, type FormState } from "@/lib/form";
import { formatMoney } from "@/lib/money";
import type { BudgetProgress, BudgetView } from "@/server/budgets";
import type { CategoryWithMonthUsage } from "@/server/categories";
import { BudgetForm } from "./budget-form";
import { BudgetMeter } from "./budget-meter";
import { CATEGORY_MOVED_EVENT, announceCategoryMoved, isMovedInto, movedRowButton } from "./category-move";
import { CategoryPanel, CategorySummary, MAX_CATEGORY_NAME, type Announce, type BudgetChoices } from "./category-row";

/** What the expense card needs for budgets (see `CategorySection`). */
export type SectionBudgets = {
  /** Every budget of the account (the editors show and change these). */
  list: BudgetView[];
  /** The month's progress; null in the group scope, where it is not shown (budgets cover every group). */
  progress: { budgets: BudgetProgress[]; elapsed: Elapsed } | null;
  /** The currencies a budget can be in: those of the user's wallets, archived included. */
  currencies: string[];
  /** The currency offered for a new budget. */
  defaultCurrency: string | null;
};

const TITLE = { expense: "Expense", income: "Income" } as const;

/**
 * One kind's list on /categories: heading ("Expense · 5 categories", active ones), a live status line (announces
 * adds, renames, kind changes, (un)archiving and removals), the active categories as rows that open in place, the
 * dashed "add" row, then — when there are any — the archived ones under a muted "Archived · N" heading.
 * `segments` are the spending split's (expense only); `currency` is the one the month amounts are in. With `budgets`
 * (expense only) the list starts with the overall budget's row, each row with a budget shows its meter (unless the
 * progress is null: the group scope, said in one line under the heading) and the editors get the budget form.
 */
export function CategorySection({
  kind,
  categories,
  currency,
  segments,
  budgets,
}: {
  kind: "expense" | "income";
  categories: CategoryWithMonthUsage[];
  currency: string | null;
  segments: SplitSegment[];
  /** Expense card only: the budgets, their month's progress and what the budget editor offers. */
  budgets?: SectionBudgets;
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
  const budgetOf = new Map((budgets?.list ?? []).map((b) => [b.categoryId, b]));
  const progressOf = new Map((budgets?.progress?.budgets ?? []).map((b) => [b.categoryId, b]));
  const elapsed = budgets?.progress?.elapsed ?? null;
  const choices: BudgetChoices | undefined = budgets
    ? { currencies: budgets.currencies, defaultCurrency: budgets.defaultCurrency }
    : undefined;

  const rowFor = (c: CategoryWithMonthUsage) => {
    const progress = progressOf.get(c.id);
    return (
      <ExpandableRow
        key={c.id}
        id={String(c.id)}
        buttonClassName={cn("min-h-11 px-4 py-3 text-sm sm:px-[18px]", progress && "flex-wrap gap-y-2")}
        summary={
          <CategorySummary
            key="summary"
            category={c}
            currency={currency}
            share={kind === "expense" ? rowShare(byId.get(c.id)) : null}
            budget={progress}
            elapsed={elapsed}
          />
        }
        panelLabel={`Edit ${c.name}`}
        panel={
          <CategoryPanel
            key="panel"
            category={c}
            others={active.filter((o) => o.id !== c.id)}
            announce={announce}
            budget={budgetOf.get(c.id)}
            budgetChoices={kind === "expense" ? choices : undefined}
          />
        }
      />
    );
  };

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
        {budgets && budgets.list.length > 0 && !budgets.progress && (
          <p className="mt-1 text-sm text-muted-foreground">
            Budgets cover all your wallet groups, so their progress shows only with All groups selected.
          </p>
        )}
      </div>

      {/* One list for both groups, so only one row is open at a time in the section. */}
      <ExpandableList>
        {budgets && choices && (
          <ul aria-label="Overall budget" className="border-t border-surface-muted">
            <OverallBudgetRow
              budget={budgetOf.get(null)}
              progress={progressOf.get(null)}
              elapsed={elapsed}
              choices={choices}
              announce={announce}
            />
          </ul>
        )}
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

/**
 * The first row of the expense card: the overall budget (all spending, every category). Its summary shows the limit
 * ("€2,000.00 a month", or "Not set") and, with progress, the meter; its panel is the budget form.
 */
function OverallBudgetRow({
  budget,
  progress,
  elapsed,
  choices,
  announce,
}: {
  budget: BudgetView | undefined;
  progress: BudgetProgress | undefined;
  elapsed: Elapsed;
  choices: BudgetChoices;
  announce: Announce;
}) {
  return (
    <ExpandableRow
      id="overall-budget"
      buttonClassName={cn("min-h-11 px-4 py-3 text-sm sm:px-[18px]", progress && "flex-wrap gap-y-2")}
      summary={
        <>
          <span aria-hidden="true" className="size-2.5 shrink-0 rounded-[3px] bg-foreground" />
          <span className="min-w-0 flex-1 sm:truncate">
            <span className="block truncate font-bold text-foreground sm:inline">Overall budget</span>
            <span className="block truncate text-xs text-muted-foreground sm:inline sm:text-[13px]">
              <span className="hidden sm:inline"> · </span>
              all spending
            </span>
          </span>
          <span
            className={cn(
              "shrink-0 text-right tabular-nums",
              budget ? "font-bold text-foreground" : "font-semibold text-muted-foreground",
            )}
          >
            {budget ? `${formatMoney(budget.amountMinor, budget.currency)} a month` : "Not set"}
          </span>
          {progress && (
            <span className="basis-full pl-[22px]">
              <span className="sr-only">This month: </span>
              <BudgetMeter budget={progress} elapsed={elapsed} />
            </span>
          )}
        </>
      }
      panelLabel="Edit the overall budget"
      panel={<OverallBudgetPanel budget={budget} choices={choices} announce={announce} />}
    />
  );
}

function OverallBudgetPanel({
  budget,
  choices,
  announce,
}: {
  budget: BudgetView | undefined;
  choices: BudgetChoices;
  announce: Announce;
}) {
  const row = useExpandableRow();
  return (
    <div className="space-y-3 px-4 pt-1 pb-4 sm:px-[18px]">
      <BudgetForm
        target={null}
        subject="all spending"
        budget={budget}
        currencies={choices.currencies}
        defaultCurrency={choices.defaultCurrency}
        onDone={(message) => {
          row.close();
          announce(message);
        }}
      />
      <Button variant="secondary" onClick={() => row.close()}>
        Cancel
      </Button>
    </div>
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
