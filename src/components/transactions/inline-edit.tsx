"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import {
  deleteTransactionAction,
  deleteTransferAction,
  updateTransactionInlineAction,
  updateTransferInlineAction,
} from "@/app/(app)/transactions/actions";
import { useExpandableRow } from "@/components/ui/expandable-row";
import { withReturnTo } from "@/lib/return-to";
import { ConfirmDeleteForm } from "./confirm-delete-form";
import { EntryForm, type CategoryOption, type WalletOption } from "./entry-form";

/** What a row's editor starts from; built on the server from the row's `TransactionView` (`inlineEntryOf`). */
export type InlineEntry =
  | {
      type: "transaction";
      id: number;
      kind: "expense" | "income";
      walletId: number;
      categoryId?: number;
      amount: string;
      date: string;
      note: string;
    }
  | {
      type: "transfer";
      transferId: number;
      fromWalletId: number;
      toWalletId: number;
      amount: string;
      receivedAmount?: string;
      date: string;
      note: string;
    };

type InlineEditContext = {
  /** Every wallet of the user, archived ones flagged (each editor keeps the active ones plus those it uses). */
  wallets: WalletOption[];
  categories: CategoryOption[];
  today: string;
  /** The list URL: where Delete returns to and the "Open as page" link's `returnTo`. */
  returnTo: string;
};

const Context = createContext<InlineEditContext | null>(null);

/** Hands the wallets, categories and today to every row editor once, instead of once per row. */
export function InlineEditProvider({ children, ...value }: InlineEditContext & { children: ReactNode }) {
  const memo = useMemo(
    () => ({ wallets: value.wallets, categories: value.categories, today: value.today, returnTo: value.returnTo }),
    [value.wallets, value.categories, value.today, value.returnTo],
  );
  return <Context.Provider value={memo}>{children}</Context.Provider>;
}

/**
 * The open row's editor: `EntryForm variant="inline"` bound to the inline update action, with Delete (confirms; the
 * delete action redirects back to the list) and a plain "Open as page" link to the edit page in its footer.
 */
export function InlineEditPanel({ entry, rowKey }: { entry: InlineEntry; rowKey: string }) {
  const ctx = useContext(Context);
  if (!ctx) throw new Error("InlineEditPanel must be inside an InlineEditProvider.");
  const row = useExpandableRow();
  const router = useRouter();
  const isTransfer = entry.type === "transfer";
  const boundId = isTransfer ? entry.transferId : entry.id;

  const action = useMemo(
    () =>
      isTransfer
        ? updateTransferInlineAction.bind(null, boundId)
        : updateTransactionInlineAction.bind(null, boundId),
    [isTransfer, boundId],
  );

  const used = isTransfer ? [entry.fromWalletId, entry.toWalletId] : [entry.walletId];
  const wallets = ctx.wallets.filter((w) => !w.archived || used.includes(w.id));
  const editHref = isTransfer ? `/transactions/transfers/${boundId}/edit` : `/transactions/${boundId}/edit`;
  const noun = isTransfer ? "transfer" : entry.kind;

  return (
    <div className="px-4 pt-1 pb-4 sm:px-[18px]">
      <EntryForm
        variant="inline"
        idPrefix={`edit-${rowKey}-`}
        wallets={wallets}
        categories={ctx.categories}
        initial={
          isTransfer
            ? {
                kind: "transfer",
                fromWalletId: entry.fromWalletId,
                toWalletId: entry.toWalletId,
                amount: entry.amount,
                receivedAmount: entry.receivedAmount,
                date: entry.date,
                note: entry.note,
              }
            : {
                kind: entry.kind,
                walletId: entry.walletId,
                categoryId: entry.categoryId,
                amount: entry.amount,
                date: entry.date,
                note: entry.note,
              }
        }
        today={ctx.today}
        transactionAction={isTransfer ? undefined : action}
        transferAction={isTransfer ? action : undefined}
        returnTo={ctx.returnTo}
        submitLabel="Save"
        canTransfer
        onCancel={() => row.close()}
        onSaved={(message) => {
          row.saved(message);
          router.refresh();
        }}
        footerStart={
          <>
            <ConfirmDeleteForm
              action={isTransfer ? deleteTransferAction : deleteTransactionAction}
              id={boundId}
              returnTo={ctx.returnTo}
              confirmMessage={
                isTransfer
                  ? "Delete this transfer? Both sides of it will be removed. This cannot be undone."
                  : `Delete this ${noun}? This cannot be undone.`
              }
              variant="ghost"
              className="-ml-3 text-danger! hover:bg-danger-soft!"
              pendingLabel="Deleting…"
            >
              Delete
            </ConfirmDeleteForm>
            <Link
              href={withReturnTo(editHref, ctx.returnTo)}
              className="text-sm font-medium text-muted-foreground hover:text-foreground hover:underline"
            >
              Open as page
            </Link>
          </>
        }
      />
    </div>
  );
}
