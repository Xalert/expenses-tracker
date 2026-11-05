import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ConfirmDeleteForm } from "@/components/transactions/confirm-delete-form";
import { EntryForm } from "@/components/transactions/entry-form";
import { PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { minorToInputValue } from "@/lib/money";
import { safeReturnTo } from "@/lib/return-to";
import { getTransfer } from "@/server/transfers";
import { deleteTransferAction, updateTransferAction } from "../../../actions";
import { categoryOptions, parseId, walletOptions } from "../../../form-options";

export const metadata: Metadata = { title: "Edit transfer" };

export default async function EditTransferPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const returnTo = safeReturnTo(sp.returnTo);
  const transferId = parseId(id);
  const t = transferId ? getTransfer(user.id, transferId) : null;
  if (!t) notFound();

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title="Edit transfer"
        actions={
          <ConfirmDeleteForm
            action={deleteTransferAction}
            id={t.id}
            returnTo={returnTo}
            confirmMessage="Delete this transfer? Both sides of it will be removed. This cannot be undone."
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
        wallets={walletOptions(user.id, [t.from.walletId, t.to.walletId])}
        categories={categoryOptions(user.id)}
        initial={{
          kind: "transfer",
          fromWalletId: t.from.walletId,
          toWalletId: t.to.walletId,
          amount: minorToInputValue(t.from.amountMinor, t.from.currency),
          receivedAmount:
            t.from.currency !== t.to.currency ? minorToInputValue(t.to.amountMinor, t.to.currency) : undefined,
          date: t.date,
          note: t.note ?? "",
        }}
        transferAction={updateTransferAction.bind(null, t.id)}
        returnTo={returnTo}
        submitLabel="Save changes"
        canTransfer
      />
    </div>
  );
}
