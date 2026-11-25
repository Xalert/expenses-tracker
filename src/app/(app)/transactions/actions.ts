"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { isValidDate, todayInZone } from "@/lib/dates";
import { isServiceError } from "@/lib/errors";
import { formValues, serviceErrorState, zodErrorState, type FormState } from "@/lib/form";
import { currencyDecimals, formatMoney, parseAmount } from "@/lib/money";
import { MAX_RECURRING_INTERVAL, describeSchedule, isFrequency } from "@/lib/recurrence";
import { safeReturnTo } from "@/lib/return-to";
import { splitTagInput } from "@/lib/tags";
import { createCategory } from "@/server/categories";
import { createRecurringEntry, type RecurringView, type RepeatInput } from "@/server/recurring";
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
  note: z.string().max(500, "Keep the note to 500 characters or fewer.").optional(),
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

/**
 * After a save from the dialog or an in-place row: every signed-in page may show the change (balances, lists,
 * charts).
 */
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

async function parseTransaction(
  userId: number,
  formData: FormData,
  values: Record<string, string>,
): Promise<Parsed<TransactionInput>> {
  const parsed = transactionSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { ok: false, state: zodErrorState(parsed.error, values) };
  const d = parsed.data;
  // The currency comes from the wallet looked up server-side, never from the client.
  const wallet = await getWallet(userId, d.walletId);
  if (!wallet) return { ok: false, state: { fieldErrors: { walletId: "Wallet not found." }, values } };
  const amount = amountFor(d.amount, wallet.currency);
  if ("error" in amount) return { ok: false, state: { fieldErrors: { amount: amount.error }, values } };
  // Tags: one text field, names separated by commas (the form's base without JavaScript; scripts only help fill it).
  // A form without the field leaves an edited entry's tags as they are.
  const rawTags = formData.get("tags");
  if (typeof rawTags === "string" && rawTags.length > 1000) {
    return { ok: false, state: { fieldErrors: { tags: "That is too much text for tags." }, values } };
  }
  return {
    ok: true,
    input: {
      kind: d.kind,
      walletId: d.walletId,
      categoryId: d.categoryId,
      amountMinor: amount.minor,
      date: d.date,
      note: d.note ?? null,
      ...(typeof rawTags === "string" ? { tags: splitTagInput(rawTags) } : {}),
    },
  };
}

async function parseTransfer(
  userId: number,
  formData: FormData,
  values: Record<string, string>,
): Promise<Parsed<TransferInput>> {
  const parsed = transferSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { ok: false, state: zodErrorState(parsed.error, values) };
  const d = parsed.data;
  if (d.fromWalletId === d.toWalletId) {
    return { ok: false, state: { fieldErrors: { toWalletId: "Choose two different wallets." }, values } };
  }
  const from = await getWallet(userId, d.fromWalletId);
  const to = await getWallet(userId, d.toWalletId);
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

/**
 * The Add form's Repeat control: `frequency` ("never", absent or empty = no repeat; else daily / weekly / monthly /
 * yearly), `interval` (every N; empty = 1) and an optional `endDate`. Field errors land on those names.
 */
function parseRepeat(formData: FormData, values: Record<string, string>): Parsed<RepeatInput | null> {
  const frequency = formData.get("frequency");
  if (frequency === null || frequency === "" || frequency === "never") return { ok: true, input: null };
  if (!isFrequency(frequency)) {
    return { ok: false, state: { fieldErrors: { frequency: "Choose how often it repeats." }, values } };
  }
  const rawInterval = String(formData.get("interval") ?? "").trim();
  const interval = rawInterval === "" ? 1 : /^\d{1,3}$/.test(rawInterval) ? Number(rawInterval) : NaN;
  if (!(interval >= 1 && interval <= MAX_RECURRING_INTERVAL)) {
    return {
      ok: false,
      state: { fieldErrors: { interval: `Enter a whole number from 1 to ${MAX_RECURRING_INTERVAL}.` }, values },
    };
  }
  const endDate = String(formData.get("endDate") ?? "").trim();
  if (endDate !== "" && !isValidDate(endDate)) {
    return { ok: false, state: { fieldErrors: { endDate: "Enter a valid end date." }, values } };
  }
  return { ok: true, input: { frequency, interval, endDate: endDate || null } };
}

/** "Added €950.00 to Rent, repeating every month (and 2 earlier dates)". */
function repeatedMessage(created: TransactionView, rule: RecurringView, added: number): string {
  const amount = formatMoney(created.amountMinor, created.currency);
  const every = describeSchedule(rule).replace(/^Every/, "every");
  const more = added === 0 ? "" : ` (and ${added === 1 ? "1 later date" : `${added} later dates`} up to today)`;
  return `Added ${amount} to ${created.categoryName ?? created.walletName}, repeating ${every}${more}`;
}

export async function createTransactionAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  const values = formValues(formData);
  const parsed = await parseTransaction(user.id, formData, values);
  if (!parsed.ok) return parsed.state;
  const repeat = parseRepeat(formData, values);
  if (!repeat.ok) return repeat.state;
  let created: TransactionView;
  let repeated: { rule: RecurringView; added: number } | null = null;
  try {
    if (repeat.input) {
      const result = await createRecurringEntry(user.id, parsed.input, repeat.input, todayInZone(user.timeZone));
      created = result.transaction;
      repeated = result;
    } else {
      created = await createTransaction(user.id, parsed.input);
    }
  } catch (err) {
    return serviceErrorState(err, values);
  }
  if (isDialogMode(formData)) {
    if (repeated) return savedInDialog(repeatedMessage(created, repeated.rule, repeated.added));
    const amount = formatMoney(created.amountMinor, created.currency);
    return savedInDialog(`Added ${amount} to ${created.categoryName ?? created.walletName}`);
  }
  revalidateAll([parsed.input.walletId]);
  if (repeated) revalidatePath("/recurring");
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
  const parsed = await parseTransaction(user.id, formData, values);
  if (!parsed.ok) return parsed.state;
  const previous = await getTransaction(user.id, transactionId);
  try {
    await updateTransaction(user.id, transactionId, parsed.input);
  } catch (err) {
    return serviceErrorState(err, values);
  }
  revalidateAll([parsed.input.walletId, ...(previous ? [previous.walletId] : [])]);
  redirect(returnToOf(formData));
}

