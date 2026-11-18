"use server";

import { revalidatePath } from "next/cache";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { destroySession, requireUser } from "@/lib/auth";
import { shouldUseSecureCookie } from "@/lib/config";
import { GROUP_COOKIE, parseGroupCookie } from "@/lib/group-scope";
import { safeReturnTo } from "@/lib/return-to";
import { getWalletGroup } from "@/server/wallet-groups";

export async function signOutAction(): Promise<void> {
  await destroySession();
  redirect("/login");
}

const ONE_YEAR_S = 60 * 60 * 24 * 365;

/**
 * Select the wallet group the app looks at (`groupId` = one of the user's unarchived groups; empty or anything else,
 * an archived group included, = All), then go back to `returnTo`. The choice lives in the `et_group` cookie.
 */
export async function selectGroupAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const raw = formData.get("groupId");
  const id = parseGroupCookie(typeof raw === "string" ? raw : undefined);
  const found = id === null ? null : await getWalletGroup(user.id, id);
  const group = found && found.archivedAt === null ? found : null;

  const store = await cookies();
  if (group) {
    store.set(GROUP_COOKIE, String(group.id), {
      httpOnly: true,
      sameSite: "lax",
      secure: shouldUseSecureCookie((await headers()).get("x-forwarded-proto")),
      path: "/",
      maxAge: ONE_YEAR_S,
    });
  } else {
    store.delete(GROUP_COOKIE);
  }
  revalidatePath("/", "layout");
  redirect(safeReturnTo(formData.get("returnTo"), "/"));
}
