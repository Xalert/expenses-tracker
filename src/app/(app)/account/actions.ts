"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { clearSessionCookie, currentSessionTokenHash, requireUser } from "@/lib/auth";
import { MIN_PASSWORD_LENGTH } from "@/lib/constants";
import { formValues, serviceErrorState, zodErrorState, type FormState } from "@/lib/form";
import { accountKey, passwordLimiters, tooManyAttemptsMessage } from "@/lib/rate-limit";
import {
  changePassword,
  deleteAccount,
  isWrongPasswordError,
  signOutOtherSessions,
  updateProfile,
} from "@/server/users";

const PASSWORD_FIELDS = ["currentPassword", "newPassword", "confirmPassword"];

/**
 * Run `check` (a service call that verifies the user's current password) under the per-account limit shared by the
 * password, profile and deletion forms: refused while the account is locked out, a wrong password counts as a
 * failure, a success clears the count. Other errors pass through untouched.
 */
async function withPasswordLimit<T>(
  userId: number,
  check: () => Promise<T>,
): Promise<{ locked: false; value: T } | { locked: true; message: string }> {
  const limiter = passwordLimiters().identifier;
  const key = accountKey(userId);
  const wait = limiter.retryAfterMs(key);
  if (wait > 0) return { locked: true, message: tooManyAttemptsMessage(wait, "password") };
  try {
    const value = await check();
    limiter.reset(key);
    return { locked: false, value };
  } catch (err) {
    if (isWrongPasswordError(err)) limiter.recordFailure(key);
    throw err;
  }
}

// Shape only; verifying the current password and the session cleanup live in changePassword.
const passwordSchema = z
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
  const values = formValues(formData, PASSWORD_FIELDS);
  const parsed = passwordSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return zodErrorState(parsed.error, values);

  try {
    const keepSessionTokenHash = await currentSessionTokenHash();
    const result = await withPasswordLimit(user.id, () =>
      changePassword(
        user.id,
        { currentPassword: parsed.data.currentPassword, newPassword: parsed.data.newPassword },
        { keepSessionTokenHash },
      ),
    );
    if (result.locked) return { message: result.message, values };
  } catch (err) {
    return serviceErrorState(err, values);
  }
  revalidatePath("/account");
  return { ok: true, message: "Password changed. Your other devices were signed out." };
}

// Shape only; the rules (formats, conflicts, when the password is needed) live in updateProfile.
const optional = z.string().optional().default("");
const profileSchema = z.object({
  username: z.string().trim().min(1, "Choose a user ID."),
  email: optional,
  firstName: optional,
  lastName: optional,
  // Not defaulted: a form without the field leaves the time zone as it is ("" clears it).
  timeZone: z.string().optional(),
  currentPassword: optional,
});

export async function updateProfileAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  const values = formValues(formData, ["currentPassword"]);
  const parsed = profileSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return zodErrorState(parsed.error, values);

  let saved: Awaited<ReturnType<typeof updateProfile>>;
  try {
    // The limit only applies when a password was given (a names-only change checks none).
    const result = parsed.data.currentPassword
      ? await withPasswordLimit(user.id, () => updateProfile(user.id, parsed.data))
      : { locked: false as const, value: await updateProfile(user.id, parsed.data) };
    if (result.locked) return { message: result.message, values };
    saved = result.value;
  } catch (err) {
    return serviceErrorState(err, values);
  }
  // The account menu on every page shows the names, user ID and email.
  revalidatePath("/", "layout");
  return {
    ok: true,
    message: "Profile saved.",
    values: {
      username: saved.username,
      email: saved.email ?? "",
      firstName: saved.firstName ?? "",
      lastName: saved.lastName ?? "",
      timeZone: saved.timeZone ?? "",
    },
  };
}

/** "Sign out other devices": deletes every session of the user except the current one. */
export async function signOutOtherDevicesAction(): Promise<FormState> {
  const user = await requireUser();
  const n = await signOutOtherSessions(user.id, await currentSessionTokenHash());
  revalidatePath("/account");
  return {
    ok: true,
    message: n === 0 ? "No other devices were signed in." : `Signed out ${n} other ${n === 1 ? "session" : "sessions"}.`,
  };
}

const deleteSchema = z.object({
  currentPassword: z.string().min(1, "Enter your current password."),
  confirmUsername: z.string().trim().min(1, "Type your user ID to confirm."),
});

/** Deletes the account and all its data, clears the cookie and goes to /login with a notice. */
export async function deleteAccountAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  const values = formValues(formData, ["currentPassword"]);
  const parsed = deleteSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return zodErrorState(parsed.error, values);

  try {
    const result = await withPasswordLimit(user.id, () => deleteAccount(user.id, parsed.data));
    if (result.locked) return { message: result.message, values };
  } catch (err) {
    return serviceErrorState(err, values);
  }
  await clearSessionCookie();
  redirect("/login?deleted=1");
}
