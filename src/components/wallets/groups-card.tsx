"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { createGroupAction, deleteGroupAction, renameGroupAction } from "@/app/(app)/wallets/actions";
import { Button, FieldError, FormError, Input, Label, SubmitButton } from "@/components/ui";
import { ExpandableList, ExpandableRow, useExpandableRow } from "@/components/ui/expandable-row";
import { initialFormState, type FormState } from "@/lib/form";

export const MAX_GROUP_NAME = 40;

export type GroupRowData = { id: number; name: string; walletCount: number };

const walletsLabel = (n: number) => (n === 1 ? "1 wallet" : `${n} wallets`);

/**
 * The "Groups" card of the Wallets page: every group with its wallet count (rows open in place to rename or delete),
 * and the dashed "New group" input. A group can only be deleted while it is empty and not the user's last one.
 */
export function GroupsCard({ groups }: { groups: GroupRowData[] }) {
  const [status, setStatus] = useState("");
  return (
    <section aria-labelledby="groups-heading" className="min-w-0 rounded-[20px] border border-border bg-surface">
      <div className="px-4 pt-4 pb-3 sm:px-[18px]">
        <h2 id="groups-heading" className="text-base font-bold text-foreground">
          Groups{" "}
          <span className="font-semibold text-muted-foreground">
            · {groups.length} {groups.length === 1 ? "group" : "groups"}
          </span>
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Keep wallets apart, for example personal and business. With two or more groups, a switcher appears in the top
          bar.
        </p>
        <p role="status" className="mt-1 text-sm text-income empty:hidden">
          {status}
        </p>
      </div>
      <ExpandableList>
        <ul className="divide-y divide-surface-muted border-t border-surface-muted">
          {groups.map((g) => (
            <ExpandableRow
              key={g.id}
              id={String(g.id)}
              buttonClassName="min-h-11 px-4 py-3 text-sm sm:px-[18px]"
              summary={
                <>
                  <span className="min-w-0 flex-1 truncate font-bold text-foreground">{g.name}</span>
                  <span className="shrink-0 text-[13px] text-muted-foreground">{walletsLabel(g.walletCount)}</span>
                </>
              }
              panelLabel={`Rename or delete ${g.name}`}
              panel={<GroupPanel group={g} canDelete={g.walletCount === 0 && groups.length > 1} onDone={setStatus} />}
            />
          ))}
        </ul>
      </ExpandableList>
      <AddGroupForm onAdded={setStatus} />
    </section>
  );
}

function GroupPanel({
  group,
  canDelete,
  onDone,
}: {
  group: GroupRowData;
  canDelete: boolean;
  onDone: (message: string) => void;
}) {
  const row = useExpandableRow();
  return (
    <div className="px-4 pt-1 pb-4 sm:px-[18px]">
      <RenameForm
        group={group}
        onCancel={() => row.close()}
        onRenamed={(m) => {
          row.close();
          onDone(m ?? "");
        }}
      />
      <div className="mt-4 border-t border-border pt-3">
        {canDelete ? (
          <DeleteForm
            group={group}
            onDeleted={(m) => {
              row.close({ restoreFocus: false });
              onDone(m ?? "");
            }}
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            {group.walletCount > 0
              ? `“${group.name}” has ${walletsLabel(group.walletCount)}. Move or delete them first to delete the group.`
              : "This is your only group, so it can't be deleted. Add another group first."}
          </p>
        )}
      </div>
    </div>
  );
}

function RenameForm({
  group,
  onCancel,
  onRenamed,
}: {
  group: GroupRowData;
  onCancel: () => void;
  onRenamed: (message?: string) => void;
}) {
  const [state, formAction] = useActionState(async (prev: FormState, formData: FormData) => {
    const next = await renameGroupAction(group.id, prev, formData);
    if (next.ok) onRenamed(next.message);
    return next;
  }, initialFormState);
  const inputRef = useRef<HTMLInputElement>(null);
  const id = `rename-group-${group.id}`;
  const error = state.fieldErrors?.name;

  useEffect(() => {
    inputRef.current?.focus();
    if (!state.fieldErrors?.name) inputRef.current?.select();
  }, [state]);

  return (
    <form action={formAction} noValidate className="space-y-1.5">
      <Label htmlFor={id}>New name for “{group.name}”</Label>
      <div className="flex flex-wrap gap-2">
        <Input
          ref={inputRef}
          id={id}
          name="name"
          required
          maxLength={MAX_GROUP_NAME}
          autoComplete="off"
          defaultValue={state.values?.name ?? group.name}
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

function DeleteForm({ group, onDeleted }: { group: GroupRowData; onDeleted: (message?: string) => void }) {
  const [state, formAction] = useActionState(async () => {
    const next = await deleteGroupAction(group.id);
    if (next.ok) onDeleted(next.message);
    return next;
  }, initialFormState);
  const error = state.fieldErrors?.groupId ?? state.message;
  return (
    <form
      action={formAction}
      onSubmit={(e) => {
        if (!window.confirm(`Delete the group “${group.name}”? It has no wallets.`)) e.preventDefault();
      }}
      className="space-y-2"
    >
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <SubmitButton variant="ghost" className="-ml-3 max-w-full min-w-0 text-danger! hover:bg-danger-soft!" pendingLabel="Deleting…">
        <span className="truncate">Delete {group.name}</span>
      </SubmitButton>
    </form>
  );
}

function AddGroupForm({ onAdded }: { onAdded: (message: string) => void }) {
  const [state, formAction] = useActionState(async (prev: FormState, formData: FormData) => {
    const next = await createGroupAction(prev, formData);
    onAdded(next.ok ? (next.message ?? "") : "");
    return next;
  }, initialFormState);
  const inputRef = useRef<HTMLInputElement>(null);
  const error = state.fieldErrors?.name;

  useEffect(() => {
    if (state.fieldErrors?.name) inputRef.current?.focus();
  }, [state]);

  return (
    <form action={formAction} noValidate className="space-y-1.5 border-t border-surface-muted px-4 py-3.5 sm:px-[18px]">
      <label htmlFor="new-group" className="sr-only">
        New group
      </label>
      <div className="flex gap-2">
        <Input
          ref={inputRef}
          id="new-group"
          name="name"
          required
          maxLength={MAX_GROUP_NAME}
          autoComplete="off"
          placeholder="+ New group"
          defaultValue={state.values?.name}
          error={error}
          className="min-w-0 flex-1 border-dashed"
        />
        <SubmitButton variant="secondary" pendingLabel="Adding…" className="shrink-0">
          Add
        </SubmitButton>
      </div>
      <FieldError id="new-group">{error}</FieldError>
      {state.message && !state.ok && (
        <p role="alert" className="text-sm text-danger">
          {state.message}
        </p>
      )}
    </form>
  );
}
