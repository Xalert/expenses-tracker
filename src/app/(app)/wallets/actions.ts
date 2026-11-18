"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { formValues, serviceErrorState, type FormState } from "@/lib/form";
import {
  archiveWallet,
  createWallet,
  deleteWallet,
  getWallet,
  unarchiveWallet,
  updateWallet,
} from "@/server/wallets";
import {
  archiveWalletGroup,
  createWalletGroup,
  deleteWalletGroup,
  getWalletGroup,
  moveWalletGroup,
  renameWalletGroup,
  unarchiveWalletGroup,
} from "@/server/wallet-groups";
import {
  groupColorField,
  groupNameField,
  parseCreateWallet,
  parseGroupId,
  parseUpdateWallet,
  parseWalletId,
} from "./form-input";

const NOT_FOUND_STATE: FormState = { message: "Wallet not found." };

/**
 * The wallet dialogs (`@modal/(.)wallets/new`, `@modal/(.)wallets/[id]/edit`) post a hidden `mode=dialog`: the create
 * and update actions then return `{ ok: true, message }` instead of redirecting, and the form closes the dialog
 * (`router.back()`, then `router.refresh()`). The full pages never send it and keep redirecting.
 */
function isDialogMode(formData: FormData): boolean {
  return formData.get("mode") === "dialog";
}

/** After a save from a dialog: it can sit over any page, and wallets show on most of them. */
function savedInDialog(message: string): FormState {
  revalidatePath("/", "layout");
  return { ok: true, message };
}

function revalidateWallet(walletId?: number) {
  revalidatePath("/");
  revalidatePath("/wallets");
  if (walletId) revalidatePath(`/wallets/${walletId}`);
}

export async function createWalletAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  const values = formValues(formData);
  const parsed = parseCreateWallet(formData, values);
  if (!parsed.ok) return parsed.state;

  let walletId: number;
  try {
    walletId = (await createWallet(user.id, parsed.data)).id;
  } catch (err) {
    return serviceErrorState(err, values);
  }
  if (isDialogMode(formData)) return savedInDialog(`Created ${parsed.data.name} (${parsed.data.currency})`);
  revalidateWallet(walletId);
  redirect(`/wallets/${walletId}`);
}

/** Bind the wallet id: `updateWalletAction.bind(null, id)`. */
export async function updateWalletAction(walletIdArg: number, _prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  const values = formValues(formData);
  const walletId = parseWalletId(walletIdArg);
  const wallet = walletId ? await getWallet(user.id, walletId) : null;
  if (!wallet) return { ...NOT_FOUND_STATE, values };

  const parsed = parseUpdateWallet(formData, values, wallet.currency);
  if (!parsed.ok) return parsed.state;

  try {
    await updateWallet(user.id, wallet.id, parsed.data);
  } catch (err) {
    return serviceErrorState(err, values);
  }
  if (isDialogMode(formData)) return savedInDialog(`Saved ${parsed.data.name}`);
  revalidateWallet(wallet.id);
  redirect(`/wallets/${wallet.id}`);
}

/** Bind the wallet id. Stays on the current page. */
export async function archiveWalletAction(walletIdArg: number): Promise<FormState> {
  const user = await requireUser();
  const walletId = parseWalletId(walletIdArg);
  if (!walletId) return NOT_FOUND_STATE;
  try {
    await archiveWallet(user.id, walletId);
  } catch (err) {
    return serviceErrorState(err);
  }
  revalidateWallet(walletId);
  return { ok: true };
}

/** Bind the wallet id. Stays on the current page. */
export async function unarchiveWalletAction(walletIdArg: number): Promise<FormState> {
  const user = await requireUser();
  const walletId = parseWalletId(walletIdArg);
  if (!walletId) return NOT_FOUND_STATE;
  try {
    await unarchiveWallet(user.id, walletId);
  } catch (err) {
    return serviceErrorState(err);
  }
  revalidateWallet(walletId);
  return { ok: true };
}

