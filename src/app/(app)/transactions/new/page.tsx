import type { Metadata } from "next";
import { PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { safeReturnTo } from "@/lib/return-to";
import { NewEntry, type SearchParams } from "./new-entry";

export const metadata: Metadata = { title: "Add transaction" };

/** The full page (direct visit, reload, no JS). A link from inside the app opens `@modal/(.)transactions/new`. */
export default async function NewTransactionPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const user = await requireUser();
  const sp = await searchParams;

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title="Add transaction" />
      <NewEntry userId={user.id} searchParams={sp} returnTo={safeReturnTo(sp.returnTo)} />
    </div>
  );
}
