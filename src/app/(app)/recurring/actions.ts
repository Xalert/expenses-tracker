"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { isValidDate, todayInZone } from "@/lib/dates";
import { isServiceError } from "@/lib/errors";
import { formValues, serviceErrorState, type FormState } from "@/lib/form";
import { currencyDecimals, parseAmount } from "@/lib/money";
import { MAX_RECURRING_INTERVAL, isFrequency } from "@/lib/recurrence";
import {
  deleteRecurring,
  pauseRecurring,
  resumeRecurring,
  updateRecurring,
} from "@/server/recurring";
import { getWallet } from "@/server/wallets";

const LIST = "/recurring";

/** The rule id posted by the list's plain forms (`id`), or null. */
function ruleIdOf(formData: FormData): number | null {
  const raw = formData.get("id");
  return typeof raw === "string" && /^[1-9]\d{0,9}$/.test(raw) && Number(raw) <= 2147483647 ? Number(raw) : null;
}

/** Bound ids arrive from the client like any other argument: re-check them. */
function assertBoundId(value: unknown): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error("Invalid id.");
  return n;
}

/** Pause / resume / delete change what every page may show next (entries are created on resume). */
function revalidateAll() {
  revalidatePath("/", "layout");
}

/**
 * Plain form actions of the /recurring rows (`id`). A rule that is gone, or a resume refused because its wallet or
 * category is archived (the row already says why), just reloads the list.
 */
async function run(formData: FormData, fn: (userId: number, id: number, today: string) => Promise<unknown>) {
  const user = await requireUser();
  const id = ruleIdOf(formData);
  if (id !== null) {
    try {
      await fn(user.id, id, todayInZone(user.timeZone));
    } catch (err) {
      if (!isServiceError(err) || (err.code !== "NOT_FOUND" && err.code !== "VALIDATION")) throw err;
    }
    revalidateAll();
  }
  redirect(`${LIST}${id !== null ? `#rule-${id}` : ""}`);
}

export async function pauseRecurringAction(formData: FormData): Promise<void> {
  await run(formData, (userId, id) => pauseRecurring(userId, id));
}

export async function resumeRecurringAction(formData: FormData): Promise<void> {
  await run(formData, (userId, id, today) => resumeRecurring(userId, id, today));
}

/** `ConfirmDeleteForm` posts `id` and `returnTo` (ignored: back to the list). The rule's entries stay. */
export async function deleteRecurringAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = ruleIdOf(formData);
  if (id !== null) {
    try {
      await deleteRecurring(user.id, id);
    } catch (err) {
      if (!isServiceError(err) || err.code !== "NOT_FOUND") throw err;
    }
    revalidateAll();
  }
  redirect(LIST);
}

/**
 * The edit form (`/recurring/<id>/edit`): `walletId`, `categoryId`, `amount` (in the chosen wallet's currency, looked
 * up server-side), `note`, `frequency`, `interval`, `nextDate`, `endDate` (empty = no end). Errors land on those
 * names; on success back to the list.
 */
export async function updateRecurringAction(ruleId: number, _prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  ruleId = assertBoundId(ruleId);
  const values = formValues(formData);
  const fieldErrors: Record<string, string> = {};
  const str = (name: string) => {
    const v = formData.get(name);
    return typeof v === "string" ? v.trim() : "";
  };
  const id = (name: string) => (/^[1-9]\d{0,9}$/.test(str(name)) ? Number(str(name)) : null);

  const walletId = id("walletId");
  const categoryId = id("categoryId");
  if (walletId === null) fieldErrors.walletId = "Choose a wallet.";
  if (categoryId === null) fieldErrors.categoryId = "Choose a category.";
  const frequency = str("frequency");
  if (!isFrequency(frequency)) fieldErrors.frequency = "Choose how often it repeats.";
  const interval = /^\d{1,3}$/.test(str("interval")) ? Number(str("interval")) : NaN;
  if (!(interval >= 1 && interval <= MAX_RECURRING_INTERVAL)) {
    fieldErrors.interval = `Enter a whole number from 1 to ${MAX_RECURRING_INTERVAL}.`;
  }
  const nextDate = str("nextDate");
  if (!isValidDate(nextDate)) fieldErrors.nextDate = "Enter the date of the next entry.";
  const endDate = str("endDate");
  if (endDate !== "" && !isValidDate(endDate)) fieldErrors.endDate = "Enter a valid end date.";
  const note = str("note");
  if (note.length > 500) fieldErrors.note = "Keep the note to 500 characters or fewer.";

  let amountMinor: number | null = null;
  if (!str("amount")) fieldErrors.amount = "Enter an amount.";
  else if (walletId !== null) {
    // The currency comes from the wallet looked up server-side, never from the client.
    const wallet = await getWallet(user.id, walletId);
    if (!wallet) fieldErrors.walletId = "Wallet not found.";
    else {
      const minor = parseAmount(str("amount"), wallet.currency);
      const decimals = currencyDecimals(wallet.currency);
      if (minor === null) {
        fieldErrors.amount =
          decimals === 0
            ? `Enter a whole amount in ${wallet.currency} (no decimals).`
            : `Enter a valid amount in ${wallet.currency} (up to ${decimals} decimals).`;
      } else if (minor <= 0) fieldErrors.amount = "Enter an amount greater than zero.";
      else amountMinor = minor;
    }
  }
  if (Object.keys(fieldErrors).length > 0 || amountMinor === null || !isFrequency(frequency)) {
    return { message: "Please fix the highlighted fields.", fieldErrors, values };
  }

  try {
    await updateRecurring(
      user.id,
      ruleId,
      {
        walletId: walletId!,
        categoryId: categoryId!,
        amountMinor,
        note: note || null,
        frequency,
        interval,
        nextDate,
        endDate: endDate || null,
      },
      todayInZone(user.timeZone),
    );
  } catch (err) {
    return serviceErrorState(err, values);
  }
  revalidateAll();
  redirect(`${LIST}#rule-${ruleId}`);
}
