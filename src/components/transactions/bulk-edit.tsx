"use client";

import Link from "next/link";
import {
  createContext,
  startTransition,
  useActionState,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { BulkState } from "@/app/(app)/transactions/bulk-actions";
import { Button, Field, FormError, Input, Select, SubmitButton, buttonClasses } from "@/components/ui";
import { deleteConfirmText, selectionText } from "@/lib/bulk-result";
import { cn } from "@/lib/cn";

// Selection mode on /transactions (`?select=1`): a checkbox per row, the bar with the bulk actions, the result line.
// The row checkboxes live in the day list, outside the bar's <form>, and join it with the `form` attribute (forms
// cannot nest, and each open row has its own form). With JavaScript the bar posts through `startTransition` so React
// does not reset the form (and with it every ticked box) after a refused action; without it the bar is a plain
// progressive form and a page rendered from the action's state ticks the boxes again (`selectedIds`).

export const BULK_FORM_ID = "bulk-edit";

type Ctx = { state: BulkState; preselectAll: boolean };

const BulkContext = createContext<Ctx | null>(null);

type Action = (prev: BulkState, formData: FormData) => Promise<BulkState>;

type BarProps = {
  /** The list's query string (`month=…&category=…`), re-evaluated by the action for "all matching". */
  list: string;
  /** Rows on this page. */
  shown: number;
  /** Every match of the filters. */
  total: number;
  /** Active categories (archived ones take no new entries). */
  categories: CategoryChoice[];
  tags: { id: number; name: string }[];
  /** No-JS stand-ins: the list with every shown row ticked, and with none. */
  selectAllHref: string;
  clearHref: string;
};

/**
 * Selection mode: the bar (`BulkBar`) over `children` (the day list in selection mode), sharing the action state with
 * every row checkbox. `action` is passed from the server page (a Server Action reference), so the bar also posts
 * without JavaScript.
 */
export function BulkEditProvider({
  action,
  preselectAll = false,
  children,
  ...bar
}: BarProps & {
  action: Action;
  /** `?select=page`: every shown row starts ticked (the no-JS "Select all shown"). */
  preselectAll?: boolean;
  children: ReactNode;
}) {
  const [state, formAction, pending] = useActionState(action, {} as BulkState);
  return (
    <BulkContext.Provider value={{ state, preselectAll }}>
      <BulkBar {...bar} state={state} formAction={formAction} pending={pending} />
      {children}
    </BulkContext.Provider>
  );
}

/** A row's checkbox (`name="ids"`, joined to the bar's form). Its label is the row around it. */
export function RowCheckbox({ id }: { id: number }) {
  const ctx = useContext(BulkContext);
  const checked = ctx?.state.selectedIds ? ctx.state.selectedIds.includes(id) : Boolean(ctx?.preselectAll);
  return (
    <input
      type="checkbox"
      name="ids"
      value={id}
      form={BULK_FORM_ID}
      defaultChecked={checked}
      className="size-5 shrink-0 cursor-pointer accent-[var(--accent)]"
    />
  );
}

/** Every row checkbox of the bar's form. */
function tickedRows(): HTMLInputElement[] {
  return [...document.querySelectorAll<HTMLInputElement>(`input[name="ids"][form="${BULK_FORM_ID}"]`)];
}

const noopSubscribe = () => () => {};
/** False during SSR and hydration, true afterwards (as in tags-field.tsx). */
function useHydrated(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}

function subscribeToRowChanges(onChange: () => void): () => void {
  function listener(e: Event) {
    const t = e.target;
    if (t instanceof HTMLInputElement && t.name === "ids" && t.getAttribute("form") === BULK_FORM_ID) onChange();
  }
  document.addEventListener("change", listener);
  return () => document.removeEventListener("change", listener);
}

/** How many row checkboxes are ticked (null before hydration). */
function useTickedCount(): number | null {
  return useSyncExternalStore(
    subscribeToRowChanges,
    () => tickedRows().filter((b) => b.checked).length,
    () => null,
  );
}

type CategoryChoice = { id: number; name: string; kind: "expense" | "income" };

const OP_LABEL = { category: "Set category", addTag: "Add tag", removeTag: "Remove tag", delete: "Delete" } as const;
type Op = keyof typeof OP_LABEL;

/**
 * The selection bar: how many are selected, "Select all shown" / "Clear", "Select all N matching" when the filtered
 * result is larger than the page, then the action (Set category · Add tag · Remove tag · Delete), its one field and
 * Apply. A Delete first shows the server's counts with "Delete N" and Cancel. Focus goes to that confirmation, or to
 * the first problem, after each answer.
 */
function BulkBar({
  state,
  formAction,
  pending,
  list,
  shown,
  total,
  categories,
  tags,
  selectAllHref,
  clearHref,
}: BarProps & {
  state: BulkState;
  formAction: (fd: FormData) => void;
  pending: boolean;
}) {
  const v = state.values ?? {};
  const err = state.fieldErrors ?? {};
  const hydrated = useHydrated();
  const count = useTickedCount();
  const [, bump] = useState(0);
  const [op, setOp] = useState<Op>(((v.op as Op) in OP_LABEL ? (v.op as Op) : "category"));
  const [all, setAll] = useState(v.scope === "all");
  const formRef = useRef<HTMLFormElement>(null);
  const confirmRef = useRef<HTMLHeadingElement>(null);
  const messageRef = useRef<HTMLDivElement>(null);


  // After each answer: the confirmation, else the first invalid control, else the message.
  useEffect(() => {
    if (state.confirm) {
      confirmRef.current?.focus();
      return;
    }
    const invalid = formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
    if (invalid) invalid.focus();
    else if (state.message) messageRef.current?.focus();
  }, [state]);

  const setAllRows = (checked: boolean) => {
    for (const box of tickedRows()) box.checked = checked;
    // Setting `checked` fires no change event: render again so the count reads the boxes.
    bump((n) => n + 1);
  };

  const showField = (which: Op) => !hydrated || op === which;
  const selectedText = all
    ? `All ${total.toLocaleString("en-US")} matching entries selected`
    : count === null
      ? state.selectedIds
        ? `${state.selectedIds.length} selected`
        : "Tick the entries to change"
      : `${count} of ${shown} shown selected`;

  return (
    <section
      aria-labelledby="bulk-heading"
      className="mb-3 rounded-[18px] border border-accent bg-surface p-3 sm:sticky sm:top-3 sm:z-20 sm:p-4 sm:shadow-lg sm:shadow-black/10"
    >
      <form
        id={BULK_FORM_ID}
        ref={formRef}
        action={formAction}
        onSubmit={(e) => {
          // Through a transition, so React does not reset the form (and the ticked rows) after the answer.
          e.preventDefault();
          const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLElement | null;
          const fd = new FormData(e.currentTarget, submitter);
          startTransition(() => formAction(fd));
        }}
        className="flex flex-col gap-3"
      >
        <input type="hidden" name="list" value={list} />
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <h2 id="bulk-heading" className="text-sm font-bold text-foreground">
            Bulk edit <span className="font-semibold text-muted-foreground">·</span>{" "}
            <span aria-live="polite" className="font-semibold text-muted-foreground">
              {selectedText}
            </span>
          </h2>
          <div className="flex flex-wrap items-center gap-1">
            {hydrated ? (
              <>
                <Button type="button" variant="ghost" size="sm" className="min-h-11 sm:min-h-9" onClick={() => setAllRows(true)}>
                  Select all shown
                </Button>
                <Button type="button" variant="ghost" size="sm" className="min-h-11 sm:min-h-9" onClick={() => setAllRows(false)}>
                  Clear
                </Button>
              </>
            ) : (
              <>
                <Link href={selectAllHref} className={buttonClasses({ variant: "ghost", size: "sm", className: "min-h-11 sm:min-h-9" })}>
                  Select all shown
                </Link>
                <Link href={clearHref} className={buttonClasses({ variant: "ghost", size: "sm", className: "min-h-11 sm:min-h-9" })}>
                  Clear
                </Link>
              </>
            )}
          </div>
        </div>

        {total > shown && (
          <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xl bg-surface-muted px-3 text-sm font-medium text-foreground">
            <input
              type="checkbox"
              name="scope"
              value="all"
              checked={all}
              onChange={(e) => setAll(e.target.checked)}
              className="size-5 shrink-0 accent-[var(--accent)]"
            />
            <span>
              Select all {total.toLocaleString("en-US")} matching entries{" "}
              <span className="text-muted-foreground">(every page, not only the {shown} shown)</span>
            </span>
          </label>
        )}

        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-start">
          <Field id="bulk-op" label="Action" error={err.op} className="sm:w-44">
            <Select
              id="bulk-op"
              name="op"
              value={op}
              onChange={(e) => setOp(e.target.value as Op)}
              error={err.op}
            >
              {(Object.keys(OP_LABEL) as Op[]).map((k) => (
                <option key={k} value={k}>
                  {OP_LABEL[k]}
                </option>
              ))}
            </Select>
          </Field>
          {showField("category") && (
            <Field
              id="bulk-category"
              label={hydrated ? "Category" : "Category (for Set category)"}
              error={err.categoryId}
              className="sm:w-56"
            >
              <Select
                key={v.categoryId ?? ""}
                id="bulk-category"
                name="categoryId"
                defaultValue={v.categoryId ?? ""}
                error={err.categoryId}
              >
                <option value="">Choose…</option>
                {(["expense", "income"] as const).map((kind) => {
                  const group = categories.filter((c) => c.kind === kind);
                  return group.length === 0 ? null : (
                    <optgroup key={kind} label={kind === "expense" ? "Expense" : "Income"}>
                      {group.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </optgroup>
                  );
                })}
              </Select>
            </Field>
          )}
          {showField("addTag") && (
            <Field id="bulk-tag-name" label={hydrated ? "Tag to add" : "Tag to add (for Add tag)"} error={err.tagName} className="sm:w-56">
              <Input
                id="bulk-tag-name"
                name="tagName"
                list="bulk-tag-names"
                maxLength={40}
                autoComplete="off"
                defaultValue={v.tagName ?? ""}
                error={err.tagName}
              />
              <datalist id="bulk-tag-names">
                {tags.map((t) => (
                  <option key={t.id} value={t.name} />
                ))}
              </datalist>
            </Field>
          )}
          {showField("removeTag") && (
            <Field id="bulk-tag" label={hydrated ? "Tag to remove" : "Tag to remove (for Remove tag)"} error={err.tagId} className="sm:w-56">
              <Select key={v.tagId ?? ""} id="bulk-tag" name="tagId" defaultValue={v.tagId ?? ""} error={err.tagId}>
                <option value="">Choose…</option>
                {tags.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <div className="sm:pt-6">
            <SubmitButton
              variant={op === "delete" && hydrated ? "danger" : "primary"}
              pending={pending}
              pendingLabel="Working…"
              className="w-full sm:w-auto"
            >
              {hydrated && op === "delete" ? "Delete…" : "Apply"}
            </SubmitButton>
          </div>
        </div>

        {state.message && (
          <div ref={messageRef} tabIndex={-1} className="outline-none">
            <FormError message={state.message} />
          </div>
        )}

        {state.confirm && (
          <div
            role="group"
            aria-labelledby="bulk-confirm-heading"
            aria-describedby="bulk-confirm-text"
            className="flex flex-col gap-3 rounded-xl border border-danger/40 bg-danger-soft p-3"
          >
            <h3 id="bulk-confirm-heading" ref={confirmRef} tabIndex={-1} className="text-sm font-bold text-danger outline-none">
              Confirm delete
            </h3>
            <p id="bulk-confirm-text" className="text-sm text-foreground">
              {deleteConfirmText(state.confirm)}{" "}
              <Link href="/data" className="font-semibold text-accent-hover underline">
                Go to Data
              </Link>
            </p>
            <div className="flex flex-wrap gap-2">
              <SubmitButton
                variant="danger"
                name="confirmed"
                value={`${state.confirm.entries}:${state.confirm.transfers}`}
                pendingLabel="Deleting…"
              >
                Delete {selectionText(state.confirm)}
              </SubmitButton>
              <Button type="submit" variant="secondary" name="intent" value="cancel" formNoValidate>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </form>
    </section>
  );
}

/** The outcome of the last bulk action (`?done=`): a status line that takes the focus when it appears. */
export function BulkResult({ message }: { message: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, [message]);
  return (
    <p
      ref={ref}
      role="status"
      tabIndex={-1}
      className={cn(
        "mb-3 rounded-[18px] border border-income/30 bg-income-soft px-4 py-3 text-sm font-semibold text-income",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
      )}
    >
      {message}
    </p>
  );
}
