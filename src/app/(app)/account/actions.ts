"use server";

import { z } from "zod";
import { currentSessionTokenHash, requireUser } from "@/lib/auth";
import { MIN_PASSWORD_LENGTH } from "@/lib/constants";
import { formValues, serviceErrorState, zodErrorState, type FormState } from "@/lib/form";
import { changePassword } from "@/server/users";

// Shape only; verifying the current password and the session cleanup live in changePassword.
const schema = z
  .object({
    currentPassword: z.string(),
    newPassword: z.string().min(MIN_PASSWORD_LENGTH, `Use at least ${MIN_PASSWORD_LENGTH} characters.`),
    confirmPassword: z.string(),
  })
  .refine((d) => d.newPassword === d.confirmPassword, {
    path: ["confirmPassword"],
    message: "The passwords do not match.",
  });

export async function changePasswordAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  // Never echo a password back.
  const values = formValues(formData, ["currentPassword", "newPassword", "confirmPassword"]);
  const parsed = schema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return zodErrorState(parsed.error, values);

  try {
    await changePassword(
      user.id,
      { currentPassword: parsed.data.currentPassword, newPassword: parsed.data.newPassword },
      { keepSessionTokenHash: await currentSessionTokenHash() },
    );
  } catch (err) {
    return serviceErrorState(err, values);
  }
  return { ok: true, message: "Password changed. Your other devices were signed out." };
}
