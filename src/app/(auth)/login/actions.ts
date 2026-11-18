"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createSession } from "@/lib/auth";
import { trustProxy } from "@/lib/config";
import { formValues, zodErrorState, type FormState } from "@/lib/form";
import { clientAddress, identifierKey, passwordLimiters, tooManyAttemptsMessage } from "@/lib/rate-limit";
import { adoptTimeZoneIfUnset, authenticateUser, deleteExpiredSessions } from "@/server/users";

const schema = z.object({
  identifier: z.string().trim().min(1, "Enter your user ID or email."),
  password: z.string().min(1, "Enter your password."),
});

export async function loginAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const values = formValues(formData, ["password"]);
  const parsed = schema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return zodErrorState(parsed.error, values);

  // Refused before the password is checked, with the same message whether or not the account exists.
  const limits = passwordLimiters();
  const idKey = identifierKey(parsed.data.identifier);
  const address = clientAddress((await headers()).get("x-forwarded-for"), trustProxy());
  const addrKey = address === null ? null : `ip:${address}`;
  const wait = Math.max(limits.identifier.retryAfterMs(idKey), addrKey ? limits.address.retryAfterMs(addrKey) : 0);
  if (wait > 0) return { message: tooManyAttemptsMessage(wait), values };

  const user = await authenticateUser(parsed.data.identifier, parsed.data.password);
  if (!user) {
    limits.identifier.recordFailure(idKey);
    if (addrKey) limits.address.recordFailure(addrKey);
    return { message: "Invalid user ID, email or password", values };
  }

  limits.identifier.reset(idKey);
  // The browser's zone (hidden field) becomes the account's only when it has none yet; invalid values are ignored.
  await adoptTimeZoneIfUnset(user.id, formData.get("timeZone"));
  await deleteExpiredSessions(); // every account's; createSession then only adds one
  await createSession(user.id);
  redirect("/");
}
