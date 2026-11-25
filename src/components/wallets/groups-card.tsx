"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import {
  archiveGroupAction,
  createGroupAction,
  deleteGroupAction,
  moveGroupAction,
  renameGroupAction,
} from "@/app/(app)/wallets/actions";
import { Button, FieldError, FormError, Input, Label, SubmitButton } from "@/components/ui";
import { ColorChoice } from "@/components/ui/color-choice";
import { ExpandableList, ExpandableRow, useExpandableRow } from "@/components/ui/expandable-row";
import { cn } from "@/lib/cn";
import { initialFormState, type FormState } from "@/lib/form";
import { ActionButton } from "./action-button";
import { GroupDot } from "./group-dot";

export const MAX_GROUP_NAME = 40;

export type GroupRowData = { id: number; name: string; walletCount: number; color?: string | null };

const walletsLabel = (n: number) => (n === 1 ? "1 wallet" : `${n} wallets`);

/**
 * The "Groups" card of the Wallets page: the unarchived groups in their order, each with its colour dot, wallet count
 * and Move up / Move down buttons (plain forms, so they work without JavaScript). A row opens in place to rename it,
 * change its colour, archive it or delete it; the dashed "New group" form adds one at the end. Archived groups are not
 * here: the page lists them under "Archived groups". A group can only be archived or deleted while another unarchived
 * one exists, and deleted only while it is empty.
 */
export function GroupsCard({ groups }: { groups: GroupRowData[] }) {
  const [status, setStatus] = useState("");
  const last = groups.length - 1;
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
          {groups.map((g, i) => (
            <ExpandableRow
              key={g.id}
              id={String(g.id)}
              className="relative"
              buttonClassName={cn("min-h-11 py-3 pl-4 text-sm sm:pl-[18px]", groups.length > 1 ? "pr-28" : "pr-4 sm:pr-[18px]")}
              summary={
                <>
                  <GroupDot color={g.color} />
                  <span className="min-w-0 flex-1 truncate font-bold text-foreground">{g.name}</span>
                  <span className="shrink-0 text-[13px] text-muted-foreground">{walletsLabel(g.walletCount)}</span>
                </>
              }
              after={groups.length > 1 ? <MoveButtons group={g} first={i === 0} last={i === last} /> : undefined}
              panelLabel={`Edit ${g.name}`}
              panel={
                <GroupPanel
                  group={g}
                  canDelete={g.walletCount === 0 && groups.length > 1}
                  canArchive={groups.length > 1}
                  onDone={setStatus}
                />
              }
            />
          ))}
        </ul>
      </ExpandableList>
      <AddGroupForm onAdded={setStatus} />
    </section>
  );
}

function ArrowIcon({ dir }: { dir: "up" | "down" }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="size-4">
      <path d={dir === "up" ? "M12 19V5M6 11l6-6 6 6" : "M12 5v14M6 13l6 6 6-6"} />
    </svg>
  );
}

/** Two tiny forms beside the row's button (outside it): one place up / down. Disabled at the ends. */
function MoveButtons({ group, first, last }: { group: GroupRowData; first: boolean; last: boolean }) {
  const button =
    "grid size-9 place-items-center rounded-full text-muted-foreground hover:bg-surface-muted hover:text-foreground " +
    "focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-30 disabled:hover:bg-transparent";
  return (
    <div className="absolute top-1 right-3 flex gap-1 sm:right-[14px]">
      <form action={moveGroupAction.bind(null, group.id, "up")}>
        <button type="submit" disabled={first} aria-label={`Move ${group.name} up`} title="Move up" className={button}>
          <ArrowIcon dir="up" />
        </button>
      </form>
      <form action={moveGroupAction.bind(null, group.id, "down")}>
        <button type="submit" disabled={last} aria-label={`Move ${group.name} down`} title="Move down" className={button}>
          <ArrowIcon dir="down" />
        </button>
      </form>
    </div>
  );
}

