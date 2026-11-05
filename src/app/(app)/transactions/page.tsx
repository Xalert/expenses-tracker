import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { DownloadIcon, PlusIcon } from "@/components/shell/icons";
import { ConfirmDeleteForm } from "@/components/transactions/confirm-delete-form";
import { PencilIcon, TrashIcon } from "@/components/transactions/icons";
import { exportCsvHref, hasFilters, listHref, PAGE_SIZE, parseListParams } from "@/components/transactions/list-params";
import { TransactionFilters } from "@/components/transactions/transaction-filters";
import { TransactionList, transactionLabel } from "@/components/transaction-list";
import { Card, EmptyState, LinkButton, PageHeader, buttonClasses } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { withReturnTo } from "@/lib/return-to";
import { listCategories } from "@/server/categories";
import { listTransactions, type TransactionView } from "@/server/transactions";
import { listWallets } from "@/server/wallets";
import { deleteTransactionAction, deleteTransferAction } from "./actions";

export const metadata: Metadata = { title: "Transactions" };

export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const params = parseListParams(await searchParams);
  const filtered = hasFilters(params);

  const { items, total } = listTransactions(user.id, {
    walletId: params.wallet,
    kind: params.kind,
    categoryId: params.category,
    from: params.from,
    to: params.to,
    q: params.q,
    limit: PAGE_SIZE,
    offset: (params.page - 1) * PAGE_SIZE,
  });

  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // Past the end (e.g. after deleting the last row of the last page): go to the last real page.
  if (params.page > lastPage) redirect(listHref(params, { page: lastPage }));

  const currentHref = listHref(params);
  const wallets = listWallets(user.id, { includeArchived: true });
  const categories = listCategories(user.id);
  const anyAtAll = filtered && total === 0 ? listTransactions(user.id, { limit: 1 }).total > 0 : total > 0;

  const renderActions = (t: TransactionView) => {
    const label = transactionLabel(t);
    const editHref =
      t.transferId !== null ? `/transactions/transfers/${t.transferId}/edit` : `/transactions/${t.id}/edit`;
    const iconButton = buttonClasses({ variant: "ghost", size: "sm", className: "size-8 shrink-0 px-0!" });
    return (
      <>
        <Link href={withReturnTo(editHref, currentHref)} className={iconButton} aria-label={`Edit ${label}`} title="Edit">
          <PencilIcon className="size-4" />
        </Link>
        {t.transferId !== null ? (
          <ConfirmDeleteForm
            action={deleteTransferAction}
            id={t.transferId}
            returnTo={currentHref}
            confirmMessage="Delete this transfer? Both sides of it will be removed. This cannot be undone."
            variant="ghost"
            size="sm"
            className="size-8 shrink-0 px-0! hover:text-danger!"
            aria-label={`Delete ${label}`}
            title="Delete transfer"
          >
            <TrashIcon className="size-4" />
          </ConfirmDeleteForm>
        ) : (
          <ConfirmDeleteForm
            action={deleteTransactionAction}
            id={t.id}
            returnTo={currentHref}
            confirmMessage={`Delete this ${t.kind}? This cannot be undone.`}
            variant="ghost"
            size="sm"
            className="size-8 shrink-0 px-0! hover:text-danger!"
            aria-label={`Delete ${label}`}
            title="Delete"
          >
            <TrashIcon className="size-4" />
          </ConfirmDeleteForm>
        )}
      </>
    );
  };

  const first = total === 0 ? 0 : (params.page - 1) * PAGE_SIZE + 1;
  const last = Math.min(params.page * PAGE_SIZE, total);

  return (
    <>
      <PageHeader
        title="Transactions"
        description={
          total > 0
            ? `${total} ${total === 1 ? "transaction" : "transactions"}${filtered ? (total === 1 ? " matches your filters" : " match your filters") : ""}`
            : undefined
        }
        actions={
          <>
            {total > 0 && (
              // A plain <a>: the route handler answers with a file download (all matching rows, current filters).
              <a
                href={exportCsvHref(params)}
                download
                className={buttonClasses({ variant: "secondary" })}
                title={filtered ? "Export the transactions matching these filters as CSV" : "Export all transactions as CSV"}
              >
                <DownloadIcon className="size-4" />
                Export CSV
              </a>
            )}
            <LinkButton href={withReturnTo("/transactions/new", currentHref)}>
              <PlusIcon className="size-4" />
              Add
            </LinkButton>
          </>
        }
      />

      {(anyAtAll || filtered) && (
        <TransactionFilters
          params={params}
          wallets={wallets.map((w) => ({ id: w.id, name: w.name, currency: w.currency, archived: w.archivedAt !== null }))}
          categories={categories}
          queryKey={currentHref}
        />
      )}

      <Card>
        {total === 0 ? (
          anyAtAll ? (
            <EmptyState
              title="No matching transactions"
              description="Nothing matches these filters. Try widening the date range or clearing a filter."
              action={
                <LinkButton href="/transactions" variant="secondary">
                  Clear filters
                </LinkButton>
              }
            />
          ) : wallets.length === 0 ? (
            <EmptyState
              title="No transactions yet"
              description="Create a wallet first, then start logging your expenses and income."
              action={<LinkButton href="/wallets/new">Create a wallet</LinkButton>}
            />
          ) : (
            <EmptyState
              title="No transactions yet"
              description="Log an expense, an income or a transfer between your wallets."
              action={<LinkButton href="/transactions/new">Add a transaction</LinkButton>}
            />
          )
        ) : (
          <TransactionList items={items} renderActions={renderActions} />
        )}
      </Card>

      {total > 0 && (
        <nav
          aria-label="Pagination"
          className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground"
        >
          <p className="tabular-nums">
            Showing {first}–{last} of {total}
          </p>
          {lastPage > 1 && (
            <div className="flex items-center gap-2">
              <PageLink href={params.page > 1 ? listHref(params, { page: params.page - 1 }) : null} rel="prev">
                Previous
              </PageLink>
              <span className="tabular-nums">
                Page {params.page} of {lastPage}
              </span>
              <PageLink href={params.page < lastPage ? listHref(params, { page: params.page + 1 }) : null} rel="next">
                Next
              </PageLink>
            </div>
          )}
        </nav>
      )}
    </>
  );
}

function PageLink({ href, rel, children }: { href: string | null; rel: "prev" | "next"; children: React.ReactNode }) {
  const cls = buttonClasses({ variant: "secondary", size: "sm" });
  if (!href) {
    return (
      <span className={`${cls} pointer-events-none opacity-50`} aria-disabled="true">
        {children}
      </span>
    );
  }
  return (
    <Link href={href} rel={rel} className={cls}>
      {children}
    </Link>
  );
}
