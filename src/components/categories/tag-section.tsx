"use client";

import Link from "next/link";
import { useActionState, useEffect, useRef, useState } from "react";
import { deleteTagAction, renameTagAction, type TagRenameState } from "@/app/(app)/categories/actions";
import { Button, FieldError, FormError, Input, Label, SubmitButton } from "@/components/ui";
import { ExpandableList, ExpandableRow, useExpandableRow } from "@/components/ui/expandable-row";
import { initialFormState } from "@/lib/form";
import { MAX_TAG_NAME_LENGTH } from "@/lib/tags";
import type { TagView } from "@/server/tags";

/** "/transactions?tag=<id>&month=all": every entry carrying the tag (the count on the card is all time too). */
export function tagEntriesHref(tagId: number): string {
  return `/transactions?month=all&tag=${tagId}`;
}

const entries = (n: number) => (n === 1 ? "1 entry" : `${n} entries`);

/**
 * The "Tags" card of /categories: every tag with its entry count, each row opening in place (as the category rows) to
 * a link to its entries, Rename (renaming onto another tag's name merges the two) and Delete (the entries stay).
 * Tags are created from the entry form, so there is no add row. A live status line announces each change; a merge or
 * a deletion takes the row away, so focus goes to the heading.
 */
export function TagSection({ tags }: { tags: TagView[] }) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [status, setStatus] = useState("");
  const announce = (message: string | undefined, opts: { focusHeading?: boolean } = {}) => {
    setStatus(message ?? "");
    if (opts.focusHeading) headingRef.current?.focus();
  };
  const count = tags.length;

  return (
    <section aria-labelledby="tags-heading" className="min-w-0 rounded-[20px] border border-border bg-surface">
      <div className="px-4 pt-4 pb-3 sm:px-[18px]">
        <h2
          id="tags-heading"
          ref={headingRef}
          tabIndex={-1}
          className="rounded text-base font-bold text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          Tags{" "}
          <span className="font-semibold text-muted-foreground">
            · {count} {count === 1 ? "tag" : "tags"}
          </span>
        </h2>
        <p role="status" className="mt-1 text-sm text-income empty:hidden">
          {status}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          {count === 0
            ? "No tags yet. Type one in the Tags field of an expense or income: it is created when you save."
            : "Labels that cut across categories. Add them in the entry form; counts are for all time."}
        </p>
      </div>
      {count > 0 && (
        <ExpandableList>
          <ul className="divide-y divide-surface-muted border-t border-surface-muted">
            {tags.map((t) => (
              <ExpandableRow
                key={t.id}
                id={`tag-${t.id}`}
                className="last:rounded-b-[20px]"
                buttonClassName="min-h-11 px-4 py-3 text-sm sm:px-[18px] [li:last-child>&]:rounded-b-[20px]"
                summary={<TagSummary key="summary" tag={t} />}
                panelLabel={`Edit tag ${t.name}`}
                panel={<TagPanel key="panel" tag={t} announce={announce} />}
              />
            ))}
          </ul>
        </ExpandableList>
      )}
    </section>
  );
}

function TagSummary({ tag }: { tag: TagView }) {
  return (
    <>
      <span aria-hidden="true" className="shrink-0 text-[13px] font-bold text-muted-foreground">
        #
      </span>
      <span className="min-w-0 flex-1 truncate font-bold text-foreground">{tag.name}</span>
      <span className="shrink-0 text-[13px] font-semibold text-muted-foreground tabular-nums">{entries(tag.transactionCount)}</span>
    </>
  );
}

