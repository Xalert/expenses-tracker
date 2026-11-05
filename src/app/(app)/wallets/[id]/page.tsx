import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { TransactionList, transactionLabel } from "@/components/transaction-list";
import { Amount, Badge, Card, CardHeader, LinkButton } from "@/components/ui";
import { ActionButton } from "@/components/wallets/action-button";
import { getCurrentUser, requireUser } from "@/lib/auth";
import { currencyName } from "@/lib/currencies";
import { formatDate } from "@/lib/dates";
import { formatMoney } from "@/lib/money";
import { listTransactions, type TransactionView } from "@/server/transactions";
import { getWallet } from "@/server/wallets";
import { archiveWalletAction, deleteWalletAction, unarchiveWalletAction } from "../actions";
import { parseWalletId } from "../form-input";

const RECENT_LIMIT = 25;

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const user = await getCurrentUser();
  const walletId = parseWalletId((await params).id);
  const wallet = user && walletId ? getWallet(user.id, walletId) : null;
  return { title: wallet?.name ?? "Wallet" };
}

function editHref(t: TransactionView, returnTo: string): string {
  const rt = `returnTo=${encodeURIComponent(returnTo)}`;
  return t.transferId !== null
    ? `/transactions/transfers/${t.transferId}/edit?${rt}`
    : `/transactions/${t.id}/edit?${rt}`;
}

export default async function WalletPage({ params }: Props) {
  const user = await requireUser();
  const walletId = parseWalletId((await params).id);
  const wallet = walletId ? getWallet(user.id, walletId) : null;
  if (!wallet) notFound();

  const archived = wallet.archivedAt !== null;
  const self = `/wallets/${wallet.id}`;
  const { items, total } = listTransactions(user.id, { walletId: wallet.id, limit: RECENT_LIMIT });
  const newHref = (kind: "expense" | "income" | "transfer") =>
    `/transactions/new?wallet=${wallet.id}&kind=${kind}&returnTo=${encodeURIComponent(self)}`;

  return (
    <>
      <nav aria-label="Breadcrumb" className="mb-3 text-sm">
        <Link href="/wallets" className="text-muted-foreground hover:text-foreground">
          ← Wallets
        </Link>
      </nav>

      <div className="mb-6 rounded-xl border border-border bg-surface p-4 shadow-xs sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-2xl font-semibold tracking-tight text-foreground">{wallet.name}</h1>
              {archived && <Badge>Archived</Badge>}
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {wallet.currency} · {currencyName(wallet.currency)}
            </p>
          </div>
          <div className="text-left sm:text-right">
            <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Balance</p>
            <p className="text-3xl font-semibold tracking-tight text-foreground">
              <Amount minor={wallet.balanceMinor} currency={wallet.currency} colorNegative />
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Initial {formatMoney(wallet.initialBalanceMinor, wallet.currency)}
            </p>
          </div>
        </div>

        {archived ? (
          <p className="mt-4 rounded-lg bg-surface-muted px-3 py-2 text-sm text-muted-foreground">
            This wallet is archived: it&apos;s hidden from the dashboard and can&apos;t receive new transactions.
            Unarchive it to use it again.
          </p>
        ) : (
          <div className="mt-4 grid grid-cols-3 gap-2 sm:flex sm:flex-wrap">
            <LinkButton href={newHref("expense")} size="sm" variant="secondary">
              <span className="size-2 rounded-full bg-expense" aria-hidden="true" />
              Expense
            </LinkButton>
            <LinkButton href={newHref("income")} size="sm" variant="secondary">
              <span className="size-2 rounded-full bg-income" aria-hidden="true" />
              Income
            </LinkButton>
            <LinkButton href={newHref("transfer")} size="sm" variant="secondary">
              <span className="size-2 rounded-full bg-transfer" aria-hidden="true" />
              Transfer
            </LinkButton>
          </div>
        )}

        <div className="mt-4 flex flex-wrap items-start gap-2 border-t border-border pt-4">
          <LinkButton href={`${self}/edit`} size="sm" variant="ghost">
            Edit
          </LinkButton>
          {archived ? (
            <ActionButton action={unarchiveWalletAction.bind(null, wallet.id)} label="Unarchive" pendingLabel="Unarchiving…" variant="ghost" />
          ) : (
            <ActionButton
              action={archiveWalletAction.bind(null, wallet.id)}
              label="Archive"
              pendingLabel="Archiving…"
              variant="ghost"
              confirmMessage={`Archive “${wallet.name}”? It will be hidden from the dashboard and pickers; its history stays.`}
            />
          )}
          {wallet.transactionCount === 0 && (
            <ActionButton
              action={deleteWalletAction.bind(null, wallet.id)}
              label="Delete"
              pendingLabel="Deleting…"
              variant="ghost"
              className="[&_button]:text-danger"
              confirmMessage={`Delete “${wallet.name}”? This can't be undone.`}
            />
          )}
        </div>
      </div>

      <Card>
        <CardHeader
          title="Recent transactions"
          description={
            total === 0
              ? undefined
              : total > RECENT_LIMIT
                ? `Latest ${RECENT_LIMIT} of ${total}`
                : `${total} ${total === 1 ? "transaction" : "transactions"}`
          }
          actions={
            total > RECENT_LIMIT ? (
              <LinkButton href={`/transactions?wallet=${wallet.id}`} size="sm" variant="ghost">
                View all
              </LinkButton>
            ) : undefined
          }
        />
        <TransactionList
          items={items}
          showWallet={false}
          emptyMessage={archived ? "No transactions." : "No transactions yet. Add an expense or income above."}
          renderActions={(t) => (
            <Link
              href={editHref(t, self)}
              className="rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-surface-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
              aria-label={`Edit ${transactionLabel(t)}, ${formatDate(t.date)}`}
            >
              Edit
            </Link>
          )}
        />
        {total > RECENT_LIMIT && (
          <div className="border-t border-border px-4 py-3 text-center sm:px-5">
            <Link href={`/transactions?wallet=${wallet.id}`} className="text-sm font-medium text-accent hover:underline">
              View all {total} transactions
            </Link>
          </div>
        )}
      </Card>
    </>
  );
}
