"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { isValidDate } from "@/lib/dates";
import { isServiceError } from "@/lib/errors";
import { formValues, serviceErrorState, zodErrorState, type FormState } from "@/lib/form";
import { currencyDecimals, formatMoney, parseAmount } from "@/lib/money";
import { safeReturnTo } from "@/lib/return-to";
import {
  createTransaction,
  deleteTransaction,
  getTransaction,
  updateTransaction,
  type TransactionInput,
  type TransactionView,
} from "@/server/transactions";
import {
  createTransfer,
  deleteTransfer,
  getTransfer,
  updateTransfer,
  type TransferInput,
  type TransferView,
} from "@/server/transfers";
import { getWallet } from "@/server/wallets";

// ---------------------------------------------------------------------------------------------
// Parsing

const id = (message: string) =>
  z
    .string({ error: message })
    .regex(/^[1-9]\d{0,14}$/, message)
    .transform(Number);

const common = {
  amount: z.string({ error: "Enter an amount." }).trim().min(1, "Enter an amount."),
  date: z.string({ error: "Enter a date." }).refine(isValidDate, "Enter a valid date."),
  note: z.string().max(500, "Keep the note under 500 characters.").optional(),
};

const transactionSchema = z.object({
  kind: z.enum(["expense", "income"], { error: "Choose expense or income." }),
  walletId: id("Choose a wallet."),
  categoryId: id("Choose a category."),
  ...common,
});

const transferSchema = z.object({
  fromWalletId: id("Choose the wallet the money leaves."),
  toWalletId: id("Choose the wallet the money goes to."),
  receivedAmount: z.string().trim().optional(),
  ...common,
});

/** Minor units > 0, or an error message naming the currency's precision. */
function amountFor(raw: string, currency: string): { minor: number } | { error: string } {
  const minor = parseAmount(raw, currency);
  if (minor === null) {
    const decimals = currencyDecimals(currency);
    return {
      error:
        decimals === 0
          ? `Enter a whole amount in ${currency} (no decimals).`
          : `Enter a valid amount in ${currency} (up to ${decimals} decimals).`,
    };
  }
  if (minor <= 0) return { error: "Enter an amount greater than zero." };
  return { minor };
}

/** Bound ids arrive from the client like any other argument: re-check them. */
function assertBoundId(value: unknown): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error("Invalid id.");
  return n;
}

function returnToOf(formData: FormData): string {
  return safeReturnTo(formData.get("returnTo"));
}

/**
 * The Add dialog posts `mode=dialog`: the create actions then return `{ ok: true, message }` instead of
 * redirecting, and the form closes the dialog (or clears itself for another entry) on the client.
 */
function isDialogMode(formData: FormData): boolean {
  return formData.get("mode") === "dialog";
}

/** After a save from the dialog: every signed-in page may show the new entry (balances, lists, charts). */
function savedInDialog(message: string): FormState {
  revalidatePath("/", "layout");
  return { ok: true, message };
}

function revalidateAll(walletIds: Iterable<number>) {
  revalidatePath("/");
  revalidatePath("/transactions");
  revalidatePath("/wallets");
  for (const w of new Set(walletIds)) revalidatePath(`/wallets/${w}`);
}

type Parsed<T> = { ok: true; input: T } | { ok: false; state: FormState };

function parseTransaction(userId: number, formData: FormData, values: Record<string, string>): Parsed<TransactionInput> {
  const parsed = transactionSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { ok: false, state: zodErrorState(parsed.error, values) };
  const d = parsed.data;
  // The currency comes from the wallet looked up server-side, never from the client.
  const wallet = getWallet(userId, d.walletId);
  if (!wallet) return { ok: false, state: { fieldErrors: { walletId: "Wallet not found." }, values } };
  const amount = amountFor(d.amount, wallet.currency);
  if ("error" in amount) return { ok: false, state: { fieldErrors: { amount: amount.error }, values } };
  return {
    ok: true,
    input: {
      kind: d.kind,
      walletId: d.walletId,
      categoryId: d.categoryId,
      amountMinor: amount.minor,
      date: d.date,
      note: d.note ?? null,
    },
  };
}

