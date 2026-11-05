"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { createSession } from "@/lib/auth";
import { isRegistrationAllowed } from "@/lib/config";
import { formValues, serviceErrorState, zodErrorState, type FormState } from "@/lib/form";
import { MIN_PASSWORD_LENGTH } from "@/lib/constants";
import { registerUser } from "@/server/users";

const schema = z.object({
  name: z.string().trim().min(1, "Enter your name.").max(80, "Keep the name under 80 characters."),
  email: z.string().trim().pipe(z.email("Enter a valid email address.")),
  password: z.string().min(MIN_PASSWORD_LENGTH, `Use at least ${MIN_PASSWORD_LENGTH} characters.`),
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
