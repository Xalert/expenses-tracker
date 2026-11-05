"use server";

import { redirect } from "next/navigation";
import { destroySession } from "@/lib/auth";

export async function signOutAction(): Promise<void> {
  await destroySession();
  redirect("/login");
}
