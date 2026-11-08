import { EntryForm, type EntryKind } from "@/components/transactions/entry-form";
import { Card, EmptyState, LinkButton } from "@/components/ui";
import { todayISO } from "@/lib/dates";
import { createTransactionAction, createTransferAction } from "../actions";
import { categoryOptions, param, parseId, walletOptions } from "../form-options";

const KINDS: EntryKind[] = ["expense", "income", "transfer"];

export type SearchParams = Record<string, string | string[] | undefined>;

/**
 * The body of "Add transaction": the entry form, or "create a wallet first". Shared by the full page
 * (`transactions/new/page.tsx`) and the dialog (`@modal/(.)transactions/new/page.tsx`); the caller checks the session
 * and supplies the heading.
 */
export function NewEntry({ userId, searchParams, returnTo }: { userId: number; searchParams: SearchParams; returnTo: string }) {
  const wallets = walletOptions(userId);

  if (wallets.length === 0) {
    return (
      <Card>
        <EmptyState
          title="Create a wallet first"
          description="Transactions belong to a wallet — cash, a bank account, a card. Add one to start tracking."
          action={<LinkButton href="/wallets/new">Create a wallet</LinkButton>}
        />
      </Card>
    );
  }

  const kindParam = param(searchParams.kind);
  const kind = KINDS.includes(kindParam as EntryKind) ? (kindParam as EntryKind) : "expense";
  const walletParam = parseId(searchParams.wallet);
  const walletId = wallets.some((w) => w.id === walletParam) ? walletParam! : undefined;

  return (
    <EntryForm
      wallets={wallets}
      categories={categoryOptions(userId)}
      initial={{ kind, walletId, fromWalletId: walletId, date: todayISO() }}
      transactionAction={createTransactionAction}
      transferAction={createTransferAction}
      returnTo={returnTo}
      canTransfer={wallets.length >= 2}
    />
  );
}