function parseTransfer(userId: number, formData: FormData, values: Record<string, string>): Parsed<TransferInput> {
  const parsed = transferSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { ok: false, state: zodErrorState(parsed.error, values) };
  const d = parsed.data;
  if (d.fromWalletId === d.toWalletId) {
    return { ok: false, state: { fieldErrors: { toWalletId: "Choose two different wallets." }, values } };
  }
  const from = getWallet(userId, d.fromWalletId);
  const to = getWallet(userId, d.toWalletId);
  const fieldErrors: Record<string, string> = {};
  if (!from) fieldErrors.fromWalletId = "Wallet not found.";
  if (!to) fieldErrors.toWalletId = "Wallet not found.";
  if (!from || !to) return { ok: false, state: { fieldErrors, values } };

  const sent = amountFor(d.amount, from.currency);
  if ("error" in sent) fieldErrors.amount = sent.error;
  let receivedAmountMinor: number | null = null;
  if (from.currency !== to.currency) {
    if (!d.receivedAmount) {
      fieldErrors.receivedAmount = `Enter the amount received in ${to.currency}.`;
    } else {
      const received = amountFor(d.receivedAmount, to.currency);
      if ("error" in received) fieldErrors.receivedAmount = received.error;
      else receivedAmountMinor = received.minor;
    }
  }
  if ("error" in sent || Object.keys(fieldErrors).length) return { ok: false, state: { fieldErrors, values } };
  return {
    ok: true,
    input: {
      fromWalletId: d.fromWalletId,
      toWalletId: d.toWalletId,
      amountMinor: sent.minor,
      receivedAmountMinor,
      date: d.date,
      note: d.note ?? null,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Expense / income

export async function createTransactionAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  const values = formValues(formData);
  const parsed = parseTransaction(user.id, formData, values);
  if (!parsed.ok) return parsed.state;
  let created: TransactionView;
  try {
    created = createTransaction(user.id, parsed.input);
  } catch (err) {
    return serviceErrorState(err, values);
  }
  if (isDialogMode(formData)) {
    const amount = formatMoney(created.amountMinor, created.currency);
    return savedInDialog(`Added ${amount} to ${created.categoryName ?? created.walletName}`);
  }
  revalidateAll([parsed.input.walletId]);
  redirect(returnToOf(formData));
}

export async function updateTransactionAction(
  transactionId: number,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireUser();
  transactionId = assertBoundId(transactionId);
  const values = formValues(formData);
  const parsed = parseTransaction(user.id, formData, values);
  if (!parsed.ok) return parsed.state;
  const previous = getTransaction(user.id, transactionId);
  try {
    updateTransaction(user.id, transactionId, parsed.input);
  } catch (err) {
    return serviceErrorState(err, values);
  }
  revalidateAll([parsed.input.walletId, ...(previous ? [previous.walletId] : [])]);
  redirect(returnToOf(formData));
}

/** Plain form action (`id`, `returnTo` fields). Already-deleted rows are treated as done. */
export async function deleteTransactionAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const transactionId = Number(formData.get("id"));
  const existing = Number.isSafeInteger(transactionId) && transactionId > 0 ? getTransaction(user.id, transactionId) : null;
  if (existing) {
    try {
      deleteTransaction(user.id, transactionId);
    } catch (err) {
      if (!isServiceError(err) || err.code !== "NOT_FOUND") throw err;
    }
    revalidateAll([existing.walletId]);
  }
  redirect(returnToOf(formData));
}

// ---------------------------------------------------------------------------------------------
// Transfers

export async function createTransferAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  const values = formValues(formData);
  const parsed = parseTransfer(user.id, formData, values);
  if (!parsed.ok) return parsed.state;
  let created: TransferView;
  try {
    created = createTransfer(user.id, parsed.input);
  } catch (err) {
    return serviceErrorState(err, values);
  }
  if (isDialogMode(formData)) {
    const amount = formatMoney(created.from.amountMinor, created.from.currency);
    return savedInDialog(`Moved ${amount} from ${created.from.walletName} to ${created.to.walletName}`);
  }
  revalidateAll([parsed.input.fromWalletId, parsed.input.toWalletId]);
  redirect(returnToOf(formData));
}

export async function updateTransferAction(
  transferId: number,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireUser();
  transferId = assertBoundId(transferId);
  const values = formValues(formData);
  const parsed = parseTransfer(user.id, formData, values);
  if (!parsed.ok) return parsed.state;
  const previous = getTransfer(user.id, transferId);
  try {
    updateTransfer(user.id, transferId, parsed.input);
  } catch (err) {
    return serviceErrorState(err, values);
  }
  revalidateAll([
    parsed.input.fromWalletId,
    parsed.input.toWalletId,
    ...(previous ? [previous.from.walletId, previous.to.walletId] : []),
  ]);
  redirect(returnToOf(formData));
}

/** Plain form action (`id` = transfer id, `returnTo`). Removes the transfer and both legs. */
export async function deleteTransferAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const transferId = Number(formData.get("id"));
  const existing = Number.isSafeInteger(transferId) && transferId > 0 ? getTransfer(user.id, transferId) : null;
  if (existing) {
    try {
      deleteTransfer(user.id, transferId);
    } catch (err) {
      if (!isServiceError(err) || err.code !== "NOT_FOUND") throw err;
    }
    revalidateAll([existing.from.walletId, existing.to.walletId]);
  }
  redirect(returnToOf(formData));
}