/** Bind the wallet id. Refused (CONFLICT) when the wallet has transactions; redirects to /wallets on success. */
export async function deleteWalletAction(walletIdArg: number): Promise<FormState> {
  const user = await requireUser();
  const walletId = parseWalletId(walletIdArg);
  if (!walletId) return NOT_FOUND_STATE;
  try {
    await deleteWallet(user.id, walletId);
  } catch (err) {
    return serviceErrorState(err);
  }
  revalidateWallet();
  redirect("/wallets");
}

const GROUP_NOT_FOUND_STATE: FormState = { message: "Group not found. It may have been deleted already." };

/** Group names show in the top bar's switcher (the layout) and on every page that names a group. */
function revalidateGroups() {
  revalidatePath("/", "layout");
}

/** The "New group" input on the Wallets page. Stays on the page. */
export async function createGroupAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  const values = formValues(formData);
  let name: string;
  try {
    name = (await createWalletGroup(user.id, { name: groupNameField(formData), color: groupColorField(formData) ?? null }))
      .name;
  } catch (err) {
    return serviceErrorState(err, values);
  }
  revalidateGroups();
  return { ok: true, message: `Added the group “${name}”.` };
}

/** Bind the group id. Renames and sets the colour (a form without a `color` field keeps it). Stays on the page. */
export async function renameGroupAction(groupIdArg: number, _prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  const values = formValues(formData);
  const groupId = parseGroupId(groupIdArg);
  if (!groupId) return { ...GROUP_NOT_FOUND_STATE, values };
  let name: string;
  try {
    name = (await renameWalletGroup(user.id, groupId, { name: groupNameField(formData), color: groupColorField(formData) }))
      .name;
  } catch (err) {
    return serviceErrorState(err, values);
  }
  revalidateGroups();
  return { ok: true, message: `Renamed to “${name}”.` };
}

/** Bind the group id. Refused (CONFLICT) while the group has wallets or when it is the last one. Stays on the page. */
export async function deleteGroupAction(groupIdArg: number): Promise<FormState> {
  const user = await requireUser();
  const groupId = parseGroupId(groupIdArg);
  const group = groupId ? await getWalletGroup(user.id, groupId) : null;
  if (!group) {
    revalidateGroups();
    return GROUP_NOT_FOUND_STATE;
  }
  try {
    await deleteWalletGroup(user.id, group.id);
  } catch (err) {
    return serviceErrorState(err);
  }
  revalidateGroups();
  return { ok: true, message: `Deleted the group “${group.name}”.` };
}

/**
 * Bind the group id and "up" / "down". A plain form action (it works without JavaScript): moves the group one place
 * among the groups of the same archived state (nothing at either end), then reloads /wallets. A missing group or a
 * bad direction changes nothing.
 */
export async function moveGroupAction(groupIdArg: number, direction: string): Promise<void> {
  const user = await requireUser();
  const groupId = parseGroupId(groupIdArg);
  if (groupId && (direction === "up" || direction === "down")) {
    try {
      await moveWalletGroup(user.id, groupId, direction);
    } catch {
      // NOT_FOUND (deleted meanwhile): the reloaded page shows the current order.
    }
  }
  revalidateGroups();
  redirect("/wallets");
}

/** Bind the group id. Refused (CONFLICT) for the last unarchived group. Stays on the page. */
export async function archiveGroupAction(groupIdArg: number): Promise<FormState> {
  const user = await requireUser();
  const groupId = parseGroupId(groupIdArg);
  if (!groupId) return GROUP_NOT_FOUND_STATE;
  let name: string;
  try {
    name = (await archiveWalletGroup(user.id, groupId)).name;
  } catch (err) {
    return serviceErrorState(err);
  }
  revalidateGroups();
  return { ok: true, message: `Archived the group “${name}”.` };
}

/** Bind the group id. Stays on the page. */
export async function unarchiveGroupAction(groupIdArg: number): Promise<FormState> {
  const user = await requireUser();
  const groupId = parseGroupId(groupIdArg);
  if (!groupId) return GROUP_NOT_FOUND_STATE;
  let name: string;
  try {
    name = (await unarchiveWalletGroup(user.id, groupId)).name;
  } catch (err) {
    return serviceErrorState(err);
  }
  revalidateGroups();
  return { ok: true, message: `Unarchived the group “${name}”.` };
}
