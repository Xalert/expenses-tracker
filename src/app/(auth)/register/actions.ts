"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { createSession } from "@/lib/auth";
import { isRegistrationAllowed } from "@/lib/config";
import { formValues, serviceErrorState, zodErrorState, type FormState } from "@/lib/form";
import { MIN_PASSWORD_LENGTH } from "@/lib/constants";
import { registerUser } from "@/server/users";

// Shape only; the rules (user ID format, email, name lengths, conflicts) live in registerUser.
const optional = z.string().optional().default("");
const schema = z.object({
  username: z.string().trim().min(1, "Choose a user ID."),
  password: z.string().min(MIN_PASSWORD_LENGTH, `Use at least ${MIN_PASSWORD_LENGTH} characters.`),
  email: optional,
  firstName: optional,
  lastName: optional,
});

export async function registerAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const values = formValues(formData, ["password"]);
  if (!isRegistrationAllowed()) return { message: "Registration is disabled on this server.", values };
  const parsed = schema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return zodErrorState(parsed.error, values);

  let userId: number;
  try {
    userId = (await registerUser(parsed.data)).id;
  } catch (err) {
    return serviceErrorState(err, values);
  }

  await createSession(userId);
  redirect("/");
}
