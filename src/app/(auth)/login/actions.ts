"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { createSession } from "@/lib/auth";
import { formValues, zodErrorState, type FormState } from "@/lib/form";
import { authenticateUser } from "@/server/users";

const schema = z.object({
  identifier: z.string().trim().min(1, "Enter your user ID or email."),
  password: z.string().min(1, "Enter your password."),
});

export async function loginAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const values = formValues(formData, ["password"]);
  const parsed = schema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return zodErrorState(parsed.error, values);

  const user = await authenticateUser(parsed.data.identifier, parsed.data.password);
  if (!user) return { message: "Invalid user ID, email or password", values };

  await createSession(user.id);
  redirect("/");
}
