import "server-only";
import type { CategoryOption, WalletOption } from "@/components/transactions/entry-form";
import { listCategories } from "@/server/categories";
import { listWalletGroups } from "@/server/wallet-groups";
import { getWallet, listWallets, type WalletView } from "@/server/wallets";

const toOption = (w: WalletView, grouped: boolean): WalletOption => ({
  id: w.id,
  name: w.name,
  currency: w.currency,
  archived: w.archivedAt !== null,
  ...(grouped ? { groupName: w.groupName } : {}),
});

/**
 * Picker options for `wallets`. With `grouped` (the user has two or more groups) they carry `groupName` and come
 * ordered by group name (then as given), so the pickers can show one <optgroup> per group.
 */
export function toWalletOptions(wallets: WalletView[], grouped: boolean): WalletOption[] {
  const list = [...wallets];
  if (grouped) {
    list.sort((a, b) => a.groupName.localeCompare(b.groupName, undefined, { sensitivity: "base" }) || a.groupId - b.groupId);
  }
  return list.map((w) => toOption(w, grouped));
}

/**
 * Active wallets, plus the given (possibly archived) wallets an existing entry already uses. Never narrowed by the
 * selected group (a transfer can cross groups); see `toWalletOptions` for the grouping.
 */
export function walletOptions(userId: number, keepWalletIds: number[] = []): WalletOption[] {
  const active = listWallets(userId);
  const extra = keepWalletIds
    .filter((id, i, all) => all.indexOf(id) === i && !active.some((w) => w.id === id))
    .map((id) => getWallet(userId, id))
    .filter((w): w is WalletView => w !== null);
  return toWalletOptions([...active, ...extra], listWalletGroups(userId).length >= 2);
}

export function categoryOptions(userId: number): CategoryOption[] {
  return listCategories(userId).map(({ id, name, kind }) => ({ id, name, kind }));
}

/** First value of a search param. */
export function param(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Positive integer id from a route/search param, else null. */
export function parseId(value: string | string[] | undefined): number | null {
  const v = param(value);
  if (!v || !/^[1-9]\d{0,14}$/.test(v)) return null;
  return Number(v);
}
