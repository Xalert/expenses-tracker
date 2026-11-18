import "server-only";
import { cookies } from "next/headers";
import { cache } from "react";
import { requireUser } from "@/lib/auth";
import { GROUP_COOKIE } from "@/lib/group-cookie";
import { listWalletGroups, type WalletGroupView } from "@/server/wallet-groups";

export { GROUP_COOKIE };

export type GroupScope = {
  /** The unarchived groups, by position: what the switcher and the group pickers offer. */
  groups: WalletGroupView[];
  /** The archived groups, by position (the Wallets page lists them on their own). */
  archivedGroups: WalletGroupView[];
  /** The selected group (never an archived one), or null for All. */
  selected: WalletGroupView | null;
};

/** The cookie value as a group id, or null (missing, empty, not a positive integer). Pure; exported for tests. */
export function parseGroupCookie(value: string | undefined): number | null {
  const id = value && /^[1-9]\d{0,14}$/.test(value) ? Number(value) : null;
  return id !== null && id <= 2147483647 ? id : null; // a Postgres integer
}

/**
 * Split the user's groups and resolve the cookie's id: an id that is not one of the user's unarchived groups (stale,
 * foreign, or archived since it was chosen) means All. Pure; exported for tests.
 */
export function resolveGroupScope(all: WalletGroupView[], cookieId: number | null): GroupScope {
  const groups = all.filter((g) => g.archivedAt === null);
  const archivedGroups = all.filter((g) => g.archivedAt !== null);
  return {
    groups,
    archivedGroups,
    selected: cookieId === null ? null : (groups.find((g) => g.id === cookieId) ?? null),
  };
}

/**
 * The signed-in user's groups and the one selected by the `et_group` cookie. No cookie, an empty value or an id that
 * is not one of the user's unarchived groups means All (`selected: null`). The one place that reads the cookie.
 */
export const getGroupScope = cache(async (): Promise<GroupScope> => {
  const user = await requireUser();
  const all = await listWalletGroups(user.id);
  return resolveGroupScope(all, parseGroupCookie((await cookies()).get(GROUP_COOKIE)?.value));
});
