import "server-only";
import { cookies } from "next/headers";
import { cache } from "react";
import { requireUser } from "@/lib/auth";
import { GROUP_COOKIE } from "@/lib/group-cookie";
import { listWalletGroups, type WalletGroupView } from "@/server/wallet-groups";

export { GROUP_COOKIE };

export type GroupScope = { groups: WalletGroupView[]; selected: WalletGroupView | null };

/** The cookie value as a group id, or null (missing, empty, not a positive integer). Pure; exported for tests. */
export function parseGroupCookie(value: string | undefined): number | null {
  const id = value && /^[1-9]\d{0,14}$/.test(value) ? Number(value) : null;
  return id !== null && id <= 2147483647 ? id : null; // a Postgres integer
}

/**
 * The signed-in user's groups and the one selected by the `et_group` cookie. No cookie, an empty value or an id that
 * is not one of the user's groups means All (`selected: null`). The one place that reads the cookie.
 */
export const getGroupScope = cache(async (): Promise<GroupScope> => {
  const user = await requireUser();
  const groups = await listWalletGroups(user.id);
  const id = parseGroupCookie((await cookies()).get(GROUP_COOKIE)?.value);
  return { groups, selected: id === null ? null : (groups.find((g) => g.id === id) ?? null) };
});
