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
import { parseCreateWallet, parseUpdateWallet, parseWalletId } from "./form-input";

const NOT_FOUND_STATE: FormState = { message: "Wallet not found." };

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
    walletId = createWallet(user.id, parsed.data).id;
  } catch (err) {
    return serviceErrorState(err, values);
  }
  revalidateWallet(walletId);
  redirect(`/wallets/${walletId}`);
}

/** Bind the wallet id: `updateWalletAction.bind(null, id)`. */
export async function updateWalletAction(walletIdArg: number, _prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  const values = formValues(formData);
  const walletId = parseWalletId(walletIdArg);
  const wallet = walletId ? getWallet(user.id, walletId) : null;
  if (!wallet) return { ...NOT_FOUND_STATE, values };

  const parsed = parseUpdateWallet(formData, values, wallet.currency);
  if (!parsed.ok) return parsed.state;

  try {
    updateWallet(user.id, wallet.id, parsed.data);
  } catch (err) {
    return serviceErrorState(err, values);
  }
  revalidateWallet(wallet.id);
  redirect(`/wallets/${wallet.id}`);
}

/** Bind the wallet id. Stays on the current page. */
export async function archiveWalletAction(walletIdArg: number): Promise<FormState> {
  const user = await requireUser();
  const walletId = parseWalletId(walletIdArg);
  if (!walletId) return NOT_FOUND_STATE;
  try {
    archiveWallet(user.id, walletId);
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
    unarchiveWallet(user.id, walletId);
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
    deleteWallet(user.id, walletId);
  } catch (err) {
    return serviceErrorState(err);
  }
  revalidateWallet();
  redirect("/wallets");
}
