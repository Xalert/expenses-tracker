"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useRef, useSyncExternalStore } from "react";
import { selectGroupAction } from "@/app/(app)/actions";
import { Select } from "@/components/ui";

export type GroupSwitcherProps = {
  groups: { id: number; name: string }[];
  /** The selected group's id, or null for "All groups". */
  selectedId: number | null;
};

const noop = () => () => {};

/**
 * The top bar's wallet-group switcher: "All groups" plus each group. A plain form posting to `selectGroupAction`, so
 * it works without JavaScript (a visible "Go" button); with JavaScript the select submits on change and the button
 * is visually hidden. Renders nothing for fewer than two groups. The current path and query go along as `returnTo`.
 */
export function GroupSwitcher({ groups, selectedId }: GroupSwitcherProps) {
  const pathname = usePathname();
  // A new group starts on page 1, and a `wallet` filter would override the group (it wins), so neither is kept.
  const params = new URLSearchParams(useSearchParams().toString());
  params.delete("page");
  params.delete("wallet");
  const search = params.toString();
  const formRef = useRef<HTMLFormElement>(null);
  const hydrated = useSyncExternalStore(
    noop,
    () => true,
    () => false,
  );
  if (groups.length < 2) return null;

  return (
    <form ref={formRef} action={selectGroupAction} className="flex shrink-0 items-center gap-2">
      <input type="hidden" name="returnTo" value={search ? `${pathname}?${search}` : pathname} />
      <label htmlFor="group-switcher" className="sr-only">
        Group
      </label>
      <Select
        id="group-switcher"
        name="groupId"
        // Uncontrolled and keyed on the selection: the page behind re-renders with the new cookie.
        key={selectedId ?? "all"}
        defaultValue={selectedId === null ? "" : String(selectedId)}
        onChange={() => formRef.current?.requestSubmit()}
        className="h-10 max-w-44 rounded-full! pl-3.5 text-[13px] font-semibold"
      >
        <option value="">All groups</option>
        {groups.map((g) => (
          <option key={g.id} value={g.id}>
            {g.name}
          </option>
        ))}
      </Select>
      <button
        type="submit"
        className={
          hydrated
            ? "sr-only"
            : "h-10 rounded-full border border-border px-3 text-[13px] font-semibold text-foreground hover:bg-surface-muted"
        }
      >
        Go
      </button>
    </form>
  );
}
