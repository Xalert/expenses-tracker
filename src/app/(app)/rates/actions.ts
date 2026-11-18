"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { formatDate } from "@/lib/dates";
import { formValues, serviceErrorState, zodErrorState, type FormState } from "@/lib/form";
import { deleteManualRate, setManualRate } from "@/server/manual-rates";

// Shape only; the rules (held currency, base, positive decimal, date) live in setManualRate.
const setSchema = z.object({
  currency: z.string(),
  base: z.string(),
  effectiveDate: z.string().min(1, "Choose the date the rate applies from."),
  rate: z.string().trim().min(1, "Enter the rate."),
});

export async function setManualRateAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  const values = formValues(formData);
  const parsed = setSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return zodErrorState(parsed.error, values);
  let message: string;
  try {
    const saved = await setManualRate(user.id, parsed.data);
    message = `Saved: from ${formatDate(saved.effectiveDate)}, 1 ${saved.currency} = ${saved.rate} ${saved.base}.`;
  } catch (err) {
    return serviceErrorState(err, values);
  }
  // Every converted view (Overview, Transactions, Categories) may use it.
  revalidatePath("/", "layout");
  return { ok: true, message };
}

const deleteSchema = z.object({ id: z.coerce.number().int().positive() });

export async function deleteManualRateAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  const parsed = deleteSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { message: "Rate not found." };
  try {
    await deleteManualRate(user.id, parsed.data.id);
  } catch (err) {
    return serviceErrorState(err);
  }
  revalidatePath("/", "layout");
  return { ok: true, message: "Rate removed." };
}
