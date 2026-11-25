import "server-only";
import type { CategoryOption, EntryInitialValues, WalletOption } from "@/components/transactions/entry-form";
import type { TagOption } from "@/components/transactions/tags-field";
import { minorToInputValue } from "@/lib/money";
import { joinTags } from "@/lib/tags";
import { listCategories, type CategoryView } from "@/server/categories";
import { listTags, type TagView } from "@/server/tags";
import { listWalletGroups } from "@/server/wallet-groups";
import { getTransaction } from "@/server/transactions";
import { getTransfer } from "@/server/transfers";
import { getWallet, listWallets, type WalletView } from "@/server/wallets";

const toOption = (w: WalletView, grouped: boolean): WalletOption => ({
  id: w.id,
  name: w.name,
  currency: w.currency,
  // A wallet of an archived group counts as archived (it is only offered when an entry already uses it).
  archived: w.archivedAt !== null || w.groupArchived,
  ...(grouped ? { groupName: w.groupName } : {}),
});

/**
 * Picker options for `wallets`. With `grouped` (the user has two or more unarchived groups) they carry `groupName`
 * and come ordered by group position (then as given), so the pickers can show one <optgroup> per group.
 */
export function toWalletOptions(wallets: WalletView[], grouped: boolean): WalletOption[] {
  const list = [...wallets];
  if (grouped) {
    list.sort((a, b) => a.groupPosition - b.groupPosition || a.groupId - b.groupId);
  }
  return list.map((w) => toOption(w, grouped));
}

/**
 * Active wallets, plus the given (possibly archived) wallets an existing entry already uses. Never narrowed by the
 * selected group (a transfer can cross groups); see `toWalletOptions` for the grouping.
 */
export async function walletOptions(userId: number, keepWalletIds: number[] = []): Promise<WalletOption[]> {
  const active = await listWallets(userId);
  const extra = (
    await Promise.all(
      keepWalletIds
        .filter((id, i, all) => all.indexOf(id) === i && !active.some((w) => w.id === id))
        .map((id) => getWallet(userId, id)),
    )
  ).filter((w): w is WalletView => w !== null);
  const openGroups = (await listWalletGroups(userId)).filter((g) => g.archivedAt === null);
  return toWalletOptions([...active, ...extra], openGroups.length >= 2);
}

/**
 * Picker options for `categories`: an archived one is flagged and labelled "Name (archived)", so a list that keeps it
 * (history filters, an entry that already uses it) shows why it is there.
 */
export function toCategoryOptions(categories: CategoryView[]): CategoryOption[] {
  return categories.map(({ id, name, kind, archivedAt, color }) => {
    const option: CategoryOption = archivedAt ? { id, name: `${name} (archived)`, kind, archived: true } : { id, name, kind };
    return color ? { ...option, color } : option;
  });
}

/**
 * Active categories, plus the given (possibly archived) categories an existing entry already uses, like
 * `walletOptions`: an archived category is hidden from the pickers but stays selected on the entry that has it.
 */
export async function categoryOptions(userId: number, keepCategoryIds: (number | null)[] = []): Promise<CategoryOption[]> {
  const keep = new Set(keepCategoryIds.filter((id): id is number => id !== null));
  const all = await listCategories(userId, undefined, { includeArchived: keep.size > 0 });
  return toCategoryOptions(all.filter((c) => !c.archivedAt || keep.has(c.id)));
}

/** The entry form's Tags suggestions: every tag of the user with its use count. */
export function toTagOptions(list: TagView[]): TagOption[] {
  return list.map((t) => ({ name: t.name, count: t.transactionCount }));
}

export async function tagOptions(userId: number): Promise<TagOption[]> {
  return toTagOptions(await listTags(userId));
}

/** First value of a search param. */
export function param(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Positive integer id from a route/search param, else null. */
export function parseId(value: string | string[] | undefined): number | null {
  const v = param(value);
  if (!v || !/^[1-9]\d{0,14}$/.test(v)) return null;
  const id = Number(v);
  return id <= 2147483647 ? id : null; // a Postgres integer
}

type Initial = EntryInitialValues;

/**
 * `?from=<id>` ("Duplicate" in an open row): the Add form's starting values copied from that entry of the user's —
 * kind, wallet, category, amount, note and tags, or for a transfer leg its transfer's wallets and amounts — dated
 * `today`. A wallet or category the form does not offer (archived) is left unselected; the repeating rule is never
 * copied. Null for a missing or another user's id (the empty form shows).
 */
export async function duplicateInitial(
  userId: number,
  fromId: number | null,
  today: string,
  offered: { wallets: WalletOption[]; categories: CategoryOption[] },
): Promise<Initial | null> {
  if (fromId === null) return null;
  const t = await getTransaction(userId, fromId);
  if (!t) return null;
  const walletOk = (id: number) => offered.wallets.some((w) => w.id === id && !w.archived);
  if (t.transferId !== null) {
    const tr = await getTransfer(userId, t.transferId);
    if (!tr) return null;
    return {
      kind: "transfer",
      fromWalletId: walletOk(tr.from.walletId) ? tr.from.walletId : undefined,
      toWalletId: walletOk(tr.to.walletId) ? tr.to.walletId : undefined,
      amount: minorToInputValue(tr.from.amountMinor, tr.from.currency),
      receivedAmount: tr.from.currency !== tr.to.currency ? minorToInputValue(tr.to.amountMinor, tr.to.currency) : undefined,
      date: today,
      note: tr.note ?? "",
    };
  }
  const kind = t.kind === "income" ? "income" : "expense";
  const categoryOk = offered.categories.some((c) => c.id === t.categoryId && c.kind === kind && !c.archived);
  return {
    kind,
    walletId: walletOk(t.walletId) ? t.walletId : undefined,
    categoryId: categoryOk ? (t.categoryId ?? undefined) : undefined,
    amount: minorToInputValue(t.amountMinor, t.currency),
    date: today,
    note: t.note ?? "",
    tags: joinTags(t.tags),
  };
}
