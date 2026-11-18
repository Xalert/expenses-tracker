"use client";

import { useRef, useState, useTransition } from "react";
import type { NewCategoryState } from "@/app/(app)/transactions/actions";
import { Button, FieldError, Input } from "@/components/ui";

type Kind = "expense" | "income";
type Created = NonNullable<NewCategoryState["category"]>;
type Action = (prev: NewCategoryState, formData: FormData) => Promise<NewCategoryState>;

/**
 * "+ New category" inside the entry form's category picker: a dashed pill that opens a name field with Add and
 * Cancel, creating a category of `kind` through `action` without leaving the form (it sits inside the entry
 * <form>, so it has no <form> of its own and its field has no `name`: nothing extra is posted). Enter adds, Escape
 * cancels (and does not close the dialog around it). On success `onCreated` gets the new category, which the form
 * selects.
 */
export function NewCategoryInline({
  kind,
  action,
  onCreated,
  idPrefix = "",
  pillClassName,
}: {
  kind: Kind;
  action: Action;
  onCreated: (category: Created) => void;
  idPrefix?: string;
  /** The look of the closed "+ New category" pill (the form's dashed pill). */
  pillClassName: string;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [pending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const inputId = `${idPrefix}newCategoryName`;
  const noun = kind === "expense" ? "expense" : "income";

  function submit() {
    const data = new FormData();
    data.set("kind", kind);
    data.set("name", name);
    startTransition(async () => {
      const result = await action({}, data);
      if (result.ok && result.category) {
        setOpen(false);
        setName("");
        setError(undefined);
        onCreated(result.category);
      } else {
        setError(result.fieldErrors?.name ?? result.message ?? "Could not add the category.");
        inputRef.current?.focus();
      }
    });
  }

  function cancel() {
    setOpen(false);
    setName("");
    setError(undefined);
    // After the field unmounts: focus back on the pill that opened it.
    requestAnimationFrame(() => toggleRef.current?.focus());
  }

  if (!open) {
    return (
      <button
        ref={toggleRef}
        type="button"
        className={pillClassName}
        onClick={() => {
          setOpen(true);
          requestAnimationFrame(() => inputRef.current?.focus());
        }}
      >
        + New category
      </button>
    );
  }

  return (
    <div className="w-full space-y-1.5">
      <label htmlFor={inputId} className="sr-only">
        New {noun} category name
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          ref={inputRef}
          id={inputId}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              // Not the entry form's submit.
              e.preventDefault();
              if (!pending) submit();
            } else if (e.key === "Escape") {
              // Marked handled, so the dialog around the form stays open.
              e.preventDefault();
              cancel();
            }
          }}
          maxLength={40}
          autoComplete="off"
          placeholder={`New ${noun} category`}
          error={error}
          className="min-w-0 flex-1 sm:max-w-64"
        />
        <Button type="button" size="sm" pending={pending} onClick={submit}>
          {pending ? "Adding…" : "Add"}
        </Button>
        <Button type="button" size="sm" variant="secondary" onClick={cancel}>
          Cancel
        </Button>
      </div>
      <FieldError id={inputId}>{error}</FieldError>
    </div>
  );
}