/**
 * The in-place editor of a /transactions row: same parsing and service as the edit page, but it returns
 * `{ ok: true, message }` (and revalidates every page) instead of redirecting; the row closes itself on `ok`.
 */
export async function updateTransactionInlineAction(
  transactionId: number,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireUser();
  transactionId = assertBoundId(transactionId);
  const values = formValues(formData);
  const parsed = await parseTransaction(user.id, formData, values);
  if (!parsed.ok) return parsed.state;
  let updated: TransactionView;
  try {
    updated = await updateTransaction(user.id, transactionId, parsed.input);
  } catch (err) {
    return serviceErrorState(err, values);
  }
  const amount = formatMoney(updated.amountMinor, updated.currency);
  return savedInDialog(`Saved ${amount} · ${updated.categoryName ?? updated.walletName}`);
}

/** Plain form action (`id`, `returnTo` fields). Already-deleted rows are treated as done. */
export async function deleteTransactionAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const transactionId = Number(formData.get("id"));
  const existing = Number.isSafeInteger(transactionId) && transactionId > 0 ? await getTransaction(user.id, transactionId) : null;
  if (existing) {
    try {
      await deleteTransaction(user.id, transactionId);
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
  const parsed = await parseTransfer(user.id, formData, values);
  if (!parsed.ok) return parsed.state;
  let created: TransferView;
  try {
    created = await createTransfer(user.id, parsed.input);
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
  const parsed = await parseTransfer(user.id, formData, values);
  if (!parsed.ok) return parsed.state;
  const previous = await getTransfer(user.id, transferId);
  try {
    await updateTransfer(user.id, transferId, parsed.input);
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

/** The in-place editor of a transfer row: as `updateTransferAction`, but returns `{ ok: true, message }`. */
export async function updateTransferInlineAction(
  transferId: number,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireUser();
  transferId = assertBoundId(transferId);
  const values = formValues(formData);
  const parsed = await parseTransfer(user.id, formData, values);
  if (!parsed.ok) return parsed.state;
  let updated: TransferView;
  try {
    updated = await updateTransfer(user.id, transferId, parsed.input);
  } catch (err) {
    return serviceErrorState(err, values);
  }
  const amount = formatMoney(updated.from.amountMinor, updated.from.currency);
  return savedInDialog(`Saved ${amount} from ${updated.from.walletName} to ${updated.to.walletName}`);
}

/** Plain form action (`id` = transfer id, `returnTo`). Removes the transfer and both legs. */
export async function deleteTransferAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const transferId = Number(formData.get("id"));
  const existing = Number.isSafeInteger(transferId) && transferId > 0 ? await getTransfer(user.id, transferId) : null;
  if (existing) {
    try {
      await deleteTransfer(user.id, transferId);
    } catch (err) {
      if (!isServiceError(err) || err.code !== "NOT_FOUND") throw err;
    }
    revalidateAll([existing.from.walletId, existing.to.walletId]);
  }
  redirect(returnToOf(formData));
}

// ---------------------------------------------------------------------------------------------
// Categories created from the entry form

/** The result of `createCategoryFromEntryAction`: on `ok`, the new category to add to the picker and select. */
export type NewCategoryState = FormState & { category?: { id: number; name: string; kind: "expense" | "income" } };

/**
 * The category picker's "+ New category" (`useActionState`, dispatched without a <form>: the entry form cannot hold
 * another). Fields `kind` ("expense" | "income") and `name`. Errors land on `name` (the service's field); a bad kind is
 * a form-level message. Category names show on every signed-in page, hence the layout revalidation.
 */
export async function createCategoryFromEntryAction(_prev: NewCategoryState, formData: FormData): Promise<NewCategoryState> {
  const user = await requireUser();
  const values = formValues(formData);
  const kind = formData.get("kind");
  if (kind !== "expense" && kind !== "income") return { message: "Choose expense or income.", values };
  let category: NewCategoryState["category"];
  try {
    const name = formData.get("name");
    category = await createCategory(user.id, { name: typeof name === "string" ? name : "", kind });
  } catch (err) {
    return serviceErrorState(err, values);
  }
  revalidatePath("/", "layout");
  return { ok: true, message: `Added “${category.name}”.`, category };
}
