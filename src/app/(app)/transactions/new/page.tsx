import type { Metadata } from "next";
import { EntryForm, type EntryKind } from "@/components/transactions/entry-form";
import { Card, EmptyState, LinkButton, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { todayISO } from "@/lib/dates";
import { safeReturnTo } from "@/lib/return-to";
import { createTransactionAction, createTransferAction } from "../actions";
import { categoryOptions, param, parseId, walletOptions } from "../form-options";

export const metadata: Metadata = { title: "Add transaction" };

const KINDS: EntryKind[] = ["expense", "income", "transfer"];

export default async function NewTransactionPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const sp = await searchParams;
  const returnTo = safeReturnTo(sp.returnTo);
  const wallets = walletOptions(user.id);

  if (wallets.length === 0) {
    return (
      <>
        <PageHeader title="Add transaction" />
        <Card>
          <EmptyState
            title="Create a wallet first"
            description="Transactions belong to a wallet — cash, a bank account, a card. Add one to start tracking."
            action={<LinkButton href="/wallets/new">Create a wallet</LinkButton>}
          />
        </Card>
      </>
    );
  }

  const kindParam = param(sp.kind);
  const kind = KINDS.includes(kindParam as EntryKind) ? (kindParam as EntryKind) : "expense";
  const walletParam = parseId(sp.wallet);
  const walletId = wallets.some((w) => w.id === walletParam) ? walletParam! : undefined;

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title="Add transaction" />
      <EntryForm
        wallets={wallets}
        categories={categoryOptions(user.id)}
        initial={{ kind, walletId, fromWalletId: walletId, date: todayISO() }}
        transactionAction={createTransactionAction}
        transferAction={createTransferAction}
        returnTo={returnTo}
        canTransfer={wallets.length >= 2}
      />
    </div>
  );
}