function GroupPanel({
  group,
  canDelete,
  canArchive,
  onDone,
}: {
  group: GroupRowData;
  canDelete: boolean;
  canArchive: boolean;
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
      <div className="mt-4 space-y-3 border-t border-border pt-3">
        {canArchive ? (
          <div className="space-y-1.5">
            <p className="text-sm text-muted-foreground">
              An archived group leaves the switcher and the group pickers, and its wallets are hidden like archived
              wallets. Their entries stay; you can unarchive it from the list below the wallets.
            </p>
            <ActionButton
              action={archiveGroupAction.bind(null, group.id)}
              label={`Archive ${group.name}`}
              pendingLabel="Archiving…"
              confirmMessage={`Archive the group “${group.name}”? Its wallets will be hidden until you unarchive it.`}
              onDone={() => {
                row.close({ restoreFocus: false });
                onDone(`Archived the group “${group.name}”.`);
              }}
            />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            This is your only group that is not archived, so it can&apos;t be archived or deleted. Add another group first.
          </p>
        )}
        {canDelete ? (
          <DeleteForm
            group={group}
            onDeleted={(m) => {
              row.close({ restoreFocus: false });
              onDone(m ?? "");
            }}
          />
        ) : (
          canArchive && (
            <p className="text-sm text-muted-foreground">
              “{group.name}” has {walletsLabel(group.walletCount)}. Move or delete them first to delete the group.
            </p>
          )
        )}
      </div>
    </div>
  );
}

/**
 * Rename / recolour an archived group in place (the "Archived groups" section of the Wallets page), without
 * unarchiving it: an "Edit" toggle, then — on a line of its own in the row (`basis-full`) — the same form as the
 * Groups card's. Focus goes into the name on open and back to the toggle on Cancel or Save; a save is announced.
 * Rendered as siblings (a fragment) so the toggle sits in the row's flex line next to Unarchive.
 */
export function ArchivedGroupEditor({ group }: { group: GroupRowData }) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState("");
  const toggle = useRef<HTMLButtonElement>(null);
  const panelId = `archived-group-${group.id}-edit`;
  const close = (message?: string) => {
    setOpen(false);
    if (message !== undefined) setStatus(message);
    toggle.current?.focus();
  };
  return (
    <>
      <Button
        ref={toggle}
        variant="secondary"
        size="sm"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={`Rename or recolour ${group.name}`}
        onClick={() => {
          setStatus("");
          setOpen((o) => !o);
        }}
        className="max-sm:h-11!"
      >
        Edit
      </Button>
      <p role="status" className="basis-full text-sm text-income empty:hidden">
        {status}
      </p>
      {open && (
        <div id={panelId} className="basis-full pt-1">
          <RenameForm group={group} onCancel={() => close()} onRenamed={(m) => close(m ?? "")} />
        </div>
      )}
    </>
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
    <form action={formAction} noValidate className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor={id}>Name of “{group.name}”</Label>
        <Input
          ref={inputRef}
          id={id}
          name="name"
          required
          maxLength={MAX_GROUP_NAME}
          autoComplete="off"
          defaultValue={state.values?.name ?? group.name}
          error={error}
          className="w-full not-aria-[invalid=true]:border-accent"
        />
        <FieldError id={id}>{error}</FieldError>
      </div>
      <ColorChoice idPrefix={`${id}-color`} defaultValue={state.values?.color ?? group.color} />
      <FieldError id={`${id}-color`}>{state.fieldErrors?.color}</FieldError>
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
    <form action={formAction} noValidate className="space-y-3 border-t border-surface-muted px-4 py-3.5 sm:px-[18px]">
      <div className="space-y-1.5">
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
      </div>
      {/* The colour of the new group; after a success the form resets to None. */}
      <ColorChoice idPrefix="new-group-color" defaultValue={state.ok ? "" : state.values?.color} />
      <FieldError id="new-group-color">{state.fieldErrors?.color}</FieldError>
      {state.message && !state.ok && (
        <p role="alert" className="text-sm text-danger">
          {state.message}
        </p>
      )}
    </form>
  );
}
