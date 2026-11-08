import { NewEntry, type SearchParams } from "@/app/(app)/transactions/new/new-entry";
import { Dialog } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { DEFAULT_RETURN_TO } from "@/lib/return-to";

/**
 * `/transactions/new` opened from inside the app: the same form as the full page, in a dialog over the page it was
 * opened from. A save closes the dialog (or clears the form for another entry) instead of redirecting, so
 * `?returnTo=` is ignored here (the full page honours it).
 */
export default async function NewTransactionDialog({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const user = await requireUser();
  return (
    <Dialog title="Add transaction" className="sm:max-w-2xl">
      <NewEntry userId={user.id} searchParams={await searchParams} returnTo={DEFAULT_RETURN_TO} variant="dialog" />
    </Dialog>
  );
}