function TagPanel({
  tag,
  announce,
}: {
  tag: TagView;
  announce: (message: string | undefined, opts?: { focusHeading?: boolean }) => void;
}) {
  const row = useExpandableRow();
  return (
    <div className="space-y-4 px-4 pt-1 pb-4 sm:px-[18px]">
      {/* The name first: opening the row focuses the panel's first control (as the category rows). */}
      <TagRenameForm
        tag={tag}
        onCancel={() => row.close()}
        onDone={(message, merged) => {
          // A merge takes this row away (the other tag stays): focus goes to the heading, as after a deletion.
          row.close({ restoreFocus: !merged });
          announce(message, { focusHeading: merged });
        }}
      />
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-border pt-3">
        <TagDeleteButton
          tag={tag}
          onDeleted={(message) => {
            row.close({ restoreFocus: false });
            announce(message, { focusHeading: true });
          }}
        />
        {tag.transactionCount > 0 ? (
          <Link
            href={tagEntriesHref(tag.id)}
            className="inline-flex min-h-11 items-center text-sm font-semibold text-accent-hover hover:underline"
          >
            Show its {entries(tag.transactionCount)}
            <span aria-hidden="true">&nbsp;›</span>
          </Link>
        ) : (
          <p className="text-sm text-muted-foreground">No entry carries it.</p>
        )}
      </div>
    </div>
  );
}

function TagRenameForm({
  tag,
  onCancel,
  onDone,
}: {
  tag: TagView;
  onCancel: () => void;
  onDone: (message: string | undefined, merged: boolean) => void;
}) {
  const [state, formAction] = useActionState(async (prev: TagRenameState, formData: FormData) => {
    const next = await renameTagAction(tag.id, prev, formData);
    if (next.ok) onDone(next.message, next.merged === true);
    return next;
  }, initialFormState as TagRenameState);
  const inputRef = useRef<HTMLInputElement>(null);
  const id = `rename-tag-${tag.id}`;
  const hintId = `${id}-hint`;
  const error = state.fieldErrors?.name;

  // Focus (and select) the name on open; back to the input after a rejected name.
  useEffect(() => {
    inputRef.current?.focus();
    if (!state.fieldErrors?.name) inputRef.current?.select();
  }, [state]);

  return (
    <form action={formAction} noValidate className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor={id}>New name for “{tag.name}”</Label>
        <Input
          ref={inputRef}
          id={id}
          name="name"
          required
          maxLength={MAX_TAG_NAME_LENGTH}
          autoComplete="off"
          defaultValue={state.values?.name ?? tag.name}
          error={error}
          aria-describedby={hintId}
          className="w-full not-aria-[invalid=true]:border-accent"
        />
        <FieldError id={id}>{error}</FieldError>
        <p id={hintId} className="text-xs text-muted-foreground">
          Giving it the name of another tag merges the two.
        </p>
      </div>
      <div className="flex gap-2">
        <SubmitButton pendingLabel="Saving…">Save</SubmitButton>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      <FormError message={state.message} />
    </form>
  );
}

function TagDeleteButton({ tag, onDeleted }: { tag: TagView; onDeleted: (message?: string) => void }) {
  const [state, formAction] = useActionState(async () => {
    const next = await deleteTagAction(tag.id);
    if (next.ok) onDeleted(next.message);
    return next;
  }, initialFormState);
  const question =
    tag.transactionCount === 0
      ? `Delete the tag “${tag.name}”?`
      : `Delete the tag “${tag.name}”? It is taken off its ${entries(tag.transactionCount)}; the entries stay.`;
  return (
    <form
      action={formAction}
      onSubmit={(e) => {
        if (!window.confirm(question)) e.preventDefault();
      }}
      // Not shrunk next to the link: a long name wraps the link onto the next line before it is truncated.
      className="max-w-full min-w-0 shrink-0 space-y-1.5"
    >
      <SubmitButton variant="ghost" className="-ml-3 max-w-full min-w-0 text-danger! hover:bg-danger-soft!" pendingLabel="Deleting…">
        <span className="truncate">Delete {tag.name}</span>
      </SubmitButton>
      {!state.ok && state.message && (
        <p role="alert" className="text-sm text-danger">
          {state.message}
        </p>
      )}
    </form>
  );
}
