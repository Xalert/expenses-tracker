import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { ConfirmDeleteForm } from "@/components/transactions/confirm-delete-form";
import { EntryForm } from "@/components/transactions/entry-form";
import { PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { todayISO } from "@/lib/dates";
import { minorToInputValue } from "@/lib/money";
import { safeReturnTo, withReturnTo } from "@/lib/return-to";
import { getTransaction } from "@/server/transactions";
import { deleteTransactionAction, updateTransactionAction } from "../../actions";
import { categoryOptions, parseId, walletOptions } from "../../form-options";

export const metadata: Metadata = { title: "Edit transaction" };

export default async function EditTransactionPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const returnTo = safeReturnTo(sp.returnTo);
  const transactionId = parseId(id);
  const t = transactionId ? getTransaction(user.id, transactionId) : null;
  if (!t) notFound();
  if (t.transferId !== null) redirect(withReturnTo(`/transactions/transfers/${t.transferId}/edit`, returnTo));
  if (t.kind !== "expense" && t.kind !== "income") notFound();

  const noun = t.kind === "expense" ? "expense" : "income";
  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title={`Edit ${noun}`}
        actions={
          <ConfirmDeleteForm
            action={deleteTransactionAction}
            id={t.id}
            returnTo={returnTo}
            confirmMessage={`Delete this ${noun}? This cannot be undone.`}
            variant="secondary"
            size="sm"
            className="text-danger!"
            pendingLabel="Deleting…"
          >
            Delete
          </ConfirmDeleteForm>
        }
      />
      <EntryForm
        wallets={walletOptions(user.id, [t.walletId])}
        categories={categoryOptions(user.id)}
        initial={{
          kind: t.kind,
          walletId: t.walletId,
          categoryId: t.categoryId ?? undefined,
          amount: minorToInputValue(t.amountMinor, t.currency),
          date: t.date,
          note: t.note ?? "",
        }}
        today={todayISO()}
        transactionAction={updateTransactionAction.bind(null, t.id)}
        returnTo={returnTo}
        submitLabel="Save changes"
        canTransfer={false}
      />
    </div>
  );
}
