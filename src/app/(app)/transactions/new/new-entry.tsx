import { EntryForm, type EntryKind } from "@/components/transactions/entry-form";
import { Card, EmptyState, LinkButton } from "@/components/ui";
import type { CurrentUser } from "@/lib/auth";
import { todayInZone } from "@/lib/dates";
import { getGroupScope } from "@/lib/group-scope";
import { listWallets } from "@/server/wallets";
import { createTransactionAction, createTransferAction } from "../actions";
import { categoryOptions, param, parseId, walletOptions } from "../form-options";

const KINDS: EntryKind[] = ["expense", "income", "transfer"];

export type SearchParams = Record<string, string | string[] | undefined>;

/**
 * The body of "Add transaction": the entry form, or "create a wallet first". Shared by the full page
 * (`transactions/new/page.tsx`) and the dialog (`@modal/(.)transactions/new/page.tsx`); the caller checks the session
 * and supplies the heading.
 */
export async function NewEntry({
  user,
  searchParams,
  returnTo,
  variant = "page",
}: {
  user: Pick<CurrentUser, "id" | "timeZone">;
  searchParams: SearchParams;
  returnTo: string;
  /** "dialog" from the intercepted route: no card, and a save closes the dialog instead of redirecting. */
  variant?: "page" | "dialog";
}) {
  const userId = user.id;
  const wallets = await walletOptions(userId);

  if (wallets.length === 0) {
    const empty = (
      <EmptyState
        title="Create a wallet first"
        description="Transactions belong to a wallet — cash, a bank account, a card. Add one to start tracking."
        action={<LinkButton href="/wallets/new">Create a wallet</LinkButton>}
      />
    );
    return variant === "dialog" ? empty : <Card>{empty}</Card>;
  }

  const kindParam = param(searchParams.kind);
  const kind = KINDS.includes(kindParam as EntryKind) ? (kindParam as EntryKind) : "expense";
  const walletParam = parseId(searchParams.wallet);
  // A `wallet` param wins; else the first active wallet of the selected group, if it has one.
  const { selected } = await getGroupScope();
  const groupFirst = selected ? (await listWallets(userId, { groupId: selected.id }))[0]?.id : undefined;
  const walletId = wallets.some((w) => w.id === walletParam) ? walletParam! : groupFirst;

  const today = todayInZone(user.timeZone);
  return (
    <EntryForm
      variant={variant}
      wallets={wallets}
      categories={await categoryOptions(userId)}
      initial={{ kind, walletId, fromWalletId: walletId, date: today }}
      today={today}
      transactionAction={createTransactionAction}
      transferAction={createTransferAction}
      returnTo={returnTo}
      canTransfer={wallets.length >= 2}
      // Dialog and full page share the draft "Manage categories" keeps.
      draftKey="new"
    />
  );
}
